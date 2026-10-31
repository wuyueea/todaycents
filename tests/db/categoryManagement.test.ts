import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import {
  archiveCategory,
  countCategoryTxns,
  createCategory,
  deleteCategory,
  listCategories,
  renameCategory,
  unarchiveCategory,
  undoDeleteCategory,
} from '../../src/db/repos/categories';
import { createAccount } from '../../src/db/repos/accounts';
import { createExpense, softDeleteTxn } from '../../src/db/repos/txns';
import { seedDefaults } from '../../src/db/seed';

const SYSTEM_ID = 'uncategorized';
type TestDb = Awaited<ReturnType<typeof createTestDb>>;


describe('category management: rename and archive', () => {
  async function managementFixture() {
    const db = await createTestDb();
    const card = await createAccount(db, { name: '饭卡', type: 'prepaid' });
    const sport = await createCategory(db, { name: '运动', kind: 'expense' });
    const badminton = await createCategory(db, { name: '羽毛球', kind: 'expense', parentId: sport });
    const food = await createCategory(db, { name: '饮食', kind: 'expense' });
    const spend = (date: string, categoryId: string) =>
      createExpense(db, { date, accountId: card, amountCents: 1000, categoryId });
    return { db, card, sport, badminton, food, spend };
  }

  it('renames a user category with trim and leaves its transactions untouched', async () => {
    const { db, sport, spend } = await managementFixture();
    const txn = await spend('2026-10-01', sport);

    await renameCategory(db, sport, '  体育  ');

    expect((await listCategories(db)).find(category => category.id === sport)?.name).toBe('体育');
    const row = await db.get<{ category_id: string | null }>(
      'SELECT category_id FROM txn WHERE id = ?',
      [txn]
    );
    expect(row?.category_id).toBe(sport);
  });

  it('rejects a blank name and a category that does not exist', async () => {
    const { db, sport } = await managementFixture();

    await expect(renameCategory(db, sport, '   ')).rejects.toThrow(/不能为空/);
    await expect(renameCategory(db, 'missing-category', 'x')).rejects.toThrow(/不存在/);

    expect((await listCategories(db)).find(category => category.id === sport)?.name).toBe('运动');
  });

  it('refuses to rename the system category', async () => {
    const db = await createTestDb();

    await expect(renameCategory(db, SYSTEM_ID, '其他')).rejects.toThrow(/系统分类/);
    expect(
      (await db.get<{ name: string }>('SELECT name FROM category WHERE id = ?', [SYSTEM_ID]))?.name
    ).toBe('未分类');
  });

  it('archives a category out of the live list without deleting the row, then restores it', async () => {
    const { db, sport } = await managementFixture();

    await archiveCategory(db, sport);

    expect((await listCategories(db)).some(category => category.id === sport)).toBe(false);
    const archived = await db.get<{ archived_at: string | null }>(
      'SELECT archived_at FROM category WHERE id = ?',
      [sport]
    );
    expect(archived?.archived_at).not.toBeNull();

    await unarchiveCategory(db, sport);

    expect((await listCategories(db)).some(category => category.id === sport)).toBe(true);
    expect(
      (await db.get<{ archived_at: string | null }>(
        'SELECT archived_at FROM category WHERE id = ?',
        [sport]
      ))?.archived_at
    ).toBeNull();
  });

  it('refuses to archive the system category', async () => {
    const db = await createTestDb();

    await expect(archiveCategory(db, SYSTEM_ID)).rejects.toThrow(/系统分类/);
    expect(
      (await db.get<{ archived_at: string | null }>(
        'SELECT archived_at FROM category WHERE id = ?',
        [SYSTEM_ID]
      ))?.archived_at
    ).toBeNull();
  });
});

