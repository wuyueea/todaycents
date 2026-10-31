import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/driver';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';
import { readResetCounts, resetLedger } from '../../src/db/reset';
import { archiveAccount, createAccount } from '../../src/db/repos/accounts';
import { createCategory, listCategories } from '../../src/db/repos/categories';
import { createExpense, createIncome, softDeleteTxn } from '../../src/db/repos/txns';
import { createTransfer } from '../../src/db/repos/transfers';
import { archiveProject, createProject, setTxnProject } from '../../src/db/repos/projects';
import { archiveTag, createTag, setTxnTags } from '../../src/db/repos/tags';
import { UNCATEGORIZED_CATEGORY_ID } from '../../src/db/schema';

/** The nine ledger tables, in foreign-key order. schema_migrations is separate. */
const TABLES = [
  'account',
  'category',
  'tag',
  'project',
  'recurring_hint',
  'template',
  'txn',
  'txn_tag',
  'app_meta',
] as const;

async function tableCounts(db: Db): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of TABLES) {
    const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    result[table] = row?.n ?? 0;
  }
  return result;
}

/** Every row of every table plus the migration log, in rowid order. */
async function snapshot(db: Db): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    result[table] = await db.all<unknown>(`SELECT * FROM ${table} ORDER BY rowid`);
  }
  result.schema_migrations = await db.all<unknown>(
    'SELECT version, applied_at FROM schema_migrations ORDER BY version'
  );
  return result;
}

/**
 * A database with something in every table, including an archived account, an
 * archived tag, an archived project, a child category, a transfer pair, a
 * soft-deleted row and a recurring hint. The reset has to remove all of it,
 * archived rows included.
 */
async function seedRichLedger(db: Db): Promise<void> {
  await seedDefaults(db);

  // 饭卡 is not a starter account any more; a prepaid account with a budget is
  // exactly what a real owner would add, so the fixture creates it explicitly.
  const cardId = await createAccount(db, {
    name: '饭卡',
    type: 'prepaid',
    monthlyBudgetCents: 75000,
  });
  const bank = await db.get<{ id: string }>("SELECT id FROM account WHERE name = '银行卡'");
  const food = await db.get<{ id: string }>("SELECT id FROM category WHERE name = '饮食'");
  if (bank === undefined || food === undefined) {
    throw new Error('seed fixture is incomplete');
  }

  // Archived on purpose: the reset deletes hidden rows too, and the counts say so.
  const spare = await createAccount(db, { name: '零钱', type: 'cash' });
  await archiveAccount(db, spare);

  // A second level exercises the category table's self-referencing foreign key.
  const child = await createCategory(db, {
    name: '早餐',
    kind: 'expense',
    parentId: food.id,
  });

  const expenseId = await createExpense(db, {
    date: '2026-10-20',
    accountId: cardId,
    amountCents: 1250,
    categoryId: child,
    note: '早饭',
  });
  await createIncome(db, {
    date: '2026-10-21',
    accountId: bank.id,
    amountCents: 300000,
    categoryId: null,
    note: '生活费',
  });
  await createTransfer(db, {
    date: '2026-10-22',
    fromAccountId: bank.id,
    toAccountId: cardId,
    amountCents: 50000,
    note: '充饭卡',
  });
  const deleted = await createExpense(db, {
    date: '2026-10-23',
    accountId: cardId,
    amountCents: 800,
    categoryId: null,
    note: '已删',
  });
  await softDeleteTxn(db, deleted);

  const project = await createProject(db, {
    name: '国庆去成都',
    budgetCents: 200000,
    startedDate: '2026-10-01',
  });
  await setTxnProject(db, expenseId, project);
  const finishedProject = await createProject(db, { name: '搬家' });
  await archiveProject(db, finishedProject);

  const liveTag = await createTag(db, '夜宵');
  const retiredTag = await createTag(db, '旧标签');
  await archiveTag(db, retiredTag);
  await setTxnTags(db, expenseId, [liveTag]);

  await db.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', [
    'last_backup_at',
    '2026-10-23T12:00:00+08:00',
  ]);
  await db.run(
    `INSERT INTO recurring_hint
       (id, category_id, payee, status, monthly_cents, last_date, next_date, occurrences, detected_at)
     VALUES ('hint-1', ?, NULL, 'dismissed', 5988, '2026-03-01', '2026-04-01', 3, ?)`,
    [food.id, '2026-03-02T00:00:00+08:00']
  );
}


