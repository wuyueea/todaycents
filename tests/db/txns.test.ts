import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import { accountBalance, createAccount } from '../../src/db/repos/accounts';
import { createCategory } from '../../src/db/repos/categories';
import { createTransfer, monthExpenseTotal } from '../../src/db/repos/transfers';
import {
  createIncome,
  createExpense,
  listTxnsByMonth,
  monthSummary,
  categoryShares,
  recordAdjustment,
  softDeleteTxn,
  sumExpensesByAccount,
  updateTxn,
} from '../../src/db/repos/txns';
import type { TxnRow } from '../../src/db/repos/txns';

async function fixture() {
  const db = await createTestDb();
  const card = await createAccount(db, { name: '饭卡', type: 'prepaid', initialBalanceCents: 0 });
  const food = await createCategory(db, { name: '饮食', kind: 'expense' });
  const daily = await createCategory(db, { name: '日用', kind: 'expense' });
  const income = await createCategory(db, { name: '生活费', kind: 'income' });
  return { db, card, food, daily, income };
}

describe('txns', () => {
  it('summarizes a month and shares by category', async () => {
    const { db, card, food, daily, income } = await fixture();
    await createExpense(db, { date: '2026-10-01', accountId: card, amountCents: 1230, categoryId: food });
    await createExpense(db, { date: '2026-10-02', accountId: card, amountCents: 1060, categoryId: food });
    await createExpense(db, { date: '2026-10-03', accountId: card, amountCents: 350, categoryId: daily });
    await createIncome(db, { date: '2026-10-05', accountId: card, amountCents: 100000, categoryId: income });
    expect(await monthSummary(db, '2026-10')).toEqual({ expenseCents: 2640, incomeCents: 100000 });
    const shares = await categoryShares(db, '2026-10');
    expect(shares[0]).toMatchObject({ name: '饮食', cents: 2290 });
    expect(shares[1]).toMatchObject({ name: '日用', cents: 350 });
  });
  it('does not leak across month boundaries', async () => {
    const { db, card, food } = await fixture();
    await createExpense(db, { date: '2026-10-31', accountId: card, amountCents: 100, categoryId: food });
    await createExpense(db, { date: '2026-11-01', accountId: card, amountCents: 200, categoryId: food });
    expect((await monthSummary(db, '2026-10')).expenseCents).toBe(100);
    expect((await monthSummary(db, '2026-11')).expenseCents).toBe(200);
  });
  it('soft delete removes the row from list and totals', async () => {
    const { db, card, food } = await fixture();
    const id = await createExpense(db, { date: '2026-10-01', accountId: card, amountCents: 1230, categoryId: food });
    await softDeleteTxn(db, id);
    expect(await listTxnsByMonth(db, '2026-10')).toHaveLength(0);
    expect((await monthSummary(db, '2026-10')).expenseCents).toBe(0);
  });
  it('stores awkward notes without breaking', async () => {
    const { db, card, food } = await fixture();
    const note = '夜宵🍜\n加辣 "两份" ' + 'x'.repeat(200);
    const id = await createExpense(db, { date: '2026-10-01', accountId: card, amountCents: 850, categoryId: food, note });
    const rows = await listTxnsByMonth(db, '2026-10');
    expect(rows.find(r => r.id === id)?.note).toBe(note);
  });
  it('rejects non-positive amounts', async () => {
    const { db, card, food } = await fixture();
    await expect(createExpense(db, { date: '2026-10-01', accountId: card, amountCents: 0, categoryId: food })).rejects.toThrow();
    await expect(createExpense(db, { date: '2026-10-01', accountId: card, amountCents: -5, categoryId: food })).rejects.toThrow();
  });
});

describe('txns validation', () => {
  it('rejects dates that are not real YYYY-MM-DD days, writing nothing', async () => {
    const { db, card, food } = await fixture();
    const badDates = ['2026/10/01', '2026-1-01', '20261001', '2026-02-30', '2026-13-01', ''];
    for (const date of badDates) {
      await expect(
        createExpense(db, { date, accountId: card, amountCents: 100, categoryId: food })
      ).rejects.toThrow();
      await expect(
        createIncome(db, { date, accountId: card, amountCents: 100, categoryId: food })
      ).rejects.toThrow();
    }
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM txn'))?.n).toBe(0);
  });

  it('accepts leap days and month edges', async () => {
    const { db, card, food } = await fixture();
    await createExpense(db, { date: '2028-02-29', accountId: card, amountCents: 1, categoryId: food });
    await createExpense(db, { date: '2026-10-31', accountId: card, amountCents: 2, categoryId: food });
    expect(await listTxnsByMonth(db, '2028-02')).toHaveLength(1);
    expect(await listTxnsByMonth(db, '2026-10')).toHaveLength(1);
  });

  it('rejects fractional, non-finite and non-positive amounts', async () => {
    const { db, card, food } = await fixture();
    for (const amountCents of [0, -5, 10.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        createExpense(db, { date: '2026-10-01', accountId: card, amountCents, categoryId: food })
      ).rejects.toThrow();
      await expect(
        createIncome(db, { date: '2026-10-01', accountId: card, amountCents, categoryId: food })
      ).rejects.toThrow();
    }
  });
});

