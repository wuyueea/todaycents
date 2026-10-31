/**
 * Tags: a flat, multi-select label on a transaction.
 *
 * A tag has no hierarchy and no money: it only answers "这笔是怎么花的".
 * Archiving hides a tag from the picker but keeps every historical txn_tag
 * row, while deleting removes the links and soft-deletes the tag itself. No
 * transaction row is ever touched by either operation.
 *
 * Tag assignment lives here rather than in txns.ts because it owns a piece of
 * the tag model (which tags may be attached) and because it is deliberately a
 * separate unit of work. createExpense and submitDay must not open a
 * transaction of their own — submitDay already wraps one and the driver
 * rejects nesting — so the caller writes the transaction first, then calls
 * setTxnTags with its id.
 */
import type { Db } from '../driver';
import { newId } from '../id';

/** A tag as every screen consumes it; no raw columns leak out. */
export interface Tag {
  id: string;
  name: string;
  color: string | null;
  archivedAt: string | null;
}

/**
 * §4.2's limit: "长度 ≤ 12 字". Counted in Unicode code points, not UTF-16
 * code units, so an emoji is one character to the user and to this check.
 */
export const TAG_NAME_MAX_LENGTH = 12;

/** Raw tag row; the only shape that knows about snake_case columns. */
interface TagRow {
  id: string;
  name: string;
  color: string | null;
  archived_at: string | null;
}

const TAG_COLUMNS = 'id, name, color, archived_at';

function toTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    archivedAt: row.archived_at,
  };
}

/**
 * The one normalisation every write shares: trim, refuse empty, refuse over
 * the limit. Returning the trimmed text is what makes "重名直接复用" compare
 * the name the user meant rather than its surrounding whitespace.
 */
function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new Error('标签名不能为空');
  }
  if (Array.from(trimmed).length > TAG_NAME_MAX_LENGTH) {
    throw new Error(`标签名最多 ${TAG_NAME_MAX_LENGTH} 个字`);
  }
  return trimmed;
}

/**
 * Live tags in name order, or every tag when includeArchived is set. The
 * management screen asks for both: the default view hides archived tags, the
 * archived section still needs their names and ids.
 */
export async function listTags(
  db: Db,
  opts: { includeArchived?: boolean } = {}
): Promise<Tag[]> {
  const where = opts.includeArchived ? '' : 'WHERE archived_at IS NULL';
  const rows = await db.all<TagRow>(
    `SELECT ${TAG_COLUMNS} FROM tag ${where} ORDER BY name`
  );
  return rows.map(toTag);
}

/**
 * Creates a tag, or returns the id of the one already carrying that name.
 *
 * Names compare case-insensitively (SQLite NOCASE) after trimming, so "Night"
 * and "  night " are one tag rather than a UNIQUE error. An archived tag with
 * the same name is reused too: archiving is reversible, and silently creating
 * a second row the picker would not show is worse than handing back the id the
 * caller can unarchive.
 *
 * No transaction is opened: the lookup and the single INSERT are one logical
 * create, and the app writes from one UI at a time.
 */
export async function createTag(db: Db, name: string): Promise<string> {
  const trimmed = normalizeName(name);

  const existing = await db.get<{ id: string }>(
    'SELECT id FROM tag WHERE name = ? COLLATE NOCASE',
    [trimmed]
  );
  if (existing !== undefined) return existing.id;

  const id = newId();
  await db.run(
    'INSERT INTO tag (id, name, color, archived_at) VALUES (?, ?, NULL, NULL)',
    [id, trimmed]
  );
  return id;
}

/**
 * Renames one tag. Applying createTag's trim and length rules keeps a rename
 * from producing a name a create would have refused. A second tag already
 * using the name is a real conflict (the column is UNIQUE), so it is reported
 * instead of letting SQLite's constraint error surface.
 */
export async function renameTag(db: Db, id: string, name: string): Promise<void> {
  const trimmed = normalizeName(name);

  const existing = await db.get<{ id: string }>('SELECT id FROM tag WHERE id = ?', [id]);
  if (existing === undefined) {
    throw new Error(`标签不存在：${id}`);
  }

  const clash = await db.get<{ id: string }>(
    'SELECT id FROM tag WHERE id <> ? AND name = ? COLLATE NOCASE',
    [id, trimmed]
  );
  if (clash !== undefined) {
    throw new Error('已有同名标签，请换一个名字');
  }

  await db.run('UPDATE tag SET name = ? WHERE id = ?', [trimmed, id]);
}

/**
 * Hides a tag from the default list and picker. Its txn_tag rows stay, so
 * historical transactions keep their labels. COALESCE keeps the first
 * timestamp, making a second archive a no-op. One statement, no transaction.
 */
export async function archiveTag(db: Db, id: string): Promise<void> {
  await db.run('UPDATE tag SET archived_at = COALESCE(archived_at, ?) WHERE id = ?', [
    new Date().toISOString(),
    id,
  ]);
}

/** Undo for archiveTag: the tag returns to the live list with all links intact. */
export async function unarchiveTag(db: Db, id: string): Promise<void> {
  await db.run('UPDATE tag SET archived_at = NULL WHERE id = ?', [id]);
}

/**
 * Deletes a tag the way §4.2 defines it: remove its txn_tag rows, keep every
 * txn row, and soft-delete the tag row itself.
 *
 * Both writes are one transaction so a half-deleted tag cannot exist. The tag
 * is never physically removed: an old backup or a future "restore archived
 * tag" can still name it, and the id stays honest. Deleting an unknown or
 * already-deleted tag is a harmless no-op, matching archiveAccount.
 */
