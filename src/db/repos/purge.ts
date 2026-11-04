import type { Db } from '../driver';

/**
 * The two kinds of row a purge can undo. They share one table because the app
 * offers exactly one undo bar; a second purge replaces the first instead of
 * stacking two unrelated offers.
 */
export type PurgeKind = 'category' | 'tag';

/** The ten seconds the purge undo stays offered. */
export const PURGE_UNDO_MS = 10_000;

/** What a persisted purge offers the app shell after a restart. */
export interface PurgeUndoRecord {
  kind: PurgeKind;
  targetId: string;
  label: string;
  /** Epoch milliseconds; at or after this instant the record is spent. */
  expiresAt: number;
}

/** Raw purge_undo row; the table has exactly one row. */
interface PurgeUndoRow {
  kind: PurgeKind;
  target_id: string;
  label: string;
  payload_json: string;
  expires_at: number;
}

interface PurgedCategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  kind: 'expense' | 'income';
  sort: number;
  archived_at: string | null;
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

interface PurgedTagRow {
  id: string;
  name: string;
  color: string | null;
  archived_at: string | null;
}

/**
 * The exact rows a purge removed, stored as internal JSON. Categories are
 * parents first so they can be inserted back under foreign keys without a
 * second pass.
 */
export type PurgePayload =
  | { category: PurgedCategoryRow[]; hints: PurgedHintRow[] }
  | { tag: PurgedTagRow[] };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseCategoryPayload(raw: UnknownRecord): PurgePayload | null {
  const categories = raw.category;
  const hints = raw.hints;
  if (!Array.isArray(categories) || !Array.isArray(hints)) return null;
  // A purge always removes at least the target row. An empty list can only be
  // corrupt, and accepting it would show an undo button that restores nothing.
  if (categories.length === 0) return null;

  const seen = new Set<string>();
  const parsedCategories: PurgedCategoryRow[] = [];
  for (const [index, item] of categories.entries()) {
    if (!isRecord(item)) return null;
    const { id, parent_id, name, kind, sort, archived_at } = item;
    if (typeof id !== 'string' || id === '') return null;
    if (!isNullableString(parent_id)) return null;
    if (typeof name !== 'string') return null;
    if (kind !== 'expense' && kind !== 'income') return null;
    if (!isFiniteNumber(sort)) return null;
    if (!isNullableString(archived_at)) return null;
    if (parent_id === id) return null;
    // The writer stores the root before its children. The first row is the
    // purge target: when it is an archived child, its parent is still live and
    // deliberately outside the payload. Every later parent must be a row that
    // already appeared, so the undo can insert parents first.
    const externalParent = index === 0 && parent_id !== null && !seen.has(parent_id);
    if (parent_id !== null && !seen.has(parent_id) && !externalParent) return null;
    if (seen.has(id)) return null;
    seen.add(id);
    parsedCategories.push({
      id,
      parent_id,
      name,
      kind,
      sort,
      archived_at,
    });
  }

  const parsedHints: PurgedHintRow[] = [];
  for (const item of hints) {
    if (!isRecord(item)) return null;
    const {
      id,
      category_id,
      payee,
      status,
      monthly_cents,
      last_date,
      next_date,
      occurrences,
      detected_at,
    } = item;
    if (typeof id !== 'string' || id === '') return null;
    if (!isNullableString(category_id)) return null;
    if (!isNullableString(payee)) return null;
    if (status !== 'candidate' && status !== 'confirmed' && status !== 'dismissed') return null;
    if (!isFiniteNumber(monthly_cents)) return null;
    if (typeof last_date !== 'string') return null;
    if (typeof next_date !== 'string') return null;
    if (!isFiniteNumber(occurrences)) return null;
    if (typeof detected_at !== 'string') return null;
    parsedHints.push({
      id,
      category_id,
      payee,
      status,
      monthly_cents,
      last_date,
      next_date,
      occurrences,
      detected_at,
    });
  }

  return { category: parsedCategories, hints: parsedHints };
}

function parseTagPayload(raw: UnknownRecord): PurgePayload | null {
  const tags = raw.tag;
  if (!Array.isArray(tags) || tags.length === 0) return null;

  const seen = new Set<string>();
  const parsed: PurgedTagRow[] = [];
  for (const item of tags) {
    if (!isRecord(item)) return null;
    const { id, name, color, archived_at } = item;
    if (typeof id !== 'string' || id === '') return null;
    if (typeof name !== 'string' || name === '') return null;
    if (!isNullableString(color)) return null;
    if (!isNullableString(archived_at)) return null;
    if (seen.has(id)) return null;
    seen.add(id);
    parsed.push({ id, name, color, archived_at });
  }
  return { tag: parsed };
}

/**
 * The first category in a payload may point at a parent that was deliberately
 * left out (purging one archived child while its parent stays behind). That
 * parent must still be a root of the same kind, otherwise the undo would fail
 * on a foreign key after the user already tapped it.
 */
async function externalParentMatches(db: Db, payload: PurgePayload): Promise<boolean> {
  if (!('category' in payload)) return true;
  const first = payload.category[0];
  if (first === undefined || first.parent_id === null) return true;
  if (payload.category.some(category => category.id === first.parent_id)) return false;
  const parent = await db.get<{ parent_id: string | null; kind: 'expense' | 'income' }>(
    'SELECT parent_id, kind FROM category WHERE id = ?',
    [first.parent_id]
  );
  return parent !== undefined && parent.parent_id === null && parent.kind === first.kind;
}

