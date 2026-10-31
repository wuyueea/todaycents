import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import {
  createAccount,
  listAccounts,
  updateAccount,
  archiveAccount,
  accountBalance,
  allBalances,
  reconcileAccountBalance,
  txnCountByAccount,
  unarchiveAccount,
} from '../../src/db/repos/accounts';
import { createExpense, listTxnsByMonth, softDeleteTxn } from '../../src/db/repos/txns';

describe('accounts', () => {
  it('creates and lists accounts with defaults', async () => {
    const db = await createTestDb();
    const id = await createAccount(db, { name: '饭卡', type: 'prepaid', monthlyBudgetCents: 75000 });
    const list = await listAccounts(db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, name: '饭卡', initialBalanceCents: 0, monthlyBudgetCents: 75000 });
  });
  it('balance equals initial plus sum of signed amounts', async () => {
    const db = await createTestDb();
    const id = await createAccount(db, { name: '饭卡', type: 'prepaid', initialBalanceCents: 10000 });
    await db.run(
      "INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, note, created_at) VALUES (?,?,?,?,?,?,?)",
      ['t1', '2026-10-01', id, -1250, 'expense', '', '2026-10-01T00:00:00']
    );
    expect(await accountBalance(db, id)).toBe(8750);
  });
  it('ignores soft-deleted rows', async () => {
    const db = await createTestDb();
    const id = await createAccount(db, { name: '饭卡', type: 'prepaid', initialBalanceCents: 0 });
    await db.run(
      "INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, note, created_at, deleted_at) VALUES (?,?,?,?,?,?,?,?)",
      ['t1', '2026-10-01', id, -1250, 'expense', '', '2026-10-01T00:00:00', '2026-10-02T00:00:00']
    );
    expect(await accountBalance(db, id)).toBe(0);
  });
  it('throws for an unknown account instead of reporting a zero balance', async () => {
    const db = await createTestDb();
    await expect(accountBalance(db, 'missing-account')).rejects.toThrow(/account not found/);
  });
});

