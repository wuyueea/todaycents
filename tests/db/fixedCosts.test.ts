import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import type { Db } from '../../src/db/driver';
import { createAccount } from '../../src/db/repos/accounts';
import { archiveCategory, createCategory, deleteCategory } from '../../src/db/repos/categories';
import {
  createExpense,
  createIncome,
  recordAdjustment,
  softDeleteTxn,
} from '../../src/db/repos/txns';
import {
  confirmCandidate,
  countExpenseMonths,
  detectCandidates,
  dismissCandidate,
  listCandidates,
  listFixedCosts,
  monthlyTotalCents,
  setTxnFixedCost,
  unmarkFixed,
} from '../../src/db/repos/fixedCosts';

async function fixture() {
  const db = await createTestDb();
  const card = await createAccount(db, { name: '饭卡', type: 'prepaid', initialBalanceCents: 0 });
  const phone = await createCategory(db, { name: '通讯', kind: 'expense' });
  const subs = await createCategory(db, { name: '订阅', kind: 'expense' });
  return { db, card, phone, subs };
}

/**
 * One live expense plus its payee. createExpense takes no payee yet — the
 * column is written by an import or, later, the edit screen — so the fixture
 * sets it the same way those paths do: a plain UPDATE.
 */
async function bill(
  db: Db,
  input: {
    date: string;
    cents: number;
    categoryId: string | null;
    accountId: string;
    payee?: string | null;
  }
): Promise<string> {
  const id = await createExpense(db, {
    date: input.date,
    accountId: input.accountId,
    amountCents: input.cents,
    categoryId: input.categoryId,
  });
  if (input.payee !== undefined) {
    await db.run('UPDATE txn SET payee = ? WHERE id = ?', [input.payee, id]);
  }
  return id;
}

const MONTHS_STARTING_JAN = [
  '2026-01-01',
  '2026-02-01',
  '2026-03-01',
  '2026-04-01',
  '2026-05-01',
];

/** The five-month phone bill: the plan's acceptance example number one. */
async function phoneRun(db: Db, accountId: string, categoryId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const date of MONTHS_STARTING_JAN) {
    ids.push(
      await bill(db, { date, cents: 5988, categoryId, accountId, payee: '话费' })
    );
  }
  return ids;
}

async function hintRows(db: Db) {
  return db.all<{
    id: string;
    category_id: string | null;
    payee: string | null;
    status: string;
    monthly_cents: number;
    last_date: string;
    next_date: string;
    occurrences: number;
    detected_at: string;
  }>('SELECT * FROM recurring_hint ORDER BY id');
}

async function flagCount(db: Db): Promise<number> {
  const row = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM txn WHERE is_fixed_cost = 1');
  return row?.n ?? 0;
}

