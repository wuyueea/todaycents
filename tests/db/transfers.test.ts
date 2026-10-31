import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import { createAccount, accountBalance } from '../../src/db/repos/accounts';
import { createTransfer, deleteTransfer, monthExpenseTotal } from '../../src/db/repos/transfers';

describe('transfers', () => {
  it('moves balance without counting as expense', async () => {
    const db = await createTestDb();
    const bank = await createAccount(db, { name: '银行卡', type: 'bank', initialBalanceCents: 100000 });
    const card = await createAccount(db, { name: '饭卡', type: 'prepaid', initialBalanceCents: 0 });
    await createTransfer(db, { date: '2026-10-05', fromAccountId: bank, toAccountId: card, amountCents: 60000 });
    expect(await accountBalance(db, bank)).toBe(40000);
    expect(await accountBalance(db, card)).toBe(60000);
    expect(await monthExpenseTotal(db, '2026-10')).toBe(0);
  });
  it('rejects same-account and non-positive transfers', async () => {
    const db = await createTestDb();
    const a = await createAccount(db, { name: 'A', type: 'cash' });
    await expect(createTransfer(db, { date: '2026-10-05', fromAccountId: a, toAccountId: a, amountCents: 100 })).rejects.toThrow();
    const b = await createAccount(db, { name: 'B', type: 'cash' });
    await expect(createTransfer(db, { date: '2026-10-05', fromAccountId: a, toAccountId: b, amountCents: 0 })).rejects.toThrow();
  });
  it('deleting a transfer removes both legs and restores balances', async () => {
    const db = await createTestDb();
    const bank = await createAccount(db, { name: '银行卡', type: 'bank', initialBalanceCents: 100000 });
    const card = await createAccount(db, { name: '饭卡', type: 'prepaid', initialBalanceCents: 0 });
    const gid = await createTransfer(db, { date: '2026-10-05', fromAccountId: bank, toAccountId: card, amountCents: 60000 });
    await deleteTransfer(db, gid);
    expect(await accountBalance(db, bank)).toBe(100000);
    expect(await accountBalance(db, card)).toBe(0);
    const left = await db.all("SELECT id FROM txn WHERE transfer_group_id=? AND deleted_at IS NULL", [gid]);
    expect(left).toHaveLength(0);
  });
});

interface LegRow {
  id: string;
  occurred_date: string;
  account_id: string;
  amount_cents: number;
  direction: string;
  category_id: string | null;
  note: string;
  transfer_group_id: string | null;
  deleted_at: string | null;
}

const selectLegs = (db: Awaited<ReturnType<typeof createTestDb>>, groupId: string) =>
  db.all<LegRow>(
    `SELECT id, occurred_date, account_id, amount_cents, direction, category_id, note,
            transfer_group_id, deleted_at
     FROM txn WHERE transfer_group_id = ? ORDER BY amount_cents`,
    [groupId]
  );

describe('transfer legs', () => {
  it('writes one negative and one positive leg sharing group, date and null category', async () => {
    const db = await createTestDb();
    const bank = await createAccount(db, { name: '银行卡', type: 'bank', initialBalanceCents: 100000 });
    const card = await createAccount(db, { name: '饭卡', type: 'prepaid' });
    const gid = await createTransfer(db, {
      date: '2026-10-05',
      fromAccountId: bank,
      toAccountId: card,
      amountCents: 60000,
      note: '转饭卡',
    });

    const legs = await selectLegs(db, gid);
    expect(legs).toHaveLength(2);
    expect(legs.map((leg) => leg.amount_cents)).toEqual([-60000, 60000]);
    expect(legs.map((leg) => leg.account_id)).toEqual([bank, card]);
    for (const leg of legs) {
      expect(leg).toMatchObject({
        occurred_date: '2026-10-05',
        direction: 'transfer',
        category_id: null,
        note: '转饭卡',
        transfer_group_id: gid,
        deleted_at: null,
      });
    }
  });
});

describe('transfer atomicity', () => {
  it('leaves no rows when validation rejects the transfer', async () => {
    const db = await createTestDb();
    const a = await createAccount(db, { name: 'A', type: 'cash', initialBalanceCents: 10000 });
    const b = await createAccount(db, { name: 'B', type: 'cash' });

    await expect(
      createTransfer(db, { date: '2026-10-05', fromAccountId: a, toAccountId: a, amountCents: 100 })
    ).rejects.toThrow();
    await expect(
      createTransfer(db, { date: '2026-10-05', fromAccountId: a, toAccountId: b, amountCents: 0 })
    ).rejects.toThrow();
    await expect(
      createTransfer(db, { date: '2026-10-05', fromAccountId: a, toAccountId: b, amountCents: -700 })
    ).rejects.toThrow();
    await expect(
      createTransfer(db, { date: '2026-10-05', fromAccountId: a, toAccountId: b, amountCents: 10.5 })
    ).rejects.toThrow();

    const count = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM txn');
    expect(count?.n).toBe(0);
    expect(await accountBalance(db, a)).toBe(10000);
  });

  it('rolls back the source leg when the destination leg cannot be written', async () => {
    const db = await createTestDb();
    const a = await createAccount(db, { name: 'A', type: 'cash', initialBalanceCents: 10000 });

    await expect(
      createTransfer(db, {
        date: '2026-10-05',
        fromAccountId: a,
        toAccountId: 'missing-account',
        amountCents: 6000,
      })
    ).rejects.toThrow();

    const count = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM txn');
    expect(count?.n).toBe(0);
    expect(await accountBalance(db, a)).toBe(10000);
  });
});