describe('account defaults and ordering', () => {
  it('defaults missing balances and budget, and appends by sort', async () => {
    const db = await createTestDb();
    const first = await createAccount(db, { name: '现金', type: 'cash' });
    const second = await createAccount(db, { name: '银行卡', type: 'bank' });
    const third = await createAccount(db, { name: '微信', type: 'ewallet', sort: -3 });
    const fourth = await createAccount(db, { name: '饭卡', type: 'prepaid' });

    const byId = new Map((await listAccounts(db)).map(a => [a.id, a]));
    expect(byId.get(first)).toMatchObject({
      initialBalanceCents: 0,
      monthlyBudgetCents: null,
      sort: 0,
      archivedAt: null,
    });
    expect(byId.get(second)?.sort).toBe(1);
    expect(byId.get(third)?.sort).toBe(-3);
    expect(byId.get(fourth)?.sort).toBe(2);
    expect(byId.get(first)?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('counts archived rows when choosing the default sort', async () => {
    const db = await createTestDb();
    const archived = await createAccount(db, { name: '旧账户', type: 'cash' });
    await archiveAccount(db, archived);
    const next = await createAccount(db, { name: '新账户', type: 'cash' });
    const all = await listAccounts(db, { includeArchived: true });
    expect(all.find(a => a.id === next)?.sort).toBe(1);
  });

  it('orders by sort then created_at', async () => {
    const db = await createTestDb();
    const insert = (id: string, name: string, sort: number, createdAt: string) =>
      db.run(
        'INSERT INTO account (id, name, type, initial_balance_cents, monthly_budget_cents, sort, archived_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [id, name, 'cash', 0, null, sort, null, createdAt]
      );
    await insert('late', '晚', 5, '2026-10-02T00:00:00.000Z');
    await insert('early', '早', 5, '2026-10-01T00:00:00.000Z');
    await insert('first', '首', 1, '2026-10-03T00:00:00.000Z');
    expect((await listAccounts(db)).map(a => a.id)).toEqual(['first', 'early', 'late']);
  });
});

describe('archiveAccount', () => {
  it('hides archived accounts by default but keeps the row', async () => {
    const db = await createTestDb();
    const keep = await createAccount(db, { name: '现金', type: 'cash' });
    const gone = await createAccount(db, { name: '旧卡', type: 'prepaid' });
    await archiveAccount(db, gone);

    expect((await listAccounts(db)).map(a => a.id)).toEqual([keep]);
    const all = await listAccounts(db, { includeArchived: true });
    expect(all.map(a => a.id)).toEqual([keep, gone]);
    expect(all[1]?.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await db.get('SELECT id FROM account WHERE id = ?', [gone])).toBeDefined();
  });
});

describe('unarchiveAccount', () => {
  it('restores an archived account to the default list without touching its balance', async () => {
    const db = await createTestDb();
    const id = await createAccount(db, { name: '旧卡', type: 'prepaid', initialBalanceCents: 5000 });
    await createExpense(db, {
      date: '2026-10-01',
      accountId: id,
      amountCents: 1250,
      categoryId: null,
    });
    await archiveAccount(db, id);

    expect((await listAccounts(db)).map(account => account.id)).toEqual([]);
    expect((await listAccounts(db, { includeArchived: true })).map(account => account.id)).toEqual([
      id,
    ]);
    expect(await accountBalance(db, id)).toBe(3750);

    await unarchiveAccount(db, id);

    expect((await listAccounts(db)).map(account => account.id)).toEqual([id]);
    expect((await listAccounts(db, { includeArchived: true }))[0]?.archivedAt).toBeNull();
    expect(await accountBalance(db, id)).toBe(3750);
  });

  it('is idempotent on a live account', async () => {
    const db = await createTestDb();
    const id = await createAccount(db, { name: '现金', type: 'cash' });
    await unarchiveAccount(db, id);
    expect((await listAccounts(db))[0]?.archivedAt).toBeNull();
  });
});

describe('updateAccount', () => {
  it('applies only provided fields', async () => {
    const db = await createTestDb();
    const id = await createAccount(db, {
      name: '旧名',
      type: 'cash',
      initialBalanceCents: 500,
      monthlyBudgetCents: 1000,
      sort: 3,
    });
    await updateAccount(db, id, { name: '新名', monthlyBudgetCents: null });
    let account = (await listAccounts(db))[0];
    expect(account).toMatchObject({
      id,
      name: '新名',
      type: 'cash',
      initialBalanceCents: 500,
      monthlyBudgetCents: null,
      sort: 3,
    });

    await updateAccount(db, id, { type: 'bank', monthlyBudgetCents: 2500, sort: 9 });
    account = (await listAccounts(db))[0];
    expect(account).toMatchObject({ type: 'bank', monthlyBudgetCents: 2500, sort: 9, name: '新名' });

    await expect(updateAccount(db, id, {})).resolves.toBeUndefined();
  });
});

describe('opening balance correction', () => {
  it('changes the opening balance while the account has no transactions at all', async () => {
    const db = await createTestDb();
    const id = await createAccount(db, { name: '现金', type: 'cash', initialBalanceCents: 1000 });

    await updateAccount(db, id, { initialBalanceCents: 2500 });

    expect((await listAccounts(db))[0]?.initialBalanceCents).toBe(2500);
    expect(await accountBalance(db, id)).toBe(2500);
  });

  it('refuses once the account has a transaction, and a soft-deleted row still counts', async () => {
    const db = await createTestDb();
    const id = await createAccount(db, { name: '现金', type: 'cash', initialBalanceCents: 1000 });
    const expense = await createExpense(db, {
      date: '2026-10-20',
      accountId: id,
      amountCents: 300,
      categoryId: null,
    });

    await expect(updateAccount(db, id, { initialBalanceCents: 9999 })).rejects.toThrow(
      /transactions/
    );
    expect((await listAccounts(db))[0]?.initialBalanceCents).toBe(1000);

    await softDeleteTxn(db, expense);
    await expect(updateAccount(db, id, { initialBalanceCents: 9999 })).rejects.toThrow(
      /transactions/
    );
    expect((await listAccounts(db))[0]?.initialBalanceCents).toBe(1000);
  });

  it('still allows other fields to change on an account with transactions', async () => {
    const db = await createTestDb();
    const id = await createAccount(db, { name: '旧名', type: 'cash', initialBalanceCents: 1000 });
    await createExpense(db, {
      date: '2026-10-20',
      accountId: id,
      amountCents: 300,
      categoryId: null,
    });

    await updateAccount(db, id, { name: '新名', monthlyBudgetCents: 5000 });
    expect((await listAccounts(db))[0]).toMatchObject({
      name: '新名',
      monthlyBudgetCents: 5000,
      initialBalanceCents: 1000,
    });
  });
});

describe('txnCountByAccount', () => {
  it('counts live and soft-deleted rows, because either one freezes the opening balance', async () => {
    const db = await createTestDb();
    const first = await createAccount(db, { name: '现金', type: 'cash' });
    const second = await createAccount(db, { name: '银行卡', type: 'bank' });
    await createExpense(db, {
      date: '2026-10-20',
      accountId: first,
      amountCents: 300,
      categoryId: null,
    });
    const gone = await createExpense(db, {
      date: '2026-10-21',
      accountId: first,
      amountCents: 400,
      categoryId: null,
    });
    await softDeleteTxn(db, gone);

    expect(await txnCountByAccount(db)).toEqual({ [first]: 2 });
    expect(await txnCountByAccount(db)).not.toHaveProperty(second);
  });
});

describe('reconcileAccountBalance', () => {
  it('asks the repository for the balance, writes one adjustment for the exact delta, and stops at zero', async () => {
    const db = await createTestDb();
    const id = await createAccount(db, { name: '饭卡', type: 'prepaid', initialBalanceCents: 10000 });
    await createExpense(db, {
      date: '2026-10-20',
      accountId: id,
      amountCents: 1250,
      categoryId: null,
    });
    expect(await accountBalance(db, id)).toBe(8750);

    const result = await reconcileAccountBalance(db, {
      date: '2026-10-21',
      accountId: id,
      actualBalanceCents: 9000,
    });

    expect(result.deltaCents).toBe(250);
    expect(result.adjustmentId).not.toBeNull();
    expect(await accountBalance(db, id)).toBe(9000);
    const adjustments = (await listTxnsByMonth(db, '2026-10')).filter(
      row => row.direction === 'adjust'
    );
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toMatchObject({ amountCents: 250, note: '对账差额', categoryId: null });

    const matched = await reconcileAccountBalance(db, {
      date: '2026-10-21',
      accountId: id,
      actualBalanceCents: 9000,
    });
    expect(matched).toEqual({ deltaCents: 0, adjustmentId: null });
    expect(
      (await listTxnsByMonth(db, '2026-10')).filter(row => row.direction === 'adjust')
    ).toHaveLength(1);
  });

  it('writes the negative delta when the real balance is lower', async () => {
    const db = await createTestDb();
    const id = await createAccount(db, { name: '饭卡', type: 'prepaid', initialBalanceCents: 10000 });

    const result = await reconcileAccountBalance(db, {
      date: '2026-10-21',
      accountId: id,
      actualBalanceCents: 0,
    });

    expect(result.deltaCents).toBe(-10000);
    expect(await accountBalance(db, id)).toBe(0);
  });
});

describe('allBalances', () => {
  it('returns a balance for every account, archived included', async () => {
    const db = await createTestDb();
    const cash = await createAccount(db, { name: '现金', type: 'cash', initialBalanceCents: 10000 });
    const card = await createAccount(db, { name: '饭卡', type: 'prepaid' });
    const empty = await createAccount(db, { name: '空账户', type: 'bank', initialBalanceCents: 42 });
    const insertTxn = (id: string, accountId: string, amountCents: number) =>
      db.run(
        "INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, note, created_at) VALUES (?,?,?,?,?,?,?)",
        [id, '2026-10-01', accountId, amountCents, amountCents < 0 ? 'expense' : 'income', '', '2026-10-01T00:00:00']
      );
    await insertTxn('t-cash', cash, -1250);
    await insertTxn('t-card', card, 5000);
    await archiveAccount(db, card);

    expect(await allBalances(db)).toEqual({ [cash]: 8750, [card]: 5000, [empty]: 42 });
  });
});

describe('integer cents', () => {
  it('rejects fractional money values', async () => {
    const db = await createTestDb();
    await expect(
      createAccount(db, { name: '坏账户', type: 'cash', initialBalanceCents: 10.5 })
    ).rejects.toThrow(RangeError);
    await expect(
      createAccount(db, { name: '坏账户', type: 'cash', monthlyBudgetCents: Number.NaN })
    ).rejects.toThrow(RangeError);
    const id = await createAccount(db, { name: '好账户', type: 'cash' });
    await expect(updateAccount(db, id, { monthlyBudgetCents: 1.5 })).rejects.toThrow(RangeError);
  });
});

describe('foreign keys', () => {
  it('enforces account_id references in the test driver', async () => {
    const db = await createTestDb();
    const row = await db.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(row?.foreign_keys).toBe(1);
    await expect(
      db.run(
        "INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, note, created_at) VALUES (?,?,?,?,?,?,?)",
        ['t-fk', '2026-10-01', 'missing-account', -1, 'expense', '', '2026-10-01T00:00:00']
      )
    ).rejects.toThrow();
  });
});