describe('detectCandidates', () => {
  it('finds the five-month phone bill and persists one candidate', async () => {
    const { db, card, phone } = await fixture();
    await phoneRun(db, card, phone);

    const candidates = await detectCandidates(db, { now: '2026-10-24T00:00:00.000Z' });

    expect(candidates).toEqual([
      {
        id: expect.any(String),
        name: '话费',
        categoryId: phone,
        payee: '话费',
        monthlyCents: 5988,
        lastDate: '2026-05-01',
        nextDate: '2026-06-01',
        occurrences: 5,
        detectedAt: '2026-10-24T00:00:00.000Z',
      },
    ]);
    expect(await hintRows(db)).toEqual([
      {
        id: candidates[0].id,
        category_id: phone,
        payee: '话费',
        status: 'candidate',
        monthly_cents: 5988,
        last_date: '2026-05-01',
        next_date: '2026-06-01',
        occurrences: 5,
        detected_at: '2026-10-24T00:00:00.000Z',
      },
    ]);
  });

  // The iron rule: detection writes hints, never the ledger.
  it('never creates a transaction, never flags one and never moves a category', async () => {
    const { db, card, phone } = await fixture();
    const ids = await phoneRun(db, card, phone);

    await detectCandidates(db);

    const txns = await db.all<{
      id: string;
      is_fixed_cost: number;
      category_id: string | null;
      amount_cents: number;
    }>('SELECT id, is_fixed_cost, category_id, amount_cents FROM txn ORDER BY id');
    expect(txns).toHaveLength(5);
    expect(txns.map(row => row.id).sort()).toEqual([...ids].sort());
    expect(txns.every(row => row.is_fixed_cost === 0)).toBe(true);
    expect(txns.every(row => row.category_id === phone)).toBe(true);
    expect(txns.every(row => row.amount_cents === -5988)).toBe(true);
  });

  it('names a candidate by its category when the bills carry no payee', async () => {
    const { db, card, phone } = await fixture();
    for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      await bill(db, { date, cents: 3000, categoryId: phone, accountId: card, payee: null });
    }

    const candidates = await detectCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ name: '通讯', payee: null, occurrences: 3 });
  });

  it('stores the trimmed payee so one spelling makes one identity', async () => {
    const { db, card, phone } = await fixture();
    await bill(db, { date: '2026-01-01', cents: 5988, categoryId: phone, accountId: card, payee: '话费' });
    await bill(db, { date: '2026-02-01', cents: 5988, categoryId: phone, accountId: card, payee: ' 话费 ' });
    await bill(db, { date: '2026-03-01', cents: 5988, categoryId: phone, accountId: card, payee: '话费' });

    const candidates = await detectCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ name: '话费', payee: '话费', occurrences: 3 });
  });

  describe('near-misses produce nothing at all', () => {
    it('rejects a month that jumps 30%', async () => {
      const { db, card, phone } = await fixture();
      for (const date of ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']) {
        await bill(db, { date, cents: 5900, categoryId: phone, accountId: card, payee: '话费' });
      }
      await bill(db, { date: '2026-05-01', cents: 7670, categoryId: phone, accountId: card, payee: '话费' });

      expect(await detectCandidates(db)).toEqual([]);
      expect(await hintRows(db)).toEqual([]);
    });

    it('rejects a 36-day gap and accepts a 35-day one', async () => {
      const { db, card, phone } = await fixture();
      for (const date of ['2026-01-01', '2026-01-26', '2026-03-03']) {
        await bill(db, { date, cents: 5988, categoryId: phone, accountId: card, payee: '话费' });
      }
      expect(await detectCandidates(db)).toEqual([]);

      await db.run('DELETE FROM txn');
      for (const date of ['2026-01-01', '2026-01-26', '2026-03-02']) {
        await bill(db, { date, cents: 5988, categoryId: phone, accountId: card, payee: '话费' });
      }
      expect(await detectCandidates(db)).toHaveLength(1);
    });

    it('accepts exactly 15% and rejects 16%', async () => {
      const { db, card, phone } = await fixture();
      for (const [date, cents] of [
        ['2026-01-01', 1000],
        ['2026-02-01', 1000],
        ['2026-03-01', 1150],
      ] as const) {
        await bill(db, { date, cents, categoryId: phone, accountId: card, payee: '话费' });
      }
      expect(await detectCandidates(db)).toHaveLength(1);

      // One cent more is 16% off the median: the run stops qualifying, and
      // the candidate it produced is withdrawn rather than left standing.
      await db.run("UPDATE txn SET amount_cents = -1160 WHERE occurred_date = '2026-03-01'");
      expect(await detectCandidates(db)).toEqual([]);
      expect(await hintRows(db)).toEqual([]);
    });

    it('rejects two occurrences and accepts three', async () => {
      const { db, card, phone } = await fixture();
      await bill(db, { date: '2026-01-01', cents: 5988, categoryId: phone, accountId: card, payee: '话费' });
      await bill(db, { date: '2026-02-01', cents: 5988, categoryId: phone, accountId: card, payee: '话费' });
      expect(await detectCandidates(db)).toEqual([]);

      await bill(db, { date: '2026-03-01', cents: 5988, categoryId: phone, accountId: card, payee: '话费' });
      expect(await detectCandidates(db)).toHaveLength(1);
    });
  });

  it('keeps one candidate per identity and refreshes it when a new bill lands', async () => {
    const { db, card, phone } = await fixture();
    for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      await bill(db, { date, cents: 5988, categoryId: phone, accountId: card, payee: '话费' });
    }

    const first = await detectCandidates(db);
    const again = await detectCandidates(db);
    expect(again.map(candidate => candidate.id)).toEqual([first[0].id]);
    expect(again[0].occurrences).toBe(3);

    await bill(db, { date: '2026-04-01', cents: 5988, categoryId: phone, accountId: card, payee: '话费' });
    const refreshed = await detectCandidates(db);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({
      id: first[0].id,
      occurrences: 4,
      lastDate: '2026-04-01',
      nextDate: '2026-05-01',
    });
  });

  it('drops a candidate once its bills no longer support it', async () => {
    const { db, card, phone } = await fixture();
    const ids = await phoneRun(db, card, phone);
    expect(await detectCandidates(db)).toHaveLength(1);

    for (const id of ids) {
      await softDeleteTxn(db, id);
    }

    expect(await detectCandidates(db)).toEqual([]);
    expect(await hintRows(db)).toEqual([]);
  });

  // Transfers and adjustments are never 'expense', so the direction filter in
  // the detection query already excludes them; income is the case that could
  // otherwise look like a monthly run.
  it('ignores income and rows without a category', async () => {
    const { db, card, phone } = await fixture();
    for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      await createIncome(db, {
        date: `${date.slice(0, 8)}15`,
        accountId: card,
        amountCents: 5988,
        categoryId: phone,
      });
      await bill(db, { date, cents: 5988, categoryId: null, accountId: card, payee: '话费' });
    }
    expect(await detectCandidates(db)).toEqual([]);

    for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      await bill(db, { date, cents: 5988, categoryId: phone, accountId: card, payee: '话费' });
    }
    const candidates = await detectCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].occurrences).toBe(3);
  });

  it('does not propose 未分类 itself, but a payee inside it still names one', async () => {
    const { db, card } = await fixture();
    for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      await bill(db, { date, cents: 1500, categoryId: 'uncategorized', accountId: card, payee: null });
    }
    expect(await detectCandidates(db)).toEqual([]);

    for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      await bill(db, { date, cents: 3000, categoryId: 'uncategorized', accountId: card, payee: '健身房' });
    }
    const candidates = await detectCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ name: '健身房', occurrences: 3 });
  });

  it('does not propose candidates from an archived category', async () => {
    const { db, card, subs } = await fixture();
    for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      await bill(db, { date, cents: 2500, categoryId: subs, accountId: card, payee: '视频会员' });
    }
    await archiveCategory(db, subs);

    expect(await detectCandidates(db)).toEqual([]);
  });

  it('proposes two candidates when two payees share one category', async () => {
    const { db, card, phone } = await fixture();
    for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      await bill(db, { date, cents: 5988, categoryId: phone, accountId: card, payee: '话费' });
      await bill(db, {
        date: `${date.slice(0, 8)}20`,
        cents: 3000,
        categoryId: phone,
        accountId: card,
        payee: '校园网',
      });
    }

    const candidates = await detectCandidates(db);
    expect(candidates.map(candidate => candidate.name).sort()).toEqual(['校园网', '话费']);
  });
});