describe('transfer date validation', () => {
  it('rejects a date that is not YYYY-MM-DD and writes no rows', async () => {
    const db = await createTestDb();
    const a = await createAccount(db, { name: 'A', type: 'cash', initialBalanceCents: 10000 });
    const b = await createAccount(db, { name: 'B', type: 'cash' });

    for (const date of ['2026-10-32', '2026/10/01', '2026-1-05', '']) {
      await expect(
        createTransfer(db, { date, fromAccountId: a, toAccountId: b, amountCents: 1000 })
      ).rejects.toThrow();
    }

    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM txn'))?.n).toBe(0);
    expect(await accountBalance(db, a)).toBe(10000);
    expect(await accountBalance(db, b)).toBe(0);
  });
});

describe('deleteTransfer', () => {
  it('is soft, idempotent and confined to its own group', async () => {
    const db = await createTestDb();
    const bank = await createAccount(db, { name: '银行卡', type: 'bank', initialBalanceCents: 100000 });
    const card = await createAccount(db, { name: '饭卡', type: 'prepaid' });
    const cash = await createAccount(db, { name: '现金', type: 'cash', initialBalanceCents: 5000 });

    const first = await createTransfer(db, {
      date: '2026-10-05',
      fromAccountId: bank,
      toAccountId: card,
      amountCents: 60000,
    });
    const second = await createTransfer(db, {
      date: '2026-10-06',
      fromAccountId: cash,
      toAccountId: card,
      amountCents: 2000,
    });
    await db.run(
      "INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, note, created_at) VALUES (?,?,?,?,?,?,?)",
      ['plain-expense', '2026-10-07', bank, -1500, 'expense', '午饭', '2026-10-07T00:00:00']
    );

    await deleteTransfer(db, first);
    const firstDeletedAt = (await selectLegs(db, first)).map((leg) => leg.deleted_at);
    await deleteTransfer(db, first); // must not throw and must not rewrite the timestamp

    const rows = await selectLegs(db, first);
    expect(rows).toHaveLength(2); // soft delete: rows are still physically present
    expect(rows.map((leg) => leg.deleted_at)).toEqual(firstDeletedAt);
    for (const row of rows) expect(row.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const untouched = await selectLegs(db, second);
    expect(untouched.map((leg) => leg.deleted_at)).toEqual([null, null]);
    const expense = await db.get<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM txn WHERE id = ?',
      ['plain-expense']
    );
    expect(expense?.deleted_at).toBeNull();

    // Bank: initial 100000, transfer out undone, but the plain 1500 expense stays.
    expect(await accountBalance(db, bank)).toBe(98500);
    expect(await accountBalance(db, card)).toBe(2000);
    expect(await accountBalance(db, cash)).toBe(3000);
    expect(await monthExpenseTotal(db, '2026-10')).toBe(1500);
  });
});

describe('monthExpenseTotal', () => {
  it('counts only live expense rows of the month', async () => {
    const db = await createTestDb();
    const bank = await createAccount(db, { name: '银行卡', type: 'bank', initialBalanceCents: 100000 });
    const card = await createAccount(db, { name: '饭卡', type: 'prepaid' });
    await createTransfer(db, {
      date: '2026-10-05',
      fromAccountId: bank,
      toAccountId: card,
      amountCents: 60000,
    });

    const insert = (id: string, date: string, amount: number, direction: string, deletedAt: string | null) =>
      db.run(
        `INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, note, created_at, deleted_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id, date, bank, amount, direction, '', `${date}T00:00:00`, deletedAt]
      );
    await insert('e1', '2026-10-02', -1200, 'expense', null);
    await insert('e2', '2026-10-31', -3050, 'expense', null);
    await insert('e3', '2026-10-15', -999, 'expense', '2026-10-16T00:00:00');
    await insert('a1', '2026-10-10', -400, 'adjust', null);
    await insert('i1', '2026-10-11', 8000, 'income', null);
    await insert('e4', '2026-11-01', -777, 'expense', null);

    expect(await monthExpenseTotal(db, '2026-10')).toBe(4250);
    expect(await monthExpenseTotal(db, '2026-11')).toBe(777);
    expect(await monthExpenseTotal(db, '2026-12')).toBe(0);
    expect(await monthExpenseTotal(db, '2025-10')).toBe(0);
  });
});
