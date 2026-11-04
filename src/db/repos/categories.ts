import type { Db, DbParam } from '../driver';
import { newId } from '../id';
import type { PurgeUndoRecord } from './purge';
import { PURGE_UNDO_MS, writePurgeUndo } from './purge';
import {
  UNCATEGORIZED_CATEGORY_ID,
  UNCATEGORIZED_CATEGORY_NAME,
} from '../schema';

/** The two kinds a category can belong to; mirrors the v1 category.kind CHECK. */
export type CategoryKind = 'expense' | 'income';

/**
 * A category. The tree is at most two levels deep, so parentId either points
 * at a root or is null; a row whose parentId points at another child would be
 * a third level and is rejected at creation time, never stored.
 */
export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  kind: CategoryKind;
  sort: number;
  archivedAt: string | null;
}

/** Everything createCategory needs. Omit parentId to create a root category. */
export interface CreateCategoryInput {
  name: string;
  kind: CategoryKind;
  /** Root category id to nest under; must itself be a root of the same kind. */
  parentId?: string;
  /** Explicit position among its siblings; when omitted, appended as max(sort)+1. */
  sort?: number;
}

/** What the archived-category menu needs to explain every purge blocker. */
export interface CategoryPurgeInspection {
  purgeable: boolean;
  archived: boolean;
  /** Live transactions 断联并归档 would move. */
  liveTxnCount: number;
  /** Every transaction in the subtree, soft-deleted rows included. */
  txnCount: number;
  deletedTxnCount: number;
  templateCount: number;
  /** Direct children that are not archived; they block a parent purge. */
  liveChildCount: number;
  /** Direct children a purge would delete with the target. */
  childCount: number;
  /** Derived hints that do not block a purge and are restored by undo. */
  hintCount: number;
}

interface PurgedHintRow {
  id: string;
  category_id: string | null;
  payee: string | null;
  status: 'candidate' | 'confirmed' | 'dismissed';
  monthly_cents: number;
  last_date: string;
  next_date: string;
  occurrences: number;
  detected_at: string;
}

/** Raw category row; the only shape that knows about snake_case columns. */
interface CategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  kind: CategoryKind;
  sort: number;
  archived_at: string | null;
}

const CATEGORY_COLUMNS = 'id, parent_id, name, kind, sort, archived_at';

/** Single row-to-object mapping; nothing else touches raw column names. */
function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind,
    sort: row.sort,
    archivedAt: row.archived_at,
  };
}

/**
 * Next position among siblings: same kind and same parent. Two kinds and two
 * levels therefore number independently, so the seeded expense roots come out
 * 0..8 and the income roots restart at 0.
 *
 * The system category is skipped deliberately. Its sort is a sentinel far above
 * every user row, and counting it would make the next user category sort after
 * 未分类 instead of before it.
 */
async function nextSort(db: Db, kind: CategoryKind, parentId: string | null): Promise<number> {
  const params: DbParam[] = [kind, UNCATEGORIZED_CATEGORY_ID];
  let parentFilter = 'parent_id IS NULL';
  if (parentId !== null) {
    parentFilter = 'parent_id = ?';
    params.push(parentId);
  }
  const row = await db.get<{ next_sort: number }>(
    `SELECT COALESCE(MAX(sort), -1) + 1 AS next_sort FROM category
     WHERE kind = ? AND id <> ? AND ${parentFilter}`,
    params
  );
  return row?.next_sort ?? 0;
}

/**
 * The two-level contract, enforced in code before any row is written.
 *
 * Checked here and not left to SQL: the column type cannot express depth, and
 * a single UPDATE could otherwise move a row under a grandchild. A parent that
 * does not exist, is already a child, or carries the other kind cannot host a
 * child of this one.
 */