describe('confirmCandidate', () => {
  it('flags the whole run, records the decision and lists the item', async () => {
    const { db, card, phone } = await fixture();
    const ids = await phoneRun(db, card, phone);
    const [candidate] = await detectCandidates(db);

    const item = await confirmCandidate(db, candidate.id);

    expect(item).toEqual({
      name: '话费',
      categoryId: phone,
      categoryName: '通讯',
      payee: '话费',
      monthlyCents: 5988,
      lastDate: '2026-05-01',
      nextDate: '2026-06-01',
      dayOfMonth: 1,
      occurrences: 5,
    });
    expect(await listFixedCosts(db)).toEqual([item]);
    expect(await monthlyTotalCents(db)).toBe(5988);
    expect(await listCandidates(db)).toEqual([]);
    expect(await hintRows(db)).toMatchObject([{ status: 'confirmed' }]);

    const flagged = await db.all<{ id: string; is_fixed_cost: number }>(
      'SELECT id, is_fixed_cost FROM txn ORDER BY id'
    );
    expect(flagged).toHaveLength(5);
    expect(flagged.map(row => row.id).sort()).toEqual([...ids].sort());
    expect(flagged.every(row => row.is_fixed_cost === 1)).toBe(true);
    // Still five rows: confirming records a decision, it does not book money.
    expect(await db.all('SELECT id FROM txn')).toHaveLength(5);
  });

  it('is idempotent: a second confirm changes nothing', async () => {
    const { db, card, phone } = await fixture();
    await phoneRun(db, card, phone);
    const [candidate] = await detectCandidates(db);

    await confirmCandidate(db, candidate.id);
    const again = await confirmCandidate(db, candidate.id);

    expect(again.occurrences).toBe(5);
    expect(await flagCount(db)).toBe(5);
    expect(await listFixedCosts(db)).toHaveLength(1);
    expect(await monthlyTotalCents(db)).toBe(5988);
  });

  it('re-derives the run at confirm time so the flags match the numbers shown', async () => {
    const { db, card, phone } = await fixture();
    await phoneRun(db, card, phone);
    const [candidate] = await detectCandidates(db);

    await bill(db, { date: '2026-06-01', cents: 5988, categoryId: phone, accountId: card, payee: '话费' });
    const item = await confirmCandidate(db, candidate.id);

    expect(item).toMatchObject({ lastDate: '2026-06-01', nextDate: '2026-07-01', occurrences: 6 });
    expect(await flagCount(db)).toBe(6);
  });

  // 下次日期 = 最近一次 + 1 个月, and 最近一次 means the newest bill, not the
  // newest flagged one: nobody should have to re-confirm the same charge every
  // month for the date to move.
  it('never re-asks about a confirmed identity, and the next date walks forward on its own', async () => {
    const { db, card, phone } = await fixture();
    await phoneRun(db, card, phone);
    const [candidate] = await detectCandidates(db);
    await confirmCandidate(db, candidate.id);

    expect(await listFixedCosts(db)).toMatchObject([
      { lastDate: '2026-05-01', nextDate: '2026-06-01', occurrences: 5 },
    ]);

    // June's bill arrives, exactly like every other month, unflagged.
    await bill(db, { date: '2026-06-01', cents: 5988, categoryId: phone, accountId: card, payee: '话费' });

    // The identity is settled: no prompt, ever again…
    expect(await detectCandidates(db)).toEqual([]);
    // …but the line already knows June happened.
    expect(await listFixedCosts(db)).toMatchObject([
      { lastDate: '2026-06-01', nextDate: '2026-07-01', occurrences: 6 },
    ]);
    expect(await monthlyTotalCents(db)).toBe(5988);
  });

  it('leaves the line alone when a later bill is too different to be the same charge', async () => {
    const { db, card, phone } = await fixture();
    await phoneRun(db, card, phone);
    const [candidate] = await detectCandidates(db);
    await confirmCandidate(db, candidate.id);

    // 100.00 against a 59.88 habit is 67% off: some other phone-shaped expense.
    await bill(db, { date: '2026-06-03', cents: 10000, categoryId: phone, accountId: card, payee: '话费' });

    expect(await listFixedCosts(db)).toMatchObject([
      { lastDate: '2026-05-01', nextDate: '2026-06-01', monthlyCents: 5988 },
    ]);

    // Flagging it by hand is the owner overruling the tolerance.
    await db.run("UPDATE txn SET is_fixed_cost = 1 WHERE occurred_date = '2026-06-03'");
    expect(await listFixedCosts(db)).toMatchObject([{ lastDate: '2026-06-03', monthlyCents: 10000 }]);
  });

  it('refuses an unknown id and a dismissed candidate', async () => {
    const { db, card, phone } = await fixture();
    await phoneRun(db, card, phone);
    const [candidate] = await detectCandidates(db);
    await dismissCandidate(db, candidate.id);

    await expect(confirmCandidate(db, 'nope')).rejects.toThrow('没有这条固定支出候选');
    await expect(confirmCandidate(db, candidate.id)).rejects.toThrow('忽略');
    expect(await flagCount(db)).toBe(0);
  });
});

