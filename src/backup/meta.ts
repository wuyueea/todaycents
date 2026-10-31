/**
 * The app_meta half of backup: the last successful export and a row count.
 *
 * Kept apart from flow.ts so the 设置 screen can read the last backup without
 * pulling in the import/restore flow. app_meta is the existing key/value table;
 * this module adds no schema.
 */
import type { Db } from '../db/driver';
import { BACKUP_META_KEYS } from './format';
import type { BackupMeta } from './format';

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
      await tx.run(
        'INSERT INTO app_meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, value]
      );
    }
  });
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
