import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';
import { listTemplates, upsertTemplate, submitDay } from '../../src/db/repos/templates';
import { listTxnsByMonth, softDeleteTxn } from '../../src/db/repos/txns';
import { createAccount, listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import type { Db } from '../../src/db/driver';

/**
 * A seeded database plus the grid a day grid would tap. Templates are no
 * longer starter data, so the fixture writes the five slots and the two cards
 * it needs explicitly — nothing here relies on the seed's account list.
 */
async function fixture() {
  const db = await createTestDb();
  await seedDefaults(db);
  const cardId = await createAccount(db, {
    name: '饭卡',
    type: 'prepaid',
    monthlyBudgetCents: 75000,
  });
  const waterId = await createAccount(db, { name: '洗浴水卡', type: 'prepaid' });
  const categories = await listCategories(db);
  const food = categories.find(c => c.name === '饮食')!;
  const home = categories.find(c => c.name === '居住')!;
  const other = categories.find(c => c.name === '其他')!;
  const grid = [
    { slotKey: 'breakfast', label: '早餐', categoryId: food.id, accountId: cardId },
    { slotKey: 'lunch', label: '午餐', categoryId: food.id, accountId: cardId },
    { slotKey: 'dinner', label: '晚餐', categoryId: food.id, accountId: cardId },
    { slotKey: 'shower', label: '洗浴', categoryId: home.id, accountId: waterId },
    { slotKey: 'print', label: '打印', categoryId: other.id, accountId: cardId },
  ];
  for (const [sort, cell] of grid.entries()) {
    await upsertTemplate(db, {
      slotKey: cell.slotKey,
      label: cell.label,
      categoryId: cell.categoryId,
      defaultAccountId: cell.accountId,
      defaultAmountCents: null,
      sort,
    });
  }
  const accounts = await listAccounts(db);
  return {
    db,
    card: accounts.find(candidate => candidate.id === cardId)!,
    water: accounts.find(candidate => candidate.id === waterId)!,
  };
}

/** Every row ever written, soft-deleted ones included. */
function txnCount(db: Db) {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM txn');
}

describe('templates', () => {
  it('leaves the grid empty: the seed writes no template rows', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    expect(await listTemplates(db)).toEqual([]);
  });
  it('skips empty cells and keeps the slot key', async () => {
    const { db, card } = await fixture();
    const written = await submitDay(db, '2026-10-20', [
      { slotKey: 'breakfast', amountCents: null, accountId: card.id, categoryId: null },
      { slotKey: 'lunch', amountCents: 1230, accountId: card.id, categoryId: null },
      { slotKey: 'dinner', amountCents: 1060, accountId: card.id, categoryId: null },
    ]);
    expect(written).toBe(2);
    const rows = await listTxnsByMonth(db, '2026-10');
    expect(rows.map(r => r.slotKey).sort()).toEqual(['dinner','lunch']);
  });
  it('is idempotent per day and slot', async () => {
    const { db, card } = await fixture();
    const cell = { slotKey: 'lunch', amountCents: 1230, accountId: card.id, categoryId: null };
    await submitDay(db, '2026-10-20', [cell]);
    await submitDay(db, '2026-10-20', [cell]);
    expect((await listTxnsByMonth(db, '2026-10')).length).toBe(1);
  });
});

describe('templates listing', () => {
  it('maps the row to the template shape', async () => {
    const { db } = await fixture();
    const [first] = await listTemplates(db);
    expect(first).toMatchObject({
      slotKey: 'breakfast',
      label: '早餐',
      sort: 0,
      active: true,
      defaultAmountCents: null,
    });
    // The seed points the grid at real accounts and categories, not made-up ids.
    expect(first!.categoryId).not.toBeNull();
    expect(first!.defaultAccountId).not.toBeNull();
  });

  it('hides inactive templates', async () => {
    const { db } = await fixture();
    await db.run(`UPDATE template SET active = 0 WHERE slot_key = 'shower'`);
    const t = await listTemplates(db);
    expect(t.map(x => x.slotKey)).toEqual(['breakfast', 'lunch', 'dinner', 'print']);
  });

  it('breaks sort ties by slot key so the grid never reshuffles', async () => {
    const { db } = await fixture();
    // Inserted out of alphabetical order, sharing one sort value: only the
    // slot_key tiebreak keeps the result stable across reloads.
    for (const slotKey of ['zz', 'aa']) {
      await upsertTemplate(db, {
        slotKey,
        label: slotKey,
        categoryId: null,
        defaultAccountId: null,
        defaultAmountCents: null,
        sort: 9,
      });
    }
    const t = await listTemplates(db);
    expect(t.map(x => x.slotKey)).toEqual([
      'breakfast', 'lunch', 'dinner', 'shower', 'print', 'aa', 'zz',
    ]);
  });
});