describe('dismissCandidate', () => {
  it('never asks again about a dismissed identity', async () => {
    const { db, card, phone } = await fixture();
    for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      await bill(db, { date, cents: 5988, categoryId: phone, accountId: card, payee: '话费' });
    }
    const [candidate] = await detectCandidates(db);

    expect(await dismissCandidate(db, candidate.id)).toBeUndefined();
    expect(await listCandidates(db)).toEqual([]);
    expect(await hintRows(db)).toMatchObject([{ id: candidate.id, status: 'dismissed' }]);

    // A new month arrives: the identity stays silent, and nothing was flagged.
    await bill(db, { date: '2026-04-01', cents: 5988, categoryId: phone, accountId: card, payee: '话费' });
    expect(await detectCandidates(db)).toEqual([]);
    expect(await hintRows(db)).toMatchObject([{ id: candidate.id, status: 'dismissed', occurrences: 3 }]);
    expect(await flagCount(db)).toBe(0);
    expect(await listFixedCosts(db)).toEqual([]);
  });

  it('is idempotent and refuses a confirmed candidate', async () => {
    const { db, card, phone } = await fixture();
    await phoneRun(db, card, phone);
    const [candidate] = await detectCandidates(db);

    await dismissCandidate(db, candidate.id);
    await expect(dismissCandidate(db, candidate.id)).resolves.toBeUndefined();

    const other = await fixture();
    for (const date of ['2026-01-05', '2026-02-05', '2026-03-05']) {
      await bill(other.db, {
        date,
        cents: 2500,
        categoryId: other.subs,
        accountId: other.card,
        payee: '视频会员',
      });
    }
    const [confirmed] = await detectCandidates(other.db);
    await confirmCandidate(other.db, confirmed.id);
    await expect(dismissCandidate(other.db, confirmed.id)).rejects.toThrow('已经在清单里');
  });
});