describe('listTxnsByMonth', () => {
  it('returns live rows newest first with resolved names and null categories', async () => {
    const { db, card, food } = await fixture();
    const bank = await createAccount(db, { name: '银行卡', type: 'bank', initialBalanceCents: 100000 });
    const older = await createExpense(db, {
      date: '2026-10-01',
      accountId: card,
      amountCents: 1230,
      categoryId: food,
      note: '月初',
    });
    const uncategorised = await createExpense(db, {
      date: '2026-10-03',
      accountId: card,
      amountCents: 700,
      categoryId: null,
    });
    const transferGroupId = await createTransfer(db, {
      date: '2026-10-04',
      fromAccountId: bank,
      toAccountId: card,
      amountCents: 1000,
    });
    const newer = await createIncome(db, {
      date: '2026-10-05',
      accountId: bank,
      amountCents: 50000,
      categoryId: null,
    });

    const rows = await listTxnsByMonth(db, '2026-10');
    expect(rows[0]).toMatchObject({
      id: newer,
      occurredDate: '2026-10-05',
      accountId: bank,
      accountName: '银行卡',
      amountCents: 50000,
      direction: 'income',
      categoryId: null,
      categoryName: null,
      note: '',
      slotKey: null,
      isFixedCost: false,
      transferGroupId: null,
      deletedAt: null,
    });
    const ordered = rows.filter(r => r.id === older || r.id === newer).map(r => r.id);
    expect(ordered).toEqual([newer, older]);
    expect(rows.find(r => r.id === uncategorised)).toMatchObject({
      categoryId: null,
      categoryName: null,
      amountCents: -700,
      accountName: '饭卡',
    });
    const transferRows = rows.filter(r => r.direction === 'transfer');
    expect(transferRows).toHaveLength(2);
    expect(transferRows.every(r => r.transferGroupId === transferGroupId)).toBe(true);
    expect(await monthSummary(db, '2026-10')).toEqual({ expenseCents: 1930, incomeCents: 50000 });
  });

  it('keeps the slot key and flags a plain row as not fixed cost', async () => {
    const { db, card, food } = await fixture();
    const id = await createExpense(db, {
      date: '2026-10-01',
      accountId: card,
      amountCents: 850,
      categoryId: food,
      slotKey: 'lunch',
    });
    const row = (await listTxnsByMonth(db, '2026-10')).find(r => r.id === id);
    expect(row).toMatchObject({ slotKey: 'lunch', isFixedCost: false, amountCents: -850, direction: 'expense' });
  });
});