describe('category management: delete with reflow', () => {
  it('moves live rows of the category and its children to 未分类, then soft-deletes both rows', async () => {
    const { db, sport, badminton, food } = await categoryDeleteFixture();

    const rootTxn = await expenseIn(db, sport, '2026-10-01');
    const childTxn = await expenseIn(db, badminton, '2026-10-02');
    const deletedChildTxn = await expenseIn(db, badminton, '2026-10-03');
    await softDeleteTxn(db, deletedChildTxn);
    const otherTxn = await expenseIn(db, food, '2026-10-04');

    const result = await deleteCategory(db, sport);
    expect(result.movedTxns).toBe(2);
    // Each move remembers where the row came from, so undo can put it back.
    expect(result.moves).toEqual(
      expect.arrayContaining([
        { txnId: rootTxn, categoryId: sport },
        { txnId: childTxn, categoryId: badminton },
      ])
    );
    expect(result.moves).toHaveLength(2);
    expect(await countCategoryTxns(db, sport)).toBe(0);

    const rows = await db.all<{
      id: string;
      category_id: string | null;
      deleted_at: string | null;
    }>('SELECT id, category_id, deleted_at FROM txn');
    const byId = new Map(rows.map(row => [row.id, row]));
    expect(byId.get(rootTxn)?.category_id).toBe(SYSTEM_ID);
    expect(byId.get(childTxn)?.category_id).toBe(SYSTEM_ID);
    // A soft-deleted row is history, not a live transaction: it keeps its tag
    // to the deleted category and is not counted in movedTxns.
    expect(byId.get(deletedChildTxn)?.category_id).toBe(badminton);
    expect(byId.get(otherTxn)?.category_id).toBe(food);

    const categories = await db.all<{ id: string; archived_at: string | null }>(
      'SELECT id, archived_at FROM category WHERE id IN (?, ?)',
      [sport, badminton]
    );
    expect(categories).toHaveLength(2); // soft delete only: both rows still exist
    expect(categories.every(category => category.archived_at !== null)).toBe(true);
    expect(
      (await listCategories(db)).some(category => category.id === sport || category.id === badminton)
    ).toBe(false);
  });

  it('succeeds with zero moved rows when the category has no transactions', async () => {
    const { db, sport } = await categoryDeleteFixture();

    const result = await deleteCategory(db, sport);
    expect(result.movedTxns).toBe(0);
    expect(result.moves).toEqual([]);

    const row = await db.get<{ archived_at: string | null }>(
      'SELECT archived_at FROM category WHERE id = ?',
      [sport]
    );
    expect(row?.archived_at).not.toBeNull();
    expect(await db.all('SELECT id FROM category WHERE id = ?', [sport])).toHaveLength(1);
  });

  it('rolls the reflow back when archiving fails inside its transaction', async () => {
    const { db, sport } = await categoryDeleteFixture();
    const txn = await expenseIn(db, sport, '2026-10-01');

    const originalRun = db.run.bind(db);
    let injected = false;
    db.run = async (sql, params = []) => {
      if (injected && sql.includes('UPDATE category SET archived_at')) {
        injected = false;
        throw new Error('injected failure');
      }
      return originalRun(sql, params);
    };

    try {
      injected = true;
      await expect(deleteCategory(db, sport)).rejects.toThrow('injected failure');

      const txnRow = await db.get<{ category_id: string | null }>(
        'SELECT category_id FROM txn WHERE id = ?',
        [txn]
      );
      const categoryRow = await db.get<{ archived_at: string | null }>(
        'SELECT archived_at FROM category WHERE id = ?',
        [sport]
      );
      expect(txnRow?.category_id).toBe(sport);
      expect(categoryRow?.archived_at).toBeNull();
    } finally {
      db.run = originalRun;
    }
  });

  it('rejects the system category, a missing category and writes nothing', async () => {
    const { db } = await categoryDeleteFixture();

    await expect(deleteCategory(db, SYSTEM_ID)).rejects.toThrow(/系统分类/);
    await expect(deleteCategory(db, 'missing-category')).rejects.toThrow(/不存在/);

    expect(
      (await db.get<{ archived_at: string | null }>(
        'SELECT archived_at FROM category WHERE id = ?',
        [SYSTEM_ID]
      ))?.archived_at
    ).toBeNull();
  });
});