describe('listFixedCosts and monthlyTotalCents', () => {
  it('lists two fixed costs, ordered by the next bill, and adds them up', async () => {
    const { db, card, phone, subs } = await fixture();
    for (const date of ['2026-01-05', '2026-02-05', '2026-03-05']) {
      await bill(db, { date, cents: 3000, categoryId: phone, accountId: card, payee: '校园网' });
    }
    for (const date of ['2026-01-15', '2026-02-15', '2026-03-15']) {
      await bill(db, { date, cents: 2500, categoryId: subs, accountId: card, payee: '视频会员' });
    }

    const candidates = await detectCandidates(db);
    for (const candidate of candidates) {
      await confirmCandidate(db, candidate.id);
    }

    const items = await listFixedCosts(db);
    expect(items.map(item => item.name)).toEqual(['校园网', '视频会员']);
    expect(items.map(item => item.dayOfMonth)).toEqual([5, 15]);
    expect(items.map(item => item.nextDate)).toEqual(['2026-04-05', '2026-04-15']);
    expect(items.map(item => item.categoryName)).toEqual(['通讯', '订阅']);

    const total = await monthlyTotalCents(db);
    expect(total).toBe(5500);
    expect(items.reduce((sum, item) => sum + item.monthlyCents, 0)).toBe(total);
  });

  it('lists a manually flagged row that no candidate ever proposed', async () => {
    const { db, card, subs } = await fixture();
    const id = await bill(db, {
      date: '2026-10-05',
      cents: 2500,
      categoryId: subs,
      accountId: card,
      payee: '视频会员',
    });
    await db.run('UPDATE txn SET is_fixed_cost = 1 WHERE id = ?', [id]);

    expect(await listFixedCosts(db)).toEqual([
      {
        name: '视频会员',
        categoryId: subs,
        categoryName: '订阅',
        payee: '视频会员',
        monthlyCents: 2500,
        lastDate: '2026-10-05',
        nextDate: '2026-11-05',
        dayOfMonth: 5,
        occurrences: 1,
      },
    ]);
    expect(await monthlyTotalCents(db)).toBe(2500);
  });

  it('takes the newest flagged row as the amount and the date', async () => {
    const { db, card, subs } = await fixture();
    for (const [date, cents] of [
      ['2026-01-05', 2500],
      ['2026-02-05', 2900],
    ] as const) {
      const id = await bill(db, { date, cents, categoryId: subs, accountId: card, payee: '视频会员' });
      await db.run('UPDATE txn SET is_fixed_cost = 1 WHERE id = ?', [id]);
    }

    expect(await listFixedCosts(db)).toMatchObject([
      { monthlyCents: 2900, lastDate: '2026-02-05', nextDate: '2026-03-05', occurrences: 2 },
    ]);
  });

  it('clamps the next date at a month end, in a leap year too', async () => {
    const { db, card, phone } = await fixture();
    for (const date of ['2025-11-30', '2025-12-31', '2026-01-31']) {
      await bill(db, { date, cents: 5988, categoryId: phone, accountId: card, payee: '话费' });
    }
    const [candidate] = await detectCandidates(db);
    expect(candidate).toMatchObject({ lastDate: '2026-01-31', nextDate: '2026-02-28' });

    const item = await confirmCandidate(db, candidate.id);
    expect(item).toMatchObject({ dayOfMonth: 31, nextDate: '2026-02-28' });

    const leap = await fixture();
    for (const date of ['2027-11-30', '2027-12-31', '2028-01-31']) {
      await bill(leap.db, { date, cents: 5988, categoryId: leap.phone, accountId: leap.card, payee: '话费' });
    }
    const [leapCandidate] = await detectCandidates(leap.db);
    expect(leapCandidate).toMatchObject({ lastDate: '2028-01-31', nextDate: '2028-02-29' });
  });

  it('keeps a confirmed item after its category is archived or deleted', async () => {
    const { db, card, phone, subs } = await fixture();
    for (const date of ['2026-01-15', '2026-02-15', '2026-03-15']) {
      await bill(db, { date, cents: 2500, categoryId: subs, accountId: card, payee: '视频会员' });
    }
    const [candidate] = await detectCandidates(db);
    await confirmCandidate(db, candidate.id);

    await archiveCategory(db, subs);
    expect(await listFixedCosts(db)).toMatchObject([{ name: '视频会员', categoryName: '订阅' }]);
    expect(await monthlyTotalCents(db)).toBe(2500);
    expect(await detectCandidates(db)).toEqual([]);

    await deleteCategory(db, subs);
    expect(await listFixedCosts(db)).toMatchObject([
      { name: '视频会员', monthlyCents: 2500, lastDate: '2026-03-15' },
    ]);
    expect(await monthlyTotalCents(db)).toBe(2500);
    // phone is untouched by all of this.
    expect(await db.all('SELECT id FROM category WHERE id = ?', [phone])).toHaveLength(1);
  });

  it('ignores income rows even when they are flagged', async () => {
    const { db, card, phone } = await fixture();
    const id = await createIncome(db, {
      date: '2026-10-05',
      accountId: card,
      amountCents: 100000,
      categoryId: phone,
    });
    await db.run('UPDATE txn SET is_fixed_cost = 1 WHERE id = ?', [id]);

    expect(await listFixedCosts(db)).toEqual([]);
    expect(await monthlyTotalCents(db)).toBe(0);
  });

  it('keeps the list and the total agreeing on one source', async () => {
    const { db, card, phone } = await fixture();
    await phoneRun(db, card, phone);
    const [candidate] = await detectCandidates(db);
    await confirmCandidate(db, candidate.id);

    // Deleting one flagged row moves both numbers, never just one.
    const rows = await db.all<{ id: string }>('SELECT id FROM txn ORDER BY occurred_date');
    await softDeleteTxn(db, rows[0].id);
    expect(await monthlyTotalCents(db)).toBe(5988);
    expect(await listFixedCosts(db)).toMatchObject([{ occurrences: 4 }]);
  });
});