describe('updateTxn', () => {
  it('edits amount, category, account and note without moving the date or losing the sign', async () => {
    const { db, card, food, daily, income } = await fixture();
    const bank = await createAccount(db, { name: '银行卡', type: 'bank', initialBalanceCents: 0 });
    const expenseId = await createExpense(db, {
      date: '2026-10-02',
      accountId: card,
      amountCents: 1230,
      categoryId: food,
      note: '旧备注',
    });

    await updateTxn(db, expenseId, {
      amountCents: 5000,
      categoryId: daily,
      accountId: bank,
      note: '新备注',
    });

    const rows = await listTxnsByMonth(db, '2026-10');
    expect(rows.find(r => r.id === expenseId)).toMatchObject({
      occurredDate: '2026-10-02',
      accountId: bank,
      accountName: '银行卡',
      amountCents: -5000,
      direction: 'expense',
      categoryId: daily,
      categoryName: '日用',
      note: '新备注',
    });

    const incomeId = await createIncome(db, {
      date: '2026-10-03',
      accountId: card,
      amountCents: 100000,
      categoryId: income,
    });
    await updateTxn(db, incomeId, { amountCents: 20000 });
    expect((await listTxnsByMonth(db, '2026-10')).find(r => r.id === incomeId)?.amountCents).toBe(20000);
    expect(await monthSummary(db, '2026-10')).toEqual({ expenseCents: 5000, incomeCents: 20000 });
  });

  it('can clear the category and leave other fields alone when the patch is partial', async () => {
    const { db, card, food } = await fixture();
    const id = await createExpense(db, {
      date: '2026-10-02',
      accountId: card,
      amountCents: 1230,
      categoryId: food,
      note: '保留',
    });
    await updateTxn(db, id, { categoryId: null });
    expect((await listTxnsByMonth(db, '2026-10')).find(r => r.id === id)).toMatchObject({
      categoryId: null,
      categoryName: null,
      amountCents: -1230,
      note: '保留',
    });
  });

  it('rejects bad amounts, date moves and rows that are gone', async () => {
    const { db, card, food } = await fixture();
    const id = await createExpense(db, {
      date: '2026-10-02',
      accountId: card,
      amountCents: 1230,
      categoryId: food,
    });
    for (const amountCents of [0, -5, 10.5, Number.NaN]) {
      await expect(updateTxn(db, id, { amountCents })).rejects.toThrow();
    }
    const moveDate = { date: '2026-10-09' } as unknown as Parameters<typeof updateTxn>[2];
    await expect(updateTxn(db, id, moveDate)).rejects.toThrow();

    await softDeleteTxn(db, id);
    await expect(updateTxn(db, id, { amountCents: 100 })).rejects.toThrow();
    await expect(updateTxn(db, 'missing-id', { note: 'x' })).rejects.toThrow();
  });
});