describe('category management: undo delete', () => {
  it('moves the reported rows back to the category and clears its archived_at', async () => {
    const { db, sport, badminton } = await categoryDeleteFixture();
    const rootTxn = await expenseIn(db, sport, '2026-10-01');
    const childTxn = await expenseIn(db, badminton, '2026-10-02');

    const result = await deleteCategory(db, sport);
    expect(await countCategoryTxns(db, sport)).toBe(0);

    await undoDeleteCategory(db, sport, result.moves);

    const rows = await db.all<{ id: string; category_id: string | null }>(
      'SELECT id, category_id FROM txn ORDER BY id'
    );
    const byId = new Map(rows.map(row => [row.id, row]));
    // Each row goes back to the category it actually came from: the child's
    // transaction returns to the child, not to the deleted parent.
    expect(byId.get(rootTxn)?.category_id).toBe(sport);
    expect(byId.get(childTxn)?.category_id).toBe(badminton);
    expect(
      (await listCategories(db)).find(category => category.id === sport)?.archivedAt
    ).toBeNull();
    expect(
      (await listCategories(db)).find(category => category.id === badminton)?.archivedAt
    ).toBeNull();
    // countCategoryTxns counts the subtree, so 运动 sees its own row plus the
    // child's; the child's row is back under the child, which is the point.
    expect(await countCategoryTxns(db, sport)).toBe(2);
    expect(await countCategoryTxns(db, badminton)).toBe(1);
  });

  it('leaves a row alone when it has since been moved to another category', async () => {
    const { db, sport, food } = await categoryDeleteFixture();
    const moved = await expenseIn(db, sport, '2026-10-01');
    const result = await deleteCategory(db, sport);

    await db.run('UPDATE txn SET category_id = ? WHERE id = ?', [food, moved]);
    await undoDeleteCategory(db, sport, result.moves);

    expect(
      (await db.get<{ category_id: string | null }>('SELECT category_id FROM txn WHERE id = ?', [
        moved,
      ]))?.category_id
    ).toBe(food);
  });

  it('rolls the row move back when unarchiving fails inside its transaction', async () => {
    const { db, sport } = await categoryDeleteFixture();
    const txn = await expenseIn(db, sport, '2026-10-01');
    const result = await deleteCategory(db, sport);

    const originalRun = db.run.bind(db);
    let injected = false;
    db.run = async (sql, params = []) => {
      if (injected && sql.includes('SET archived_at = NULL')) {
        injected = false;
        throw new Error('injected undo failure');
      }
      return originalRun(sql, params);
    };

    try {
      injected = true;
      await expect(undoDeleteCategory(db, sport, result.moves)).rejects.toThrow(
        'injected undo failure'
      );

      const txnRow = await db.get<{ category_id: string | null }>(
        'SELECT category_id FROM txn WHERE id = ?',
        [txn]
      );
      const categoryRow = await db.get<{ archived_at: string | null }>(
        'SELECT archived_at FROM category WHERE id = ?',
        [sport]
      );
      expect(txnRow?.category_id).toBe(SYSTEM_ID);
      expect(categoryRow?.archived_at).not.toBeNull();
    } finally {
      db.run = originalRun;
    }
  });
});

describe('system category ordering', () => {
  it('stays last when a new root category is appended after the seed', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    const fresh = await createCategory(db, { name: '新领域', kind: 'expense' });

    const expense = await listCategories(db, 'expense');

    expect(expense.some(category => category.id === fresh)).toBe(true);
    expect(expense.at(-1)).toMatchObject({ id: SYSTEM_ID, name: '未分类' });
  });
});

async function categoryDeleteFixture() {
  const db = await createTestDb();
  await createAccount(db, { name: '饭卡', type: 'prepaid' });
  const sport = await createCategory(db, { name: '运动', kind: 'expense' });
  const badminton = await createCategory(db, { name: '羽毛球', kind: 'expense', parentId: sport });
  const food = await createCategory(db, { name: '饮食', kind: 'expense' });
  return { db, sport, badminton, food };
}

async function expenseIn(db: TestDb, categoryId: string, date: string): Promise<string> {
  const account = await db.get<{ id: string }>('SELECT id FROM account LIMIT 1');
  if (account === undefined) throw new Error('fixture has no account');
  return createExpense(db, { date, accountId: account.id, amountCents: 1000, categoryId });
}