describe('unmarkFixed', () => {
  it('undoes a confirmation: flags clear, the total drops, the candidate returns', async () => {
    const { db, card, phone } = await fixture();
    const ids = await phoneRun(db, card, phone);
    const [candidate] = await detectCandidates(db);
    await confirmCandidate(db, candidate.id);

    const restored = await unmarkFixed(db, candidate.id);

    expect(restored).toMatchObject({ id: candidate.id, name: '话费', occurrences: 5 });
    expect(await flagCount(db)).toBe(0);
    expect(await listFixedCosts(db)).toEqual([]);
    expect(await monthlyTotalCents(db)).toBe(0);
    expect(await hintRows(db)).toMatchObject([{ id: candidate.id, status: 'candidate' }]);
    expect((await listCandidates(db)).map(row => row.id)).toEqual([candidate.id]);

    // The undo touched flags only: the five rows are still there, still in 通讯.
    const rows = await db.all<{ id: string; category_id: string | null; amount_cents: number }>(
      'SELECT id, category_id, amount_cents FROM txn ORDER BY id'
    );
    expect(rows.map(row => row.id).sort()).toEqual([...ids].sort());
    expect(rows.every(row => row.category_id === phone && row.amount_cents === -5988)).toBe(true);

    // Detection must not immediately re-confirm or duplicate the hint.
    expect(await detectCandidates(db)).toHaveLength(1);
    expect(await hintRows(db)).toHaveLength(1);
  });

  it('refuses an unknown hint and a dismissed candidate', async () => {
    const { db, card, phone } = await fixture();
    await phoneRun(db, card, phone);
    const [candidate] = await detectCandidates(db);
    await dismissCandidate(db, candidate.id);

    await expect(unmarkFixed(db, 'nope')).rejects.toThrow('没有这条固定支出候选');
    await expect(unmarkFixed(db, candidate.id)).rejects.toThrow('忽略');
  });
});