describe('upsertTemplate', () => {
  it('updates a slot in place instead of adding a row', async () => {
    const { db } = await fixture();
    const food = (await listCategories(db, 'expense')).find(c => c.name === '饮食')!;
    await upsertTemplate(db, {
      slotKey: 'lunch',
      label: '午饭',
      categoryId: food.id,
      defaultAccountId: null,
      defaultAmountCents: 1500,
    });
    const count = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM template WHERE slot_key = 'lunch'`
    );
    expect(count?.n).toBe(1);
    expect((await listTemplates(db)).find(x => x.slotKey === 'lunch')).toMatchObject({
      label: '午饭',
      categoryId: food.id,
      defaultAccountId: null,
      defaultAmountCents: 1500,
      sort: 1,
      active: true,
    });
  });

  it('leaves sort and active alone when the caller omits them', async () => {
    const { db } = await fixture();
    await db.run(`UPDATE template SET active = 0 WHERE slot_key = 'shower'`);
    await upsertTemplate(db, {
      slotKey: 'shower',
      label: '洗澡',
      categoryId: null,
      defaultAccountId: null,
      defaultAmountCents: 300,
    });
    const row = await db.get<{ sort: number; active: number; label: string }>(
      `SELECT sort, active, label FROM template WHERE slot_key = 'shower'`
    );
    expect(row).toEqual({ sort: 3, active: 0, label: '洗澡' });
  });

  it('appends a new slot after the current grid', async () => {
    const { db } = await fixture();
    await upsertTemplate(db, {
      slotKey: 'snack',
      label: '零食',
      categoryId: null,
      defaultAccountId: null,
      defaultAmountCents: null,
    });
    const t = (await listTemplates(db)).find(x => x.slotKey === 'snack')!;
    expect(t.sort).toBe(5);
    expect(t.active).toBe(true);
  });

  it('rejects a fractional amount without writing', async () => {
    const { db } = await fixture();
    await expect(
      upsertTemplate(db, {
        slotKey: 'snack',
        label: '零食',
        categoryId: null,
        defaultAccountId: null,
        defaultAmountCents: 12.5,
      })
    ).rejects.toThrow();
    expect(
      (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM template WHERE slot_key = 'snack'`))?.n
    ).toBe(0);
  });
});