async function assertUsableParent(db: Db, parentId: string, kind: CategoryKind): Promise<void> {
  const parent = await db.get<{ parent_id: string | null; kind: CategoryKind }>(
    'SELECT parent_id, kind FROM category WHERE id = ?',
    [parentId]
  );
  if (parent === undefined) {
    throw new Error(`parent category not found: ${parentId}`);
  }
  if (parent.parent_id !== null) {
    throw new Error('分类最多两级');
  }
  if (parent.kind !== kind) {
    throw new Error(`parent category kind must be ${parent.kind}, received ${kind}`);
  }
}

/**
 * Creates one category and returns its id. Never opens a transaction: this is
 * called from inside seedDefaults' single unit of work, and a transaction
 * opened here would only join that one.
 */
export async function createCategory(db: Db, input: CreateCategoryInput): Promise<string> {
  const parentId = input.parentId ?? null;
  if (parentId !== null) {
    await assertUsableParent(db, parentId, input.kind);
  }

  const sort = input.sort ?? (await nextSort(db, input.kind, parentId));
  const id = newId();

  await db.run(
    'INSERT INTO category (id, parent_id, name, kind, sort, archived_at) VALUES (?, ?, ?, ?, ?, NULL)',
    [id, parentId, input.name, input.kind, sort]
  );
  return id;
}

/**
 * Categories ordered by sort then name. Archived categories are excluded by
 * default the same way listAccounts hides archived accounts: the row is kept,
 * only hidden from pickers. The management screen passes includeArchived so it
 * can offer 恢复. Archived rows keep their sort, so restoring one does not
 * reshuffle its siblings.
 *
 * The system 未分类 category is included: the picker must be able to render a
 * row reflowed into it as a real choice rather than as a missing category. Its
 * sentinel sort keeps it last, and createCategory's nextSort never numbers a
 * user category after it.
 */