/** The object id the payload would restore; every writer stores the target first. */
function payloadTargetId(payload: PurgePayload): string | undefined {
  return 'category' in payload ? payload.category[0]?.id : payload.tag[0]?.id;
}

/** Strict enough that a corrupt row cannot produce a button that must fail. */
function parsePayload(kind: PurgeKind, json: string): PurgePayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  return kind === 'category' ? parseCategoryPayload(raw) : parseTagPayload(raw);
}

/**
 * The purge a previous session left for the app shell, or null.
 *
 * Expiry and payload shape are checked on read: a stale or corrupt row must
 * never bring back an undo button whose click can only fail. This is
 * deliberately a read, like the retired category-delete undo: a stale row is
 * ignored until the next purge replaces it or a successful undo clears it.
 */
export async function readPurgeUndo(
  db: Db,
  now = Date.now()
): Promise<PurgeUndoRecord | null> {
  const row = await db.get<PurgeUndoRow>(
    'SELECT kind, target_id, label, payload_json, expires_at FROM purge_undo WHERE id = 1'
  );
  if (row === undefined) return null;
  if (row.expires_at <= now) return null;
  if (row.kind !== 'category' && row.kind !== 'tag') return null;
  const payload = parsePayload(row.kind, row.payload_json);
  if (payload === null) return null;
  if (payloadTargetId(payload) !== row.target_id) return null;
  if (!(await externalParentMatches(db, payload))) return null;

  return {
    kind: row.kind,
    targetId: row.target_id,
    label: row.label,
    expiresAt: row.expires_at,
  };
}

/**
 * Replaces the single undo slot. Called inside the same transaction as the
 * purge, so a crash cannot leave a deleted object without its undo row, or a
 * row pointing at an object that still exists.
 */
export async function writePurgeUndo(
  tx: Db,
  input: {
    kind: PurgeKind;
    targetId: string;
    label: string;
    expiresAt: number;
    payload: PurgePayload;
  }
): Promise<void> {
  await tx.run('DELETE FROM purge_undo');
  await tx.run(
    `INSERT INTO purge_undo
       (id, kind, target_id, label, payload_json, expires_at, created_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)`,
    [
      input.kind,
      input.targetId,
      input.label,
      JSON.stringify(input.payload),
      input.expiresAt,
      new Date().toISOString(),
    ]
  );
}

/**
 * Restores the exact object a purge removed. The caller passes the record it
 * displayed; a newer purge, an expired window or a corrupt payload is refused
 * rather than restoring the wrong thing.
 *
 * The record is deleted only when all inserts succeeded, in the same
 * transaction. A failed undo therefore leaves the offer intact until it
 * expires, matching the confirmation copy.
 */
export async function undoPurge(
  db: Db,
  expected: { kind: PurgeKind; targetId: string; expiresAt: number }
): Promise<{ kind: PurgeKind; label: string }> {
  return db.transaction(async tx => {
    const row = await tx.get<PurgeUndoRow>(
      `SELECT kind, target_id, label, payload_json, expires_at
       FROM purge_undo WHERE id = 1`
    );
    if (
      row === undefined ||
      row.kind !== expected.kind ||
      row.target_id !== expected.targetId ||
      row.expires_at !== expected.expiresAt
    ) {
      throw new Error('撤销记录已更新');
    }
    if (row.expires_at <= Date.now()) {
      throw new Error('撤销窗口已过');
    }

    const payload = parsePayload(row.kind, row.payload_json);
    if (payload === null) {
      throw new Error('撤销记录已损坏');
    }
    if (payloadTargetId(payload) !== row.target_id) {
      throw new Error('撤销记录已损坏');
    }
    if (!(await externalParentMatches(tx, payload))) {
      throw new Error('撤销记录已损坏');
    }

    if (row.kind === 'category' && 'category' in payload) {
      for (const category of payload.category) {
        await tx.run(
          `INSERT INTO category (id, parent_id, name, kind, sort, archived_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            category.id,
            category.parent_id,
            category.name,
            category.kind,
            category.sort,
            category.archived_at,
          ]
        );
      }
      for (const hint of payload.hints) {
        await tx.run(
          `INSERT INTO recurring_hint
             (id, category_id, payee, status, monthly_cents, last_date, next_date,
              occurrences, detected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            hint.id,
            hint.category_id,
            hint.payee,
            hint.status,
            hint.monthly_cents,
            hint.last_date,
            hint.next_date,
            hint.occurrences,
            hint.detected_at,
          ]
        );
      }
    } else if (row.kind === 'tag' && 'tag' in payload) {
      for (const tag of payload.tag) {
        try {
          await tx.run(
            'INSERT INTO tag (id, name, color, archived_at) VALUES (?, ?, ?, ?)',
            [tag.id, tag.name, tag.color, tag.archived_at]
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('UNIQUE constraint failed: tag.name')) {
            throw new Error('已有同名标签，请换一个名字');
          }
          throw error;
        }
      }
    } else {
      throw new Error('撤销记录已损坏');
    }

    await tx.run(
      `DELETE FROM purge_undo
       WHERE id = 1 AND kind = ? AND target_id = ? AND expires_at = ?`,
      [row.kind, row.target_id, row.expires_at]
    );
    return { kind: row.kind, label: row.label };
  });
}
