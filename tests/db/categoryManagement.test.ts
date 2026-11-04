import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import {
  archiveCategory,
  archiveCategoryWithUnlink,
  createCategory,
  inspectCategoryPurge,
  listCategories,
  purgeCategory,
  renameCategory,
  unarchiveCategory,
} from '../../src/db/repos/categories';
import { readPurgeUndo, undoPurge } from '../../src/db/repos/purge';
import { createAccount } from '../../src/db/repos/accounts';
import { createExpense, softDeleteTxn } from '../../src/db/repos/txns';
import { upsertTemplate } from '../../src/db/repos/templates';
import { seedDefaults } from '../../src/db/seed';

const SYSTEM_ID = 'uncategorized';
type TestDb = Awaited<ReturnType<typeof createTestDb>>;

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

async function purgeUndoCount(db: TestDb): Promise<number> {
  const row = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM purge_undo');
  return row?.count ?? 0;
}

async function hintIn(db: TestDb, categoryId: string): Promise<void> {
  await db.run(
    `INSERT INTO recurring_hint
       (id, category_id, payee, status, monthly_cents, last_date, next_date, occurrences, detected_at)
     VALUES (?, ?, NULL, 'dismissed', 1000, '2026-01-01', '2026-02-01', 1, ?)`,
    ['hint-1', categoryId, '2026-01-02T00:00:00.000Z']
  );
}