export async function listCategories(
  db: Db,
  kind?: CategoryKind,
  opts: { includeArchived?: boolean } = {}
): Promise<Category[]> {
  const params: DbParam[] = [];
  const where = opts.includeArchived ? [] : ['archived_at IS NULL'];
  if (kind !== undefined) {
    where.push('kind = ?');
    params.push(kind);
  }
  const filter = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;

  const rows = await db.all<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM category ${filter} ORDER BY sort, name`,
    params
  );
  return rows.map(toCategory);
}

/** The system category's forbidden operations share one message shape. */
function assertNotSystem(
  id: string,
  action: '改名' | '归档' | '断联并归档' | '彻底删除'
): void {
  if (id === UNCATEGORIZED_CATEGORY_ID) {
    throw new Error(`系统分类「${UNCATEGORIZED_CATEGORY_NAME}」不能${action}`);
  }
}

/**
 * Changes one category's display name. Transactions reference the id, so no
 * amount, date or category assignment moves. Names are trimmed and a blank one
 * is refused; unlike a tag, category names are not unique in the schema, so
 * two siblings may legitimately carry the same label.
 */
export async function renameCategory(db: Db, id: string, name: string): Promise<void> {
  assertNotSystem(id, '改名');
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new Error('分类名不能为空');
  }

  const existing = await db.get<{ id: string }>('SELECT id FROM category WHERE id = ?', [id]);
  if (existing === undefined) {
    throw new Error(`分类不存在：${id}`);
  }

  await db.run('UPDATE category SET name = ? WHERE id = ?', [trimmed, id]);
}

/**
 * Hides a category from pickers without deleting it or any transaction. The
 * first archive timestamp is kept, so a second call is a no-op rather than a
 * rewrite. No transaction is opened: it is one statement, matching
 * archiveAccount.
 */
export async function archiveCategory(db: Db, id: string): Promise<void> {
  assertNotSystem(id, '归档');
  await db.run('UPDATE category SET archived_at = COALESCE(archived_at, ?) WHERE id = ?', [
    new Date().toISOString(),
    id,
  ]);
}

/** Restores a category to the live list; its id, sort and history are untouched. */
export async function unarchiveCategory(db: Db, id: string): Promise<void> {
  await db.run('UPDATE category SET archived_at = NULL WHERE id = ?', [id]);
}

/**
 * The category plus its direct children. The tree is two levels by contract,
 * so this is the whole subtree; a child whose parent is missing cannot exist
 * through createCategory, but a raw row would simply not be included.
 */
async function subtreeIds(db: Db, id: string): Promise<string[]> {
  const existing = await db.get<{ id: string }>('SELECT id FROM category WHERE id = ?', [id]);
  if (existing === undefined) {
    throw new Error(`分类不存在：${id}`);
  }
  const children = await db.all<{ id: string }>(
    'SELECT id FROM category WHERE parent_id = ?',
    [id]
  );
  return [id, ...children.map(child => child.id)];
}

interface CategoryPurgeCounts {
  liveTxnCount: number;
  txnCount: number;
  deletedTxnCount: number;
  templateCount: number;
  liveChildCount: number;
  childCount: number;
  hintCount: number;
}

/**
 * Every count the archived-category menu and purge need, over the subtree.
 * Soft-deleted transactions count as history: they are hidden from the ledger
 * but they still name this category, and rewriting them would be a data loss
 * disguised as a menu action.
 */
async function readPurgeCounts(
  db: Db,
  id: string,
  ids: readonly string[]
): Promise<CategoryPurgeCounts> {
  const placeholders = ids.map(() => '?').join(', ');
  const txn = await db.get<{
    txn_count: number;
    live_txn_count: number;
    deleted_txn_count: number;
  }>(
    `SELECT COUNT(*) AS txn_count,
            COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS live_txn_count,
            COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS deleted_txn_count
     FROM txn WHERE category_id IN (${placeholders})`,
    ids
  );
  const template = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM template WHERE category_id IN (${placeholders})`,
    ids
  );
  const children = await db.get<{ child_count: number; live_child_count: number }>(
    `SELECT COUNT(*) AS child_count,
            COALESCE(SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END), 0) AS live_child_count
     FROM category WHERE parent_id = ?`,
    [id]
  );
  const hints = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM recurring_hint WHERE category_id IN (${placeholders})`,
    ids
  );

  return {
    liveTxnCount: txn?.live_txn_count ?? 0,
    txnCount: txn?.txn_count ?? 0,
    deletedTxnCount: txn?.deleted_txn_count ?? 0,
    templateCount: template?.n ?? 0,
    liveChildCount: children?.live_child_count ?? 0,
    childCount: children?.child_count ?? 0,
    hintCount: hints?.n ?? 0,
  };
}

/** Everything the archived category's 彻底删除 sheet needs, in one read. */
export async function inspectCategoryPurge(
  db: Db,
  id: string
): Promise<CategoryPurgeInspection> {
  const ids = await subtreeIds(db, id);
  const root = await db.get<{ archived_at: string | null }>(
    'SELECT archived_at FROM category WHERE id = ?',
    [id]
  );
  if (root === undefined) {
    throw new Error(`分类不存在：${id}`);
  }
  const counts = await readPurgeCounts(db, id, ids);
  const archived = root.archived_at !== null;
  const system = id === UNCATEGORIZED_CATEGORY_ID;
  return {
    purgeable:
      archived &&
      !system &&
      counts.txnCount === 0 &&
      counts.templateCount === 0 &&
      counts.liveChildCount === 0,
    archived,
    ...counts,
  };
}

/**
 * The live-category retirement action: move its live transactions to 未分类,
 * then archive the root and every direct child.
 *
 * Soft-deleted transactions keep their category_id. They are history, not
 * input to this action, and they still block a later purge. No undo record is
 * written: 恢复 can bring the category back, but it cannot recreate the links
 * this call deliberately broke, so the confirmation says so.
 */
export async function archiveCategoryWithUnlink(
  db: Db,
  id: string
): Promise<{ movedTxns: number; archivedChildCount: number }> {
  assertNotSystem(id, '断联并归档');

  return db.transaction(async tx => {
    const ids = await subtreeIds(tx, id);
    const placeholders = ids.map(() => '?').join(', ');
    const moved = await tx.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM txn
       WHERE deleted_at IS NULL AND category_id IN (${placeholders})`,
      ids
    );
    const children = await tx.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM category WHERE parent_id = ? AND archived_at IS NULL',
      [id]
    );

    await tx.run(
      `UPDATE txn SET category_id = ?
       WHERE deleted_at IS NULL AND category_id IN (${placeholders})`,
      [UNCATEGORIZED_CATEGORY_ID, ...ids]
    );
    await tx.run(
      `UPDATE category SET archived_at = COALESCE(archived_at, ?)
       WHERE id IN (${placeholders})`,
      [new Date().toISOString(), ...ids]
    );

    return {
      movedTxns: moved?.n ?? 0,
      archivedChildCount: children?.n ?? 0,
    };
  });
}