describe('softDeleteTxn', () => {
  it('is soft, idempotent and keeps the first timestamp', async () => {
    const { db, card, food } = await fixture();
    const id = await createExpense(db, {
      date: '2026-10-01',
      accountId: card,
      amountCents: 1230,
      categoryId: food,
    });
    await softDeleteTxn(db, id);
    const first = await db.get<{ deleted_at: string | null }>('SELECT deleted_at FROM txn WHERE id = ?', [id]);
    await softDeleteTxn(db, id);
    const second = await db.get<{ deleted_at: string | null }>('SELECT deleted_at FROM txn WHERE id = ?', [id]);
    expect(first?.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(second?.deleted_at).toBe(first?.deleted_at);
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM txn'))?.n).toBe(1);
  });
});

describe('transfer legs', () => {
  it('refuses to edit or soft-delete one leg of a transfer', async () => {
    const { db, card } = await fixture();
    const bank = await createAccount(db, { name: '银行卡', type: 'bank', initialBalanceCents: 100000 });
    const cash = await createAccount(db, { name: '现金', type: 'cash' });
    const gid = await createTransfer(db, {
      date: '2026-10-05',
      fromAccountId: bank,
      toAccountId: card,
      amountCents: 60000,
    });
    const legs = await db.all<{ id: string; amount_cents: number }>(
      'SELECT id, amount_cents FROM txn WHERE transfer_group_id = ? ORDER BY amount_cents',
      [gid]
    );
    const negativeLeg = legs[0];

    await expect(updateTxn(db, negativeLeg.id, { amountCents: 70000 })).rejects.toThrow();
    await expect(updateTxn(db, negativeLeg.id, { accountId: cash })).rejects.toThrow();
    await expect(softDeleteTxn(db, negativeLeg.id)).rejects.toThrow();

    const live = await db.all<{ amount_cents: number }>(
      'SELECT amount_cents FROM txn WHERE transfer_group_id = ? AND deleted_at IS NULL ORDER BY amount_cents',
      [gid]
    );
    expect(live.map(row => row.amount_cents)).toEqual([-60000, 60000]);
    expect(await accountBalance(db, bank)).toBe(40000);
    expect(await accountBalance(db, card)).toBe(60000);
  });
});

describe('recordAdjustment', () => {
  it('moves the balance by the signed delta without entering spending, income or shares', async () => {
    const { db, card, food } = await fixture();
    await createExpense(db, {
      date: '2026-10-01',
      accountId: card,
      amountCents: 1230,
      categoryId: food,
    });
    expect(await accountBalance(db, card)).toBe(-1230);

    const id = await recordAdjustment(db, {
      date: '2026-10-20',
      accountId: card,
      deltaCents: 5000,
      note: '对账差额',
    });

    expect(await accountBalance(db, card)).toBe(3770);
    expect(await monthSummary(db, '2026-10')).toEqual({ expenseCents: 1230, incomeCents: 0 });
    expect(await categoryShares(db, '2026-10')).toEqual([
      { categoryId: food, name: '饮食', cents: 1230 },
    ]);

    const row = (await listTxnsByMonth(db, '2026-10')).find(candidate => candidate.id === id);
    expect(row).toMatchObject({
      occurredDate: '2026-10-20',
      accountId: card,
      amountCents: 5000,
      direction: 'adjust',
      categoryId: null,
      categoryName: null,
      note: '对账差额',
      slotKey: null,
      deletedAt: null,
    });
  });

  it('accepts a negative delta, lowering the balance without reading as spending', async () => {
    const { db, card } = await fixture();
    await recordAdjustment(db, { date: '2026-10-20', accountId: card, deltaCents: -2500 });

    expect(await accountBalance(db, card)).toBe(-2500);
    expect(await monthSummary(db, '2026-10')).toEqual({ expenseCents: 0, incomeCents: 0 });
    expect(await categoryShares(db, '2026-10')).toEqual([]);
    expect((await listTxnsByMonth(db, '2026-10'))[0]).toMatchObject({
      amountCents: -2500,
      direction: 'adjust',
      categoryId: null,
      slotKey: null,
    });
  });

  it('rejects zero, fractional, unsafe, badly dated or unknown-account adjustments', async () => {
    const { db, card } = await fixture();
    for (const deltaCents of [0, 10.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        recordAdjustment(db, { date: '2026-10-20', accountId: card, deltaCents })
      ).rejects.toThrow();
    }
    await expect(
      recordAdjustment(db, { date: '2026-02-30', accountId: card, deltaCents: 100 })
    ).rejects.toThrow();
    await expect(
      recordAdjustment(db, { date: '2026-10-20', accountId: 'missing-account', deltaCents: 100 })
    ).rejects.toThrow(/account not found/);

    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM txn'))?.n).toBe(0);
  });

  it('refuses to adjust an archived account', async () => {
    const { db } = await fixture();
    const archived = await createAccount(db, { name: '旧卡', type: 'prepaid' });
    await db.run('UPDATE account SET archived_at = ? WHERE id = ?', [
      '2026-10-01T00:00:00.000Z',
      archived,
    ]);

    await expect(
      recordAdjustment(db, { date: '2026-10-20', accountId: archived, deltaCents: 100 })
    ).rejects.toThrow(/archived/);
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM txn'))?.n).toBe(0);
  });
});

describe('categoryShares', () => {
  it('groups expenses, orders by cents and collapses uncategorised rows into one bucket', async () => {
    const { db, card, food, daily, income } = await fixture();
    await createExpense(db, { date: '2026-10-01', accountId: card, amountCents: 1230, categoryId: food });
    await createExpense(db, { date: '2026-10-02', accountId: card, amountCents: 1060, categoryId: food });
    await createExpense(db, { date: '2026-10-03', accountId: card, amountCents: 400, categoryId: null });
    await createExpense(db, { date: '2026-10-03', accountId: card, amountCents: 300, categoryId: null });
    await createExpense(db, { date: '2026-10-04', accountId: card, amountCents: 350, categoryId: daily });
    await createIncome(db, { date: '2026-10-05', accountId: card, amountCents: 100000, categoryId: income });

    expect(await categoryShares(db, '2026-10')).toEqual([
      { categoryId: food, name: '饮食', cents: 2290 },
      { categoryId: '', name: '未分类', cents: 700 },
      { categoryId: daily, name: '日用', cents: 350 },
    ]);
  });

  // A NULL category and the system 未分类 row are the same thing to the owner:
  // two bars named 未分类 would be a lie about the month.
  it('merges a NULL category with the system 未分类 row into one bucket', async () => {
    const { db, card, food } = await fixture();
    await createExpense(db, { date: '2026-10-01', accountId: card, amountCents: 400, categoryId: null });
    await createExpense(db, {
      date: '2026-10-02',
      accountId: card,
      amountCents: 600,
      categoryId: 'uncategorized',
    });
    await createExpense(db, { date: '2026-10-03', accountId: card, amountCents: 1230, categoryId: food });

    expect(await categoryShares(db, '2026-10')).toEqual([
      { categoryId: food, name: '饮食', cents: 1230 },
      { categoryId: '', name: '未分类', cents: 1000 },
    ]);
  });

  it('ignores deleted rows, transfers, adjustments and other months', async () => {
    const { db, card, food } = await fixture();
    const bank = await createAccount(db, { name: '银行卡', type: 'bank', initialBalanceCents: 100000 });
    await createExpense(db, { date: '2026-10-01', accountId: card, amountCents: 1230, categoryId: food });
    const gone = await createExpense(db, { date: '2026-10-02', accountId: card, amountCents: 5000, categoryId: food });
    await softDeleteTxn(db, gone);
    await createExpense(db, { date: '2026-11-01', accountId: card, amountCents: 900, categoryId: food });
    await createTransfer(db, { date: '2026-10-04', fromAccountId: bank, toAccountId: card, amountCents: 1000 });
    await db.run(
      `INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, note, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      ['adjust-1', '2026-10-05', bank, -400, 'adjust', '', '2026-10-05T00:00:00']
    );

    expect(await categoryShares(db, '2026-10')).toEqual([{ categoryId: food, name: '饮食', cents: 1230 }]);
    expect(await categoryShares(db, '2026-12')).toEqual([]);
    expect(await monthSummary(db, '2026-12')).toEqual({ expenseCents: 0, incomeCents: 0 });
  });
});

function row(
  overrides: Partial<TxnRow> & Pick<TxnRow, 'accountId' | 'amountCents' | 'direction'>
): TxnRow {
  return {
    id: 'row',
    occurredDate: '2026-10-01',
    accountName: '测试账户',
    categoryId: null,
    categoryName: null,
    note: '',
    slotKey: null,
    isFixedCost: false,
    transferGroupId: null,
    deletedAt: null,
    projectId: null,
    projectName: null,
    projectArchived: false,
    ...overrides,
  };
}

describe('sumExpensesByAccount', () => {
  it('sums only live expense rows, per account, as positive cents', () => {
    const totals = sumExpensesByAccount([
      row({ accountId: 'a', amountCents: -1230, direction: 'expense' }),
      row({ accountId: 'a', amountCents: -1000, direction: 'expense' }),
      row({ accountId: 'b', amountCents: -350, direction: 'expense' }),
      row({ accountId: 'a', amountCents: 5000, direction: 'income' }),
      row({ accountId: 'a', amountCents: -6000, direction: 'transfer' }),
      row({ accountId: 'b', amountCents: -400, direction: 'adjust' }),
      row({
        accountId: 'a',
        amountCents: -999,
        direction: 'expense',
        deletedAt: '2026-10-02T00:00:00.000Z',
      }),
    ]);

    expect(totals.get('a')).toBe(2230);
    expect(totals.get('b')).toBe(350);
    expect(totals.has('c')).toBe(false);
  });

  it('returns an empty map for a month with no rows', () => {
    expect(sumExpensesByAccount([]).size).toBe(0);
  });
});

describe('month consistency', () => {
  it('every summary number agrees with the rows listTxnsByMonth shows', async () => {
    const { db, card, food, daily, income } = await fixture();
    const bank = await createAccount(db, { name: '银行卡', type: 'bank', initialBalanceCents: 100000 });
    await createExpense(db, { date: '2026-10-01', accountId: card, amountCents: 1230, categoryId: food });
    await createExpense(db, { date: '2026-10-02', accountId: card, amountCents: 350, categoryId: daily });
    await createExpense(db, { date: '2026-10-03', accountId: card, amountCents: 999, categoryId: null });
    const gone = await createExpense(db, { date: '2026-10-04', accountId: card, amountCents: 5000, categoryId: food });
    await softDeleteTxn(db, gone);
    await createIncome(db, { date: '2026-10-05', accountId: bank, amountCents: 100000, categoryId: income });
    await createTransfer(db, { date: '2026-10-06', fromAccountId: bank, toAccountId: card, amountCents: 2000 });
    await db.run(
      `INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, note, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      ['adjust-2', '2026-10-07', bank, -400, 'adjust', '', '2026-10-07T00:00:00']
    );

    const rows = await listTxnsByMonth(db, '2026-10');
    const expected = { expenseCents: 0, incomeCents: 0 };
    for (const row of rows) {
      if (row.direction === 'expense') expected.expenseCents += -row.amountCents;
      if (row.direction === 'income') expected.incomeCents += row.amountCents;
    }

    expect(await monthSummary(db, '2026-10')).toEqual(expected);
    const shares = await categoryShares(db, '2026-10');
    expect(shares.reduce((sum, share) => sum + share.cents, 0)).toBe(expected.expenseCents);
    expect(await monthExpenseTotal(db, '2026-10')).toBe(expected.expenseCents);
  });
});
