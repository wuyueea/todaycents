/**
 * The data half of backup/import: build, export, prepare, replace.
 *
 * This module deliberately knows nothing about Capacitor or the DOM. A
 * BackupFileWriter is injected, so the whole flow can be tested against the
 * Node SQLite driver with an in-memory writer, while device.ts supplies the
 * real cache + share-sheet implementation in the app.
 *
 * Import is two steps because the confirmation sheet sits between them:
 * prepareImport validates the file and reads both row counts, confirmImport
 * writes the before-copy and only then restores. A restore is already atomic
 * in the codec; this module adds the before-copy as the extra safety net.
 */
import type { Db } from '../db/driver';
import {
  BackupSchemaTooNewError,
  buildBackup,
  parseBackup,
  restoreBackup,
  serializeBackup,
} from '../db/backup';
import type { BackupFile } from '../db/backup';
import { readResetCounts, resetLedger } from '../db/reset';
import type { ResetCounts } from '../db/reset';
import { backupFileName, beforeBackupFileName, utf8ByteLength } from './format';
import type { BackupMeta } from './format';
import { countTxnRows, recordBackupMeta } from './meta';

/** Where the two exported files go. The device implementation lives in device.ts. */
export interface BackupFileWriter {
  /** The owner-facing export: cache file + system share sheet (or a browser download). */
  writeForShare(fileName: string, text: string): Promise<void>;
  /** The automatic pre-import copy: the folder when set, otherwise the cache; never a second share sheet. */
  writeCopy(fileName: string, text: string): Promise<void>;
}

export interface ExportResult {
  fileName: string;
  /** Transaction rows in the file, matching the plan's "笔流水". */
  rows: number;
  bytes: number;
  meta: BackupMeta;
}

/**
 * Builds, serialises and hands the file to the writer, then records the meta.
 * Meta is written only after the writer succeeds, so a failed export never
 * claims that a backup exists. The caller stays on the backup screen; nothing
 * here navigates or shows UI.
 */
export async function exportBackup(
  db: Db,
  writer: BackupFileWriter,
  now: Date
): Promise<ExportResult> {
  const file = await buildBackup(db);
  const text = serializeBackup(file);
  const fileName = backupFileName(now);

  await writer.writeForShare(fileName, text);

  const bytes = utf8ByteLength(text);
  const meta: BackupMeta = { at: now.toISOString(), rows: file.counts.txn, bytes };
  await recordBackupMeta(db, meta);

  return { fileName, rows: meta.rows, bytes, meta };
}

/** Everything the confirmation sheet needs, read before it opens. */
export interface PreparedImport {
  file: BackupFile;
  fileName: string;
  fileBytes: number;
  fileRows: number;
  localRows: number;
  /** The file's own exportedAt, for the file card. */
  exportedAt: string;
}

/**
 * Validates the text and reads both row counts. Nothing is written here.
 *
 * The schema gate is repeated from restoreBackup on purpose: a file from a
 * newer app must be refused before the dangerous confirmation sheet opens, not
 * after the owner has already agreed to replace the ledger.
 */
export async function prepareImport(
  db: Db,
  text: string,
  fileName: string,
  fileBytes: number
): Promise<PreparedImport> {
  const file = parseBackup(text);

  const versionRow = await db.get<{ version: number | null }>(
    'SELECT MAX(version) AS version FROM schema_migrations'
  );
  const databaseVersion = versionRow?.version ?? 0;
  if (file.schemaVersion > databaseVersion) {
    throw new BackupSchemaTooNewError(file.schemaVersion, databaseVersion);
  }

  const localRows = await countTxnRows(db);
  return {
    file,
    fileName,
    fileBytes,
    fileRows: file.counts.txn,
    localRows,
    exportedAt: file.exportedAt,
  };
}

export interface ImportResult {
  fileName: string;
  rows: number;
  beforeFileName: string;
}

/**
 * Writes the before-copy first, then replaces the whole ledger.
 *
 * If the before-copy cannot be written, restoreBackup is never called. If the
 * restore fails, its transaction rolls back and the before-copy remains. The
 * caller shows the failure sheet and stays on the backup screen.
 */
export async function confirmImport(
  db: Db,
  prepared: PreparedImport,
  writer: BackupFileWriter,
  now: Date
): Promise<ImportResult> {
  const current = await buildBackup(db);
  const beforeFileName = beforeBackupFileName(now);
  await writer.writeCopy(beforeFileName, serializeBackup(current));

  await restoreBackup(db, prepared.file);

  return {
    fileName: prepared.fileName,
    rows: prepared.file.counts.txn,
    beforeFileName,
  };
}

export interface ResetResult {
  /** The automatic pre-reset copy, already written. */
  beforeFileName: string;
  /** Rows the wipe removed, read from the ledger just before it ran. */
  counts: ResetCounts;
}

/**
 * 清除所有数据: writes the automatic before-copy, then returns the app to a
 * first launch.
 *
 * Same order as confirmImport, for the same reason: the copy is the only way
 * back, so it is written first and the wipe only starts once it succeeded. A
 * failed build or a failed copy leaves the ledger exactly as it was; a failed
 * wipe rolls back inside resetLedger's transaction.
 *
 * No app_meta is recorded here: app_meta is one of the tables the reset
 * empties, and a fresh install has no 上次备份 line. The toast naming the file
 * is what tells the owner where the copy went.
 */
export async function resetWithBackup(
  db: Db,
  writer: BackupFileWriter,
  now: Date
): Promise<ResetResult> {
  const current = await buildBackup(db);
  const beforeFileName = beforeBackupFileName(now);
  await writer.writeCopy(beforeFileName, serializeBackup(current));

  const counts = await readResetCounts(db);
  await resetLedger(db);

  return { beforeFileName, counts };
}
