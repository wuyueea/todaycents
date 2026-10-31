import type { Db, DbParam } from '../driver';
import { newId } from '../id';
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

/** One transaction and the category it came from, captured by deleteCategory. */
export interface CategoryMove {
  txnId: string;
  categoryId: string;
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
 * called from inside seedDefaults' single unit of work, and the driver's
 * transactions are not re-entrant.
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

/** The system category's three forbidden operations share one message shape. */
function assertNotSystem(id: string, action: '改名' | '归档' | '删除'): void {
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

/** Counts the live transactions that deleting this category would move. */
export async function countCategoryTxns(db: Db, id: string): Promise<number> {
  const ids = await subtreeIds(db, id);
  const placeholders = ids.map(() => '?').join(', ');
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM txn
     WHERE deleted_at IS NULL AND category_id IN (${placeholders})`,
    ids
  );
  return row?.n ?? 0;
}

/**
 * Deletes one category by reflowing history, then soft-deleting it.
 *
 * The whole operation is one transaction: every live transaction whose
 * category is this one or one of its direct children is pointed at the system
 * 未分类 category, then the category and its children get archived_at set. No
 * txn row is deleted, no amount changes, and the category rows themselves are
 * never physically removed. Soft-deleted transactions are history and keep
 * their old category_id; they are not moved.
 *
 * The ids are read before the UPDATE inside the same transaction, so they name
 * exactly the rows this call moved. A category with no transactions (or an
 * already-deleted one whose rows are all gone) succeeds and reports none.
 */
export async function deleteCategory(
  db: Db,
  id: string
): Promise<{ movedTxns: number; moves: CategoryMove[] }> {
  assertNotSystem(id, '删除');

  return db.transaction(async tx => {
    const ids = await subtreeIds(tx, id);
    const placeholders = ids.map(() => '?').join(', ');

    // Remember where each row came from: a child's transactions must return to
    // that child on undo, not to the deleted parent.
    const rows = await tx.all<{ id: string; category_id: string }>(
      `SELECT id, category_id FROM txn
       WHERE deleted_at IS NULL AND category_id IN (${placeholders})
       ORDER BY created_at, id`,
      ids
    );
    const moves: CategoryMove[] = rows.map(row => ({
      txnId: row.id,
      categoryId: row.category_id,
    }));

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

    return { movedTxns: moves.length, moves };
  });
}

/**
 * The 10-second undo for deleteCategory.
 *
 * One transaction restores the moved rows and clears the category's
 * archived_at. Children archived by the same delete (same timestamp) are
 * restored too, so the visible tree comes back rather than leaving orphans in
 * 已归档. It only touches rows that still point at 未分类: if the user already
 * gave one of them another category in that window, their newer choice wins.
 * Soft-deleted rows are never resurrected.
 *
 * The ids come from the delete that is being undone. An empty list still
 * unarchives the category, which is how a delete with zero moved rows is
 * undone. The system 未分类 category can never be the target: it is refused
 * with the same message as the destructive operation.
 */
export async function undoDeleteCategory(
  db: Db,
  id: string,
  moves: readonly CategoryMove[]
): Promise<void> {
  assertNotSystem(id, '删除');
  const unique = [...new Map(moves.map(move => [move.txnId, move])).values()];

  await db.transaction(async tx => {
    const existing = await tx.get<{ archived_at: string | null }>(
      'SELECT archived_at FROM category WHERE id = ?',
      [id]
    );
    if (existing === undefined) {
      throw new Error(`分类不存在：${id}`);
    }

    // Row by row: a parent delete can move transactions of several children,
    // and each must go back to the category it actually came from.
    for (const move of unique) {
      await tx.run(
        `UPDATE txn SET category_id = ?
         WHERE id = ? AND category_id = ? AND deleted_at IS NULL`,
        [move.categoryId, move.txnId, UNCATEGORIZED_CATEGORY_ID]
      );
    }

    // deleteCategory archives the root and its children with one timestamp.
    // Undo restores exactly that batch; a child archived earlier keeps its own
    // older timestamp and stays archived, so an unrelated archive is not undone
    // by accident.
    if (existing.archived_at !== null) {
      await tx.run(
        'UPDATE category SET archived_at = NULL WHERE parent_id = ? AND archived_at = ?',
        [id, existing.archived_at]
      );
    }
    await tx.run('UPDATE category SET archived_at = NULL WHERE id = ?', [id]);
  });
}
