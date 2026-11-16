import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import { failingDb } from '../helpers/failingDb';
import { accountBalance, createAccount, reconcileAccountBalance } from '../../src/db/repos/accounts';
import { createExpense, monthSummary, softDeleteTxn } from '../../src/db/repos/txns';
import { createTransfer, deleteTransfer } from '../../src/db/repos/transfers';
import type { Db } from '../../src/db/driver';

const DATE = '2026-10-20';
async function fixture() {
  const db = await createTestDb();
  const from = await createAccount(db, { name: '银行卡', type: 'bank', initialBalanceCents: 10000 });
  const to = await createAccount(db, { name: '现金', type: 'cash' });
  return { db, from, to };
}
function expense(db: Db, accountId: string) {
  return createExpense(db, { date: DATE, accountId, amountCents: 100, categoryId: null });
}
function transfer(db: Db, fromAccountId: string, toAccountId: string) {
  return createTransfer(db, { date: DATE, fromAccountId, toAccountId, amountCents: 300 });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function legs(db: Db, group: string) {
  return db.all<{ id: string; amount_cents: number; deleted_at: string | null }>(
    'SELECT id, amount_cents, deleted_at FROM txn WHERE transfer_group_id = ? ORDER BY amount_cents', [group]
  );
}

describe('deletion repository errors', () => {
  it('rejects a missing transaction without changing other rows or balances', async () => {
    const { db, from } = await fixture();
    const id = await expense(db, from);
    await expect(softDeleteTxn(db, 'missing')).rejects.toThrow('流水不存在');
    expect(await db.get('SELECT deleted_at FROM txn WHERE id = ?', [id])).toEqual({ deleted_at: null });
    expect(await accountBalance(db, from)).toBe(9900);
  });

  it('rejects a missing transfer group without touching an existing group', async () => {
    const { db, from, to } = await fixture();
    const group = await transfer(db, from, to);
    await expect(deleteTransfer(db, 'missing')).rejects.toThrow('转账不存在');
    expect((await legs(db, group)).map(row => row.deleted_at)).toEqual([null, null]);
    expect(await accountBalance(db, from)).toBe(9700);
    expect(await accountBalance(db, to)).toBe(300);
  });

  it('does not report success when SQLite ignores a transaction deletion', async () => {
    const { db, from } = await fixture();
    const id = await expense(db, from);
    await db.exec(`CREATE TRIGGER ignore_delete BEFORE UPDATE OF deleted_at ON txn
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(softDeleteTxn(db, id)).rejects.toThrow('删除流水失败');
    expect(await db.get('SELECT deleted_at FROM txn WHERE id = ?', [id])).toEqual({ deleted_at: null });
    expect(await accountBalance(db, from)).toBe(9900);
  });

  it('rolls back the whole transfer when only one leg was affected', async () => {
    const { db, from, to } = await fixture();
    const group = await transfer(db, from, to);
    await db.exec(`CREATE TRIGGER ignore_positive_leg BEFORE UPDATE OF deleted_at ON txn
      WHEN OLD.amount_cents > 0 BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(deleteTransfer(db, group)).rejects.toThrow('删除转账失败');
    expect((await legs(db, group)).map(row => row.deleted_at)).toEqual([null, null]);
    expect(await accountBalance(db, from)).toBe(9700);
    expect(await accountBalance(db, to)).toBe(300);
  });

  it('finishes a partially deleted group without rewriting the first leg timestamp', async () => {
    const { db, from, to } = await fixture();
    const group = await transfer(db, from, to);
    const stamp = '2026-10-21T00:00:00.000Z';
    await db.run('UPDATE txn SET deleted_at = ? WHERE transfer_group_id = ? AND amount_cents < 0', [stamp, group]);
    await deleteTransfer(db, group);
    const after = await legs(db, group);
    expect(after).toHaveLength(2);
    expect(after[0]!.deleted_at).toBe(stamp);
    expect(after[1]!.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await deleteTransfer(db, group);
    expect(await legs(db, group)).toEqual(after);
    expect(await accountBalance(db, from)).toBe(10000);
    expect(await accountBalance(db, to)).toBe(0);
  });

  it('keeps concurrent duplicate transaction deletions idempotent and physical rows intact', async () => {
    const { db, from } = await fixture();
    const id = await expense(db, from);
    await Promise.all([softDeleteTxn(db, id), softDeleteTxn(db, id)]);
    expect(await db.get('SELECT COUNT(*) AS n FROM txn')).toEqual({ n: 1 });
    expect(await accountBalance(db, from)).toBe(10000);
  });

  it('keeps concurrent duplicate transfer deletions idempotent', async () => {
    const { db, from, to } = await fixture();
    const group = await transfer(db, from, to);
    await Promise.all([deleteTransfer(db, group), deleteTransfer(db, group)]);
    const rows = await legs(db, group);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.deleted_at).toBe(rows[1]!.deleted_at);
    expect(rows[0]!.deleted_at).not.toBeNull();
    expect(await accountBalance(db, from)).toBe(10000);
    expect(await accountBalance(db, to)).toBe(0);
  });

  it.each(['transaction', 'transfer'])('joins an outer transaction so a later failure restores the %s', async kind => {
    const { db, from, to } = await fixture();
    const id = kind === 'transaction' ? await expense(db, from) : await transfer(db, from, to);
    await expect(db.transaction(async tx => {
      if (kind === 'transaction') await softDeleteTxn(tx, id);
      else await deleteTransfer(tx, id);
      throw new Error('later failure');
    })).rejects.toThrow('later failure');
    const rows = await db.all<{ deleted_at: string | null }>('SELECT deleted_at FROM txn');
    expect(rows).toHaveLength(kind === 'transaction' ? 1 : 2);
    expect(rows.every(row => row.deleted_at === null)).toBe(true);
  });
});

describe('reconciliation atomic balance calculation', () => {
  it('waits for an earlier expense before deciding whether an adjustment is needed', async () => {
    const { db, from } = await fixture();
    const started = deferred();
    const release = deferred();
    const saving = db.transaction(async tx => {
      started.resolve();
      await release.promise;
      await expense(tx, from);
    });
    await started.promise;
    const reconciling = reconcileAccountBalance(db, { date: DATE, accountId: from, actualBalanceCents: 10000 });
    release.resolve();
    await saving;
    expect(await reconciling).toMatchObject({ deltaCents: 100 });
    expect(await accountBalance(db, from)).toBe(10000);
    expect(await monthSummary(db, '2026-10')).toEqual({ expenseCents: 100, incomeCents: 0 });
  });

  it('two concurrent reconciliations to the same balance create only one adjustment', async () => {
    const { db, from } = await fixture();
    const input = { date: DATE, accountId: from, actualBalanceCents: 9000 };
    const results = await Promise.all([reconcileAccountBalance(db, input), reconcileAccountBalance(db, input)]);
    expect(results.map(result => result.deltaCents)).toEqual([-1000, 0]);
    expect(await accountBalance(db, from)).toBe(9000);
    expect(await db.get("SELECT COUNT(*) AS n FROM txn WHERE direction = 'adjust'")).toEqual({ n: 1 });
    expect(await monthSummary(db, '2026-10')).toEqual({ expenseCents: 0, incomeCents: 0 });
  });

  it('rolls back an adjustment when an enclosing operation later fails', async () => {
    const { db, from } = await fixture();
    await expect(db.transaction(async tx => {
      await reconcileAccountBalance(tx, { date: DATE, accountId: from, actualBalanceCents: 9000 });
      throw new Error('later failure');
    })).rejects.toThrow('later failure');
    expect(await accountBalance(db, from)).toBe(10000);
    expect(await db.get('SELECT COUNT(*) AS n FROM txn')).toEqual({ n: 0 });
  });

  it('propagates adjustment write failure and releases the queue for the next reconciliation', async () => {
    const { db, from } = await fixture();
    const failing = failingDb(db, sql => /INSERT INTO txn/.test(sql), 'disk full');
    const input = { date: DATE, accountId: from, actualBalanceCents: 9000 };
    await expect(reconcileAccountBalance(failing, input)).rejects.toThrow('disk full');
    expect(await accountBalance(db, from)).toBe(10000);
    expect(await db.get('SELECT COUNT(*) AS n FROM txn')).toEqual({ n: 0 });
    expect(await reconcileAccountBalance(db, input)).toMatchObject({ deltaCents: -1000 });
    expect(await accountBalance(db, from)).toBe(9000);
  });

  it('rejects a missing account without adding an adjustment', async () => {
    const { db, from } = await fixture();
    await expect(reconcileAccountBalance(db, { date: DATE, accountId: 'missing', actualBalanceCents: 0 })).rejects.toThrow('account not found');
    expect(await db.get('SELECT COUNT(*) AS n FROM txn')).toEqual({ n: 0 });
    expect(await accountBalance(db, from)).toBe(10000);
  });
});
