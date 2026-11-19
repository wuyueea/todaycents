/**
 * Backup and restore history for the current device.
 *
 * Kept apart from flow.ts so the 设置 screen can read the last backup without
 * pulling in the import/restore flow. app_meta is the existing key/value table;
 * this module adds no schema.
 */
import type { Db } from '../db/driver';
import type { BackupMeta } from './format';

const BACKUP_META_KEYS = {
  at: 'last_backup_at',
  rows: 'last_backup_rows',
  bytes: 'last_backup_bytes',
} as const;
const RESTORE_META_KEY = 'last_restore';
export const LOCAL_BACKUP_META_KEYS: readonly string[] = [
  ...Object.values(BACKUP_META_KEYS),
  RESTORE_META_KEY,
];

const UPSERT_META =
  'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

export interface RestoreMeta {
  restoredAt: string;
  sourceExportedAt: string;
}

/**
 * Reads the last successful export. A half-written record (some keys missing,
 * or a value that is not a non-negative integer) is reported as "no backup"
 * rather than rendering a nonsensical line; recordBackupMeta writes all three
 * keys in one transaction, so this only happens after external damage.
 */
export async function readBackupMeta(db: Db): Promise<BackupMeta | null> {
  const rows = await db.all<{ key: string; value: string }>(
    'SELECT key, value FROM app_meta WHERE key IN (?, ?, ?)',
    [BACKUP_META_KEYS.at, BACKUP_META_KEYS.rows, BACKUP_META_KEYS.bytes]
  );
  const values = new Map(rows.map(row => [row.key, row.value]));
  const at = values.get(BACKUP_META_KEYS.at);
  const rowsText = values.get(BACKUP_META_KEYS.rows);
  const bytesText = values.get(BACKUP_META_KEYS.bytes);
  if (at === undefined || at.trim() === '') return null;
  if (rowsText === undefined || bytesText === undefined) return null;

  const rowCount = Number(rowsText);
  const bytes = Number(bytesText);
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) return null;
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;

  return { at, rows: rowCount, bytes };
}

/** Upserts the three keys atomically, so readers never see a partial record. */
export async function recordBackupMeta(db: Db, meta: BackupMeta): Promise<void> {
  const entries: ReadonlyArray<readonly [string, string]> = [
    [BACKUP_META_KEYS.at, meta.at],
    [BACKUP_META_KEYS.rows, String(meta.rows)],
    [BACKUP_META_KEYS.bytes, String(meta.bytes)],
  ];

  await db.transaction(async tx => {
    for (const [key, value] of entries) {
      await tx.run(UPSERT_META, [key, value]);
    }
  });
}

export async function readRestoreMeta(db: Db): Promise<RestoreMeta | null> {
  const row = await db.get<{ value: string }>(
    'SELECT value FROM app_meta WHERE key = ?', [RESTORE_META_KEY]
  );
  if (row === undefined) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { restoredAt, sourceExportedAt } = parsed as Partial<RestoreMeta>;
  if (typeof restoredAt !== 'string' || !Number.isFinite(Date.parse(restoredAt))) return null;
  if (typeof sourceExportedAt !== 'string' || sourceExportedAt.trim() === '') return null;
  return { restoredAt, sourceExportedAt };
}

/** Called inside the same transaction that replaces the ledger. */
export async function recordRestoreMeta(db: Db, meta: RestoreMeta): Promise<void> {
  await db.run(UPSERT_META, [RESTORE_META_KEY, JSON.stringify(meta)]);
}

/**
 * Transaction rows in the local ledger. This uses the same unit as
 * file.counts.txn — every row in the txn table, soft-deleted rows included —
 * so the two numbers in the confirmation are comparable.
 */
export async function countTxnRows(db: Db): Promise<number> {
  const row = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM txn');
  return row?.n ?? 0;
}