describe('countExpenseMonths', () => {
  it('counts calendar months with a live expense, ignoring other rows', async () => {
    const { db, card, phone } = await fixture();
    expect(await countExpenseMonths(db)).toBe(0);

    await bill(db, { date: '2026-01-05', cents: 100, categoryId: phone, accountId: card });
    await bill(db, { date: '2026-01-20', cents: 200, categoryId: phone, accountId: card });
    await bill(db, { date: '2026-02-05', cents: 300, categoryId: phone, accountId: card });
    const removed = await bill(db, {
      date: '2026-03-05',
      cents: 400,
      categoryId: phone,
      accountId: card,
    });
    await softDeleteTxn(db, removed);
    await createIncome(db, {
      date: '2026-04-05',
      accountId: card,
      amountCents: 500,
      categoryId: phone,
    });
    await recordAdjustment(db, { date: '2026-05-05', accountId: card, deltaCents: -100 });

    expect(await countExpenseMonths(db)).toBe(2);
  });
});

describe('manual marking', () => {
  it('puts a single bill on the list without waiting for a habit', async () => {
    const { db, card, phone } = await fixture();
    const id = await bill(db, {
      date: '2026-05-01',
      cents: 5988,
      categoryId: phone,
      accountId: card,
      payee: '话费',
    });

    await setTxnFixedCost(db, id, true);
    expect(await listFixedCosts(db)).toMatchObject([
      { name: '话费', monthlyCents: 5988, lastDate: '2026-05-01', nextDate: '2026-06-01' },
    ]);

    await setTxnFixedCost(db, id, false);
    expect(await listFixedCosts(db)).toEqual([]);
  });

  it('refuses income, deleted rows and unknown ids', async () => {
    const { db, card, phone } = await fixture();
    const income = await createIncome(db, {
      date: '2026-05-01',
      accountId: card,
      amountCents: 5000,
      categoryId: null,
    });
    await expect(setTxnFixedCost(db, income, true)).rejects.toThrow(/只有支出/);

    const gone = await bill(db, {
      date: '2026-05-01',
      cents: 5988,
      categoryId: phone,
      accountId: card,
      payee: '话费',
    });
    await softDeleteTxn(db, gone);
    await expect(setTxnFixedCost(db, gone, true)).rejects.toThrow(/已删除/);

    await expect(setTxnFixedCost(db, 'missing', true)).rejects.toThrow(/不存在/);
  });
});