/**
 * Physically removes an archived category that has no history at all. The
 * check is repeated inside the transaction: an inspect result is a snapshot,
 * and a transaction that trusts it could delete a row written since.
 *
 * The exact rows are stored in purge_undo before they disappear. That includes
 * recurring_hint rows, which do not block a purge but must come back if the
 * owner presses 撤销. No txn row is touched.
 */
export async function purgeCategory(
  db: Db,
  id: string
): Promise<{ undo: PurgeUndoRecord; deletedChildren: number }> {
  assertNotSystem(id, '彻底删除');

  return db.transaction(async tx => {
    const ids = await subtreeIds(tx, id);
    const root = await tx.get<CategoryRow>(
      `SELECT ${CATEGORY_COLUMNS} FROM category WHERE id = ?`,
      [id]
    );
    if (root === undefined) {
      throw new Error(`分类不存在：${id}`);
    }
    if (root.archived_at === null) {
      throw new Error('只有已归档的分类才能彻底删除');
    }

    const counts = await readPurgeCounts(tx, id, ids);
    if (counts.txnCount > 0 || counts.templateCount > 0 || counts.liveChildCount > 0) {
      throw new Error('这个分类还有历史，不能彻底删除');
    }

    const children = await tx.all<CategoryRow>(
      `SELECT ${CATEGORY_COLUMNS} FROM category WHERE parent_id = ? ORDER BY sort, name`,
      [id]
    );
    const placeholders = ids.map(() => '?').join(', ');
    const hints = await tx.all<PurgedHintRow>(
      `SELECT id, category_id, payee, status, monthly_cents, last_date, next_date,
              occurrences, detected_at
       FROM recurring_hint WHERE category_id IN (${placeholders})
       ORDER BY id`,
      ids
    );

    const payload = {
      category: [
        {
          id: root.id,
          parent_id: root.parent_id,
          name: root.name,
          kind: root.kind,
          sort: root.sort,
          archived_at: root.archived_at,
        },
        ...children.map(child => ({
          id: child.id,
          parent_id: child.parent_id,
          name: child.name,
          kind: child.kind,
          sort: child.sort,
          archived_at: child.archived_at,
        })),
      ],
      hints,
    };

    await tx.run(
      `DELETE FROM recurring_hint WHERE category_id IN (${placeholders})`,
      ids
    );
    await tx.run('DELETE FROM category WHERE parent_id = ?', [id]);
    await tx.run('DELETE FROM category WHERE id = ?', [id]);

    const expiresAt = Date.now() + PURGE_UNDO_MS;
    await writePurgeUndo(tx, {
      kind: 'category',
      targetId: id,
      label: root.name,
      expiresAt,
      payload,
    });

    return {
      undo: { kind: 'category' as const, targetId: id, label: root.name, expiresAt },
      deletedChildren: children.length,
    };
  });
}