export async function deleteTag(db: Db, id: string): Promise<void> {
  const deletedAt = new Date().toISOString();
  await db.transaction(async tx => {
    await tx.run('DELETE FROM txn_tag WHERE tag_id = ?', [id]);
    await tx.run('UPDATE tag SET archived_at = COALESCE(archived_at, ?) WHERE id = ?', [
      deletedAt,
      id,
    ]);
  });
}

/**
 * Usage for the tag management screen: how many live transactions carry each
 * tag, and the newest occurred_date among them.
 *
 * Every tag is returned, archived and unused ones included, with count 0 and a
 * null date. The screen already has the full list (listTags with
 * includeArchived) and needs a row per tag to render; filtering here would
 * force it to guess why a tag is absent. Soft-deleted transactions do not
 * count — they are not usage the user can still see.
 */
export async function tagUsage(
  db: Db
): Promise<Array<{ id: string; name: string; count: number; lastUsedDate: string | null }>> {
  const rows = await db.all<{
    id: string;
    name: string;
    usage_count: number;
    last_used_date: string | null;
  }>(
    `SELECT t.id AS id, t.name AS name,
            COUNT(tx.id) AS usage_count,
            MAX(tx.occurred_date) AS last_used_date
     FROM tag t
     LEFT JOIN txn_tag tt ON tt.tag_id = t.id
     LEFT JOIN txn tx ON tx.id = tt.txn_id AND tx.deleted_at IS NULL
     GROUP BY t.id, t.name
     ORDER BY t.name`
  );

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    count: row.usage_count,
    lastUsedDate: row.last_used_date,
  }));
}

/**
 * Replaces one transaction's tags wholesale, in one transaction.
 *
 * Rules, all pinned by tests:
 * - duplicates collapse and unknown ids are ignored, so a stale picker cannot
 *   fail the save;
 * - a live tag is kept or added;
 * - an archived tag may stay attached when it is still in the caller's list
 *   (history survives an archive), but it is never added to a transaction that
 *   did not already carry it;
 * - any currently attached tag missing from the new list is removed, archived
 *   or not — the call is a replacement, not an append.
 *
 * The transaction is opened here and only here: callers write the txn first
 * and call this afterwards. Writing tags from inside createExpense/submitDay
 * would nest transactions, which the driver rejects.
 */
export async function setTxnTags(
  db: Db,
  txnId: string,
  tagIds: readonly string[]
): Promise<void> {
  const txn = await db.get<{ id: string }>(
    'SELECT id FROM txn WHERE id = ? AND deleted_at IS NULL',
    [txnId]
  );
  if (txn === undefined) {
    throw new Error(`流水不存在或已删除：${txnId}`);
  }

  const requested = [...new Set(tagIds)];
  const currentRows = await db.all<{ tag_id: string }>(
    'SELECT tag_id FROM txn_tag WHERE txn_id = ?',
    [txnId]
  );
  const current = new Set(currentRows.map(row => row.tag_id));

  const keep = new Set<string>();
  if (requested.length > 0) {
    const placeholders = requested.map(() => '?').join(', ');
    const rows = await db.all<{ id: string; archived_at: string | null }>(
      `SELECT id, archived_at FROM tag WHERE id IN (${placeholders})`,
      requested
    );
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const tagId of requested) {
      const tag = byId.get(tagId);
      if (tag === undefined) continue; // unknown id: ignored
      if (tag.archived_at === null || current.has(tagId)) {
        keep.add(tagId);
      }
    }
  }

  const toRemove = [...current].filter(tagId => !keep.has(tagId));
  const toInsert = [...keep].filter(tagId => !current.has(tagId));

  await db.transaction(async tx => {
    for (const tagId of toRemove) {
      await tx.run('DELETE FROM txn_tag WHERE txn_id = ? AND tag_id = ?', [txnId, tagId]);
    }
    for (const tagId of toInsert) {
      await tx.run('INSERT INTO txn_tag (txn_id, tag_id) VALUES (?, ?)', [txnId, tagId]);
    }
  });
}

/**
 * One transaction's tags in name order.
 *
 * Archived tags are included when they are attached: the row was labelled
 * that way when it was written, and hiding the label would rewrite history in
 * the read path. An unknown transaction simply has no tags.
 */
export async function getTxnTags(db: Db, txnId: string): Promise<Tag[]> {
  const rows = await db.all<TagRow>(
    `SELECT t.id AS id, t.name AS name, t.color AS color, t.archived_at AS archived_at
     FROM txn_tag tt
     JOIN tag t ON t.id = tt.tag_id
     WHERE tt.txn_id = ?
     ORDER BY t.name`,
    [txnId]
  );
  return rows.map(toTag);
}

/**
 * The same answer for many rows at once, for the ledger list.
 *
 * Every requested id gets an entry (an empty array when the row has no tags),
 * duplicates in the input collapse, and an empty input touches no SQL. The
 * screen can therefore render `byTxn.get(row.id) ?? []` without special cases.
 */
export async function listTagsForTxns(
  db: Db,
  txnIds: readonly string[]
): Promise<Map<string, Tag[]>> {
  const unique = [...new Set(txnIds)];
  const byTxn = new Map<string, Tag[]>();
  for (const id of unique) byTxn.set(id, []);
  if (unique.length === 0) return byTxn;

  const placeholders = unique.map(() => '?').join(', ');
  const rows = await db.all<TagRow & { txn_id: string }>(
    `SELECT tt.txn_id AS txn_id,
            t.id AS id, t.name AS name, t.color AS color, t.archived_at AS archived_at
     FROM txn_tag tt
     JOIN tag t ON t.id = tt.tag_id
     WHERE tt.txn_id IN (${placeholders})
     ORDER BY tt.txn_id, t.name`,
    unique
  );

  for (const row of rows) {
    byTxn.get(row.txn_id)?.push(toTag(row));
  }
  return byTxn;
}