describe('submitDay', () => {
  it('writes one signed expense row per filled cell', async () => {
    const { db, card } = await fixture();
    const food = (await listCategories(db, 'expense')).find(c => c.name === '饮食')!;
    const written = await submitDay(db, '2026-10-20', [
      { slotKey: 'lunch', amountCents: 1230, accountId: card.id, categoryId: food.id },
    ]);
    expect(written).toBe(1);
    const [row] = await listTxnsByMonth(db, '2026-10');
    expect(row).toMatchObject({
      occurredDate: '2026-10-20',
      amountCents: -1230,
      direction: 'expense',
      slotKey: 'lunch',
      accountId: card.id,
      categoryId: food.id,
    });
  });

  it('rejects any day touching a non-positive or fractional amount, writing nothing', async () => {
    const { db, card } = await fixture();
    for (const amountCents of [0, -100, 12.5, Number.NaN]) {
      await expect(
        submitDay(db, '2026-10-20', [
          { slotKey: 'breakfast', amountCents: 500, accountId: card.id, categoryId: null },
          { slotKey: 'lunch', amountCents, accountId: card.id, categoryId: null },
        ])
      ).rejects.toThrow();
    }
    // The valid breakfast in the same submission must not survive the rejection.
    expect(await listTxnsByMonth(db, '2026-10')).toHaveLength(0);
  });

  it('rejects a date that is not a real calendar day, writing nothing', async () => {
    const { db, card } = await fixture();
    for (const date of ['2026-02-30', '2026/10/20', '2026-1-01', '']) {
      await expect(
        submitDay(db, date, [
          { slotKey: 'lunch', amountCents: 1230, accountId: card.id, categoryId: null },
        ])
      ).rejects.toThrow();
    }
    expect((await txnCount(db))?.n).toBe(0);
  });

  it('rolls the whole day back when a later cell cannot be written', async () => {
    const { db, card } = await fixture();
    await expect(
      submitDay(db, '2026-10-20', [
        { slotKey: 'breakfast', amountCents: 500, accountId: card.id, categoryId: null },
        { slotKey: 'lunch', amountCents: 1230, accountId: 'no-such-account', categoryId: null },
      ])
    ).rejects.toThrow();
    expect((await txnCount(db))?.n).toBe(0);
  });

  it('refuses two cells for the same slot in one submission', async () => {
    const { db, card } = await fixture();
    await expect(
      submitDay(db, '2026-10-20', [
        { slotKey: 'lunch', amountCents: 1230, accountId: card.id, categoryId: null },
        { slotKey: 'lunch', amountCents: 1400, accountId: card.id, categoryId: null },
      ])
    ).rejects.toThrow();
    expect((await txnCount(db))?.n).toBe(0);
  });

  it('rewrites an existing slot in place, amount, account and category included', async () => {
    const { db, card, water } = await fixture();
    const food = (await listCategories(db, 'expense')).find(c => c.name === '饮食')!;
    await submitDay(db, '2026-10-20', [
      { slotKey: 'shower', amountCents: 300, accountId: water.id, categoryId: null },
    ]);
    const written = await submitDay(db, '2026-10-20', [
      { slotKey: 'shower', amountCents: 450, accountId: card.id, categoryId: food.id },
    ]);
    expect(written).toBe(1);
    const rows = await listTxnsByMonth(db, '2026-10');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amountCents: -450,
      accountId: card.id,
      categoryId: food.id,
      slotKey: 'shower',
    });
  });

  it('counts an update as written, not as a skipped cell', async () => {
    const { db, card } = await fixture();
    const cells = [
      { slotKey: 'lunch', amountCents: 1230, accountId: card.id, categoryId: null },
      { slotKey: 'dinner', amountCents: 1060, accountId: card.id, categoryId: null },
    ];
    expect(await submitDay(db, '2026-10-20', cells)).toBe(2);
    expect(await submitDay(db, '2026-10-20', cells)).toBe(2);
    expect(await listTxnsByMonth(db, '2026-10')).toHaveLength(2);
  });

  it('keeps the same slot separate on another day', async () => {
    const { db, card } = await fixture();
    const cell = { slotKey: 'lunch', amountCents: 1230, accountId: card.id, categoryId: null };
    await submitDay(db, '2026-10-20', [cell]);
    await submitDay(db, '2026-10-21', [cell]);
    const rows = await listTxnsByMonth(db, '2026-10');
    expect(rows.map(r => r.occurredDate)).toEqual(['2026-10-21', '2026-10-20']);
  });

  it('never deletes or rewrites a row from a blank cell', async () => {
    const { db, card } = await fixture();
    await submitDay(db, '2026-10-20', [
      { slotKey: 'lunch', amountCents: 1230, accountId: card.id, categoryId: null },
    ]);
    const written = await submitDay(db, '2026-10-20', [
      { slotKey: 'lunch', amountCents: null, accountId: card.id, categoryId: null },
      { slotKey: 'dinner', amountCents: null, accountId: card.id, categoryId: null },
    ]);
    expect(written).toBe(0);
    const rows = await listTxnsByMonth(db, '2026-10');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amountCents).toBe(-1230);
  });

  it('does not treat a soft-deleted row as an existing slot', async () => {
    const { db, card } = await fixture();
    await submitDay(db, '2026-10-20', [
      { slotKey: 'lunch', amountCents: 1230, accountId: card.id, categoryId: null },
    ]);
    const first = (await listTxnsByMonth(db, '2026-10'))[0]!;
    await softDeleteTxn(db, first.id);

    const written = await submitDay(db, '2026-10-20', [
      { slotKey: 'lunch', amountCents: 1400, accountId: card.id, categoryId: null },
    ]);
    expect(written).toBe(1);
    const live = await listTxnsByMonth(db, '2026-10');
    expect(live).toHaveLength(1);
    expect(live[0]?.id).not.toBe(first.id);
    expect(live[0]?.amountCents).toBe(-1400);
    // The deleted row keeps its place in history.
    expect((await txnCount(db))?.n).toBe(2);
  });

  it('does not resurrect a soft-deleted row from a blank cell', async () => {
    const { db, card } = await fixture();
    await submitDay(db, '2026-10-20', [
      { slotKey: 'lunch', amountCents: 1230, accountId: card.id, categoryId: null },
    ]);
    const first = (await listTxnsByMonth(db, '2026-10'))[0]!;
    await softDeleteTxn(db, first.id);

    const written = await submitDay(db, '2026-10-20', [
      { slotKey: 'lunch', amountCents: null, accountId: card.id, categoryId: null },
    ]);
    expect(written).toBe(0);
    expect(await listTxnsByMonth(db, '2026-10')).toHaveLength(0);
    const row = await db.get<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM txn WHERE id = ?',
      [first.id]
    );
    expect(row?.deleted_at).not.toBeNull();
  });

  it('writes nothing at all for an all-blank day', async () => {
    const { db, card } = await fixture();
    const written = await submitDay(db, '2026-10-20', [
      { slotKey: 'breakfast', amountCents: null, accountId: card.id, categoryId: null },
      { slotKey: 'lunch', amountCents: null, accountId: card.id, categoryId: null },
    ]);
    expect(written).toBe(0);
    expect((await txnCount(db))?.n).toBe(0);
  });
});