describe('resetLedger', () => {
  it('empties every table and puts the starter accounts and categories back', async () => {
    const db = await createTestDb();
    await seedRichLedger(db);

    await resetLedger(db);

    // With foreign keys on (createTestDb turns them on) this also proves the
    // deletion order: a table deleted before its children would throw.
    expect(await tableCounts(db)).toEqual({
      // The starter set, exactly: three accounts, twelve categories and no
      // templates. Everything the fixture added is gone.
      account: 3,
      category: 13,
      tag: 0,
      project: 0,
      recurring_hint: 0,
      template: 0,
      txn: 0,
      txn_tag: 0,
      app_meta: 0,
    });

    // It equals a first launch, row for row: 清除所有数据 must not leave a
    // different starter set than the one a fresh install writes.
    const fresh = await createTestDb();
    await seedDefaults(fresh);
    const shapeOf = async (target: Db) => ({
      categories: await target.all<Record<string, unknown>>(
        'SELECT name, kind, sort, parent_id FROM category ORDER BY kind, sort, name'
      ),
      accounts: await target.all<Record<string, unknown>>(
        'SELECT name, type, initial_balance_cents, monthly_budget_cents, sort, archived_at FROM account ORDER BY sort'
      ),
    });
    expect(await shapeOf(db)).toEqual(await shapeOf(fresh));
  });

  it('leaves schema_migrations exactly as it was', async () => {
    const db = await createTestDb();
    const before = await db.all<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    await seedRichLedger(db);

    await resetLedger(db);

    const after = await db.all<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    expect(after).toEqual(before);
    expect(after.map(row => row.version)).toEqual([1, 2, 3, 4]);
  });

  it('keeps the system 未分类 category, still last among the expense rows', async () => {
    const db = await createTestDb();
    await seedRichLedger(db);

    await resetLedger(db);

    const system = await db.get<{
      id: string;
      parent_id: string | null;
      name: string;
      kind: string;
      sort: number;
      archived_at: string | null;
    }>('SELECT id, parent_id, name, kind, sort, archived_at FROM category WHERE id = ?', [
      UNCATEGORIZED_CATEGORY_ID,
    ]);
    expect(system).toEqual({
      id: 'uncategorized',
      parent_id: null,
      name: '未分类',
      kind: 'expense',
      sort: 9999,
      archived_at: null,
    });

    const expense = await listCategories(db, 'expense');
    expect(expense.at(-1)).toMatchObject({ id: UNCATEGORIZED_CATEGORY_ID, name: '未分类' });
    expect(expense).toHaveLength(10);
  });

  it('can run twice without appending a second starter set', async () => {
    const db = await createTestDb();
    await seedRichLedger(db);

    await resetLedger(db);
    await resetLedger(db);

    expect(await tableCounts(db)).toEqual({
      account: 3,
      category: 13,
      tag: 0,
      project: 0,
      recurring_hint: 0,
      template: 0,
      txn: 0,
      txn_tag: 0,
      app_meta: 0,
    });
  });

  it('rolls every table back when the seeds cannot finish', async () => {
    const db = await createTestDb();
    await seedRichLedger(db);
    const before = await snapshot(db);

    // The deletes have already run when this trigger fires on the seed's first
    // account insert — after the system category and the twelve seeded roots —
    // so only the transaction can put the ledger back.
    await db.exec(
      `CREATE TRIGGER reset_interrupted BEFORE INSERT ON account
       BEGIN SELECT RAISE(ABORT, 'reset interrupted'); END`
    );

    await expect(resetLedger(db)).rejects.toThrow(/reset interrupted/);

    expect(await snapshot(db)).toEqual(before);
    await db.exec('DROP TRIGGER reset_interrupted');
  });
});

describe('readResetCounts', () => {
  it('counts every row the wipe removes, archived ones included', async () => {
    const db = await createTestDb();
    await seedRichLedger(db);

    expect(await readResetCounts(db)).toEqual({
      txn: 5,
      account: 5,
      category: 13,
      tag: 2,
      project: 2,
    });
  });

  it('counts the accounts and categories of a fresh install as about to disappear', async () => {
    const db = await createTestDb();
    await seedDefaults(db);

    expect(await readResetCounts(db)).toEqual({
      txn: 0,
      account: 3,
      category: 12,
      tag: 0,
      project: 0,
    });
  });
});