describe('category management: rename and archive', () => {
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

describe('category management: inspect before a purge', () => {
  it('counts the live, deleted and child rows a retirement would touch', async () => {
    const { db, sport, badminton, spend } = await managementFixture();
    await spend('2026-10-01', sport);
    await spend('2026-10-02', badminton);
    const deleted = await spend('2026-10-03', badminton);
    await softDeleteTxn(db, deleted);

    expect(await inspectCategoryPurge(db, sport)).toEqual({
      purgeable: false,
      archived: false,
      liveTxnCount: 2,
      txnCount: 3,
      deletedTxnCount: 1,
      templateCount: 0,
      liveChildCount: 1,
      childCount: 1,
      hintCount: 0,
    });
  });

  it('counts a soft-deleted transaction as history even when nothing is live', async () => {
    const { db, sport, badminton, spend } = await managementFixture();
    const deleted = await spend('2026-10-01', badminton);
    await softDeleteTxn(db, deleted);
    await archiveCategory(db, badminton);
    await archiveCategory(db, sport);

    const inspection = await inspectCategoryPurge(db, sport);

    expect(inspection).toMatchObject({
      purgeable: false,
      archived: true,
      liveTxnCount: 0,
      txnCount: 1,
      deletedTxnCount: 1,
    });
  });

  it('counts a template as history even when no transaction points at the category', async () => {
    const { db, sport } = await managementFixture();
    await upsertTemplate(db, {
      slotKey: 'lunch',
      label: '午餐',
      categoryId: sport,
      defaultAccountId: null,
      defaultAmountCents: null,
    });
    await archiveCategory(db, sport);

    expect(await inspectCategoryPurge(db, sport)).toMatchObject({
      purgeable: false,
      templateCount: 1,
    });
  });

  it('treats a live child as history but lets an archived child be purged with its parent', async () => {
    const { db, sport, badminton } = await managementFixture();
    await archiveCategory(db, sport);

    expect(await inspectCategoryPurge(db, sport)).toMatchObject({
      purgeable: false,
      liveChildCount: 1,
      childCount: 1,
    });

    await archiveCategory(db, badminton);

    expect(await inspectCategoryPurge(db, sport)).toMatchObject({
      purgeable: true,
      liveChildCount: 0,
      childCount: 1,
    });
  });

  it('is purgeable when archived with no history, counting the children and hints a purge removes', async () => {
    const { db, sport, badminton } = await managementFixture();
    await archiveCategory(db, badminton);
    await archiveCategory(db, sport);
    await hintIn(db, sport);

    expect(await inspectCategoryPurge(db, sport)).toEqual({
      purgeable: true,
      archived: true,
      liveTxnCount: 0,
      txnCount: 0,
      deletedTxnCount: 0,
      templateCount: 0,
      liveChildCount: 0,
      childCount: 1,
      hintCount: 1,
    });
  });

  it('never reports the system category as purgeable and rejects a missing id', async () => {
    const db = await createTestDb();

    expect(await inspectCategoryPurge(db, SYSTEM_ID)).toMatchObject({
      purgeable: false,
      archived: false,
    });
    await expect(inspectCategoryPurge(db, 'missing-category')).rejects.toThrow(/不存在/);
  });
});

describe('category management: 断联并归档', () => {
  it('moves live rows of the category and its children to 未分类, keeps deleted rows, archives both, and writes no undo', async () => {
    const { db, sport, badminton, food, spend } = await managementFixture();

    const rootTxn = await spend('2026-10-01', sport);
    const childTxn = await spend('2026-10-02', badminton);
    const deletedChildTxn = await spend('2026-10-03', badminton);
    await softDeleteTxn(db, deletedChildTxn);
    const otherTxn = await spend('2026-10-04', food);

    const result = await archiveCategoryWithUnlink(db, sport);
    expect(result).toEqual({ movedTxns: 2, archivedChildCount: 1 });
    expect(await purgeUndoCount(db)).toBe(0);

    const rows = await db.all<{
      id: string;
      category_id: string | null;
      deleted_at: string | null;
    }>('SELECT id, category_id, deleted_at FROM txn');
    const byId = new Map(rows.map(row => [row.id, row]));
    expect(byId.get(rootTxn)?.category_id).toBe(SYSTEM_ID);
    expect(byId.get(childTxn)?.category_id).toBe(SYSTEM_ID);
    // A soft-deleted row is history, not a live transaction: it keeps its
    // category and is not counted in movedTxns.
    expect(byId.get(deletedChildTxn)?.category_id).toBe(badminton);
    expect(byId.get(otherTxn)?.category_id).toBe(food);

    const categories = await db.all<{ id: string; archived_at: string | null }>(
      'SELECT id, archived_at FROM category WHERE id IN (?, ?)',
      [sport, badminton]
    );
    expect(categories).toHaveLength(2);
    expect(categories.every(category => category.archived_at !== null)).toBe(true);
    expect(
      (await listCategories(db)).some(category => category.id === sport || category.id === badminton)
    ).toBe(false);
  });

  it('succeeds with zero moved rows and still archives the category', async () => {
    const { db, sport, badminton } = await managementFixture();
    await archiveCategory(db, badminton);

    const result = await archiveCategoryWithUnlink(db, sport);

    expect(result).toEqual({ movedTxns: 0, archivedChildCount: 0 });
    expect(
      (await db.get<{ archived_at: string | null }>(
        'SELECT archived_at FROM category WHERE id = ?',
        [sport]
      ))?.archived_at
    ).not.toBeNull();
  });

  it('rolls the reflow back when archiving fails inside its transaction', async () => {
    const { db, sport } = await managementFixture();
    const txn = await spendIn(db, sport, '2026-10-01');

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
      await expect(archiveCategoryWithUnlink(db, sport)).rejects.toThrow('injected failure');

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

  it('rejects the system category and a missing category without writing anything', async () => {
    const { db } = await managementFixture();

    await expect(archiveCategoryWithUnlink(db, SYSTEM_ID)).rejects.toThrow(/系统分类/);
    await expect(archiveCategoryWithUnlink(db, 'missing-category')).rejects.toThrow(/不存在/);

    expect(
      (await db.get<{ archived_at: string | null }>(
        'SELECT archived_at FROM category WHERE id = ?',
        [SYSTEM_ID]
      ))?.archived_at
    ).toBeNull();
  });
});

describe('category management: 彻底删除', () => {
  it('removes the archived root, its archived child and its hints, then undo restores all of them as archived', async () => {
    const { db, sport, badminton } = await managementFixture();
    await archiveCategory(db, badminton);
    await archiveCategory(db, sport);
    await hintIn(db, sport);

    const result = await purgeCategory(db, sport);

    expect(result.deletedChildren).toBe(1);
    expect(result.undo).toMatchObject({ kind: 'category', targetId: sport, label: '运动' });
    expect(await db.all('SELECT id FROM category WHERE id IN (?, ?)', [sport, badminton])).toEqual([]);
    expect(await db.all('SELECT id FROM recurring_hint')).toEqual([]);
    expect(await readPurgeUndo(db)).toMatchObject({
      kind: 'category',
      targetId: sport,
      label: '运动',
      expiresAt: result.undo.expiresAt,
    });

    await undoPurge(db, {
      kind: 'category',
      targetId: sport,
      expiresAt: result.undo.expiresAt,
    });

    const restored = await db.all<{ id: string; archived_at: string | null }>(
      'SELECT id, archived_at FROM category WHERE id IN (?, ?) ORDER BY id',
      [sport, badminton]
    );
    expect(restored).toHaveLength(2);
    expect(restored.every(category => category.archived_at !== null)).toBe(true);
    expect(await db.all('SELECT id FROM recurring_hint')).toHaveLength(1);
    expect(await purgeUndoCount(db)).toBe(0);
  });

  it('undoes the purge of an archived child while its parent is still live', async () => {
    const { db, sport, badminton } = await managementFixture();
    await archiveCategory(db, badminton);
    const before = await db.get<{ archived_at: string | null }>(
      'SELECT archived_at FROM category WHERE id = ?',
      [badminton]
    );

    const result = await purgeCategory(db, badminton);

    expect(await db.all('SELECT id FROM category WHERE id = ?', [badminton])).toHaveLength(0);
    // The child's parent is outside the payload. A restart must still offer the
    // undo, so the parser has to accept that one external parent.
    expect(await readPurgeUndo(db)).toMatchObject({
      kind: 'category',
      targetId: badminton,
      label: '羽毛球',
      expiresAt: result.undo.expiresAt,
    });

    await undoPurge(db, {
      kind: 'category',
      targetId: badminton,
      expiresAt: result.undo.expiresAt,
    });

    expect(
      await db.get('SELECT parent_id, archived_at FROM category WHERE id = ?', [badminton])
    ).toEqual({ parent_id: sport, archived_at: before?.archived_at });
    expect(await db.all('SELECT id FROM category WHERE id = ?', [sport])).toHaveLength(1);
  });

  it('refuses an undo whose external parent is gone, is not a root, or has another kind', async () => {
    const { db, sport, badminton, food } = await managementFixture();
    await archiveCategory(db, badminton);
    const result = await purgeCategory(db, badminton);

    expect(await readPurgeUndo(db)).not.toBeNull();

    await db.run("UPDATE category SET kind = 'income' WHERE id = ?", [sport]);
    expect(await readPurgeUndo(db)).toBeNull();
    await expect(
      undoPurge(db, { kind: 'category', targetId: badminton, expiresAt: result.undo.expiresAt })
    ).rejects.toThrow('撤销记录已损坏');

    await db.run("UPDATE category SET kind = 'expense', parent_id = ? WHERE id = ?", [food, sport]);
    expect(await readPurgeUndo(db)).toBeNull();
    await expect(
      undoPurge(db, { kind: 'category', targetId: badminton, expiresAt: result.undo.expiresAt })
    ).rejects.toThrow('撤销记录已损坏');

    await db.run('DELETE FROM category WHERE id = ?', [sport]);
    expect(await readPurgeUndo(db)).toBeNull();
    await expect(
      undoPurge(db, { kind: 'category', targetId: badminton, expiresAt: result.undo.expiresAt })
    ).rejects.toThrow('撤销记录已损坏');
    expect(await db.all('SELECT id FROM category WHERE id = ?', [badminton])).toHaveLength(0);
  });

  it('rolls the deletion back when writing the undo row fails in the same transaction', async () => {
    const { db, food } = await managementFixture();
    await archiveCategory(db, food);

    const originalRun = db.run.bind(db);
    let injected = false;
    db.run = async (sql, params = []) => {
      if (injected && sql.includes('INSERT INTO purge_undo')) {
        injected = false;
        throw new Error('injected failure');
      }
      return originalRun(sql, params);
    };

    try {
      injected = true;
      await expect(purgeCategory(db, food)).rejects.toThrow('injected failure');

      expect(await db.all('SELECT id FROM category WHERE id = ?', [food])).toHaveLength(1);
      expect(await purgeUndoCount(db)).toBe(0);
    } finally {
      db.run = originalRun;
    }
  });

  it('refuses a live category and leaves it in place', async () => {
    const { db, sport } = await managementFixture();

    await expect(purgeCategory(db, sport)).rejects.toThrow('只有已归档的分类才能彻底删除');
    expect(await db.all('SELECT id FROM category WHERE id = ?', [sport])).toHaveLength(1);
    expect(await purgeUndoCount(db)).toBe(0);
  });

  it('refuses an archived category that still has history', async () => {
    const { db, sport, spend } = await managementFixture();
    const txn = await spend('2026-10-01', sport);
    await softDeleteTxn(db, txn);
    await archiveCategory(db, sport);

    await expect(purgeCategory(db, sport)).rejects.toThrow('这个分类还有历史，不能彻底删除');
    expect(await db.all('SELECT id FROM category WHERE id = ?', [sport])).toHaveLength(1);
    expect(await purgeUndoCount(db)).toBe(0);
  });

  it('refuses a parent with a live child', async () => {
    const { db, sport } = await managementFixture();
    await archiveCategory(db, sport);

    await expect(purgeCategory(db, sport)).rejects.toThrow('这个分类还有历史，不能彻底删除');
    expect(await db.all('SELECT id FROM category WHERE id IN (?, ?)', [sport, 'missing'])).toHaveLength(1);
  });

  it('keeps only the latest purge undoable when two happen inside the window', async () => {
    const { db, food } = await managementFixture();
    const extra = await createCategory(db, { name: '杂项', kind: 'expense' });
    await archiveCategory(db, food);
    await archiveCategory(db, extra);

    const first = await purgeCategory(db, food);
    const second = await purgeCategory(db, extra);

    expect(await readPurgeUndo(db)).toMatchObject({ targetId: extra });
    await expect(
      undoPurge(db, {
        kind: 'category',
        targetId: food,
        expiresAt: first.undo.expiresAt,
      })
    ).rejects.toThrow('撤销记录已更新');
    expect(await db.all('SELECT id FROM category WHERE id = ?', [extra])).toHaveLength(0);
    expect(second.undo.targetId).toBe(extra);
  });

  it('rejects the system category and a missing category', async () => {
    const db = await createTestDb();

    await expect(purgeCategory(db, SYSTEM_ID)).rejects.toThrow(/系统分类/);
    await expect(purgeCategory(db, 'missing-category')).rejects.toThrow(/不存在/);
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

async function spendIn(db: TestDb, categoryId: string, date: string): Promise<string> {
  const account = await db.get<{ id: string }>('SELECT id FROM account LIMIT 1');
  if (account === undefined) throw new Error('fixture has no account');
  return createExpense(db, { date, accountId: account.id, amountCents: 1000, categoryId });
}
