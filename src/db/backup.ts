/**
 * Backup codec: turn the whole database into one versioned JSON document and
 * put it back atomically.
 *
 * This is pure data plumbing. It never formats money, never recomputes a
 * balance and never runs a business rule: every column is copied verbatim, so
 * integer cents stay integer cents. The export format is the v1 format in
 * docs/superpowers/plans/2026-10-23-B-备份与导入.md.
 *
 * import_batch and recurring_hint are deliberately NOT dumped. They are
 * outside this slice and do not exist in the v1 schema. project IS dumped since
 * schema v3: txn.project_id has always been a column of txn, and a file that
 * carried the id but not the project table would restore a dangling pointer.
 *
 * The format version stays 1: a project key is an additive table, and a file
 * written before it must still import (see OPTIONAL_TABLES).
 */
import type { Db, DbParam } from './driver';
import {
  UNCATEGORIZED_CATEGORY_ID,
  UNCATEGORIZED_CATEGORY_NAME,
  UNCATEGORIZED_CATEGORY_SORT,
} from './schema';

/**
 * The nine tables of this slice, in foreign-key order (parents first).
 * Deletion walks this list backwards. schema_migrations is deliberately absent:
 * it describes the database's own upgrade state, not the user's ledger, and a
 * restore must never rewrite it.
 *
 * project sits before txn because txn.project_id points at it (the constraint
 * is enforced by the repository, not by a foreign key).
 */
const BACKUP_TABLES = [
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

type BackupTable = (typeof BACKUP_TABLES)[number];

/**
 * Tables that arrived after the v1 backup format shipped. A file written before
 * them has no key in counts and no array in tables, and that means zero rows —
 * not a corrupt file. Every other table has always been in the file, so a
 * missing key for one of those is still an error.
 */
const OPTIONAL_TABLES: readonly BackupTable[] = ['project', 'recurring_hint'];

function isOptionalTable(table: BackupTable): boolean {
  return OPTIONAL_TABLES.includes(table);
}

/** A value a backup row may contain: the JSON-safe subset SQLite emits here. */
type BackupCell = string | number | null;

/** One row as it appears in the file; keys are the real snake_case columns. */
interface BackupRow {
  [column: string]: BackupCell;
}

/**
 * The parsed and validated v1 file. This is the only type the rest of the app
 * needs; B2 opens and writes the text, never the individual tables.
 */
export interface BackupFile {
  magic: 'ledger-backup';
  formatVersion: 1;
  schemaVersion: number;
  exportedAt: string;
  counts: Record<BackupTable, number>;
  tables: Record<BackupTable, BackupRow[]>;
}

/**
 * Columns in CREATE TABLE order. Selecting them explicitly (instead of
 * SELECT *) keeps the JSON key order stable and makes a schema change a
 * deliberate codec change, rather than silently altering the file shape.
 *
 * Every column is either TEXT or INTEGER, and SQLite's dynamic typing would
 * happily store "12.50" in an INTEGER column. The kind is therefore declared
 * here and checked on both sides of the codec: money can never become text.
 */
interface TableSpec {
  readonly columns: readonly string[];
  /** The subset of columns backed by INTEGER; the rest are TEXT. */
  readonly integerColumns: readonly string[];
}

const TABLE_SPECS: Record<BackupTable, TableSpec> = {
  account: {
    columns: [
      'id',
      'name',
      'type',
      'initial_balance_cents',
      'monthly_budget_cents',
      'sort',
      'archived_at',
      'created_at',
    ],
    integerColumns: ['initial_balance_cents', 'monthly_budget_cents', 'sort'],
  },
  category: {
    columns: ['id', 'parent_id', 'name', 'kind', 'sort', 'archived_at'],
    integerColumns: ['sort'],
  },
  tag: {
    columns: ['id', 'name', 'color', 'archived_at'],
    integerColumns: [],
  },
  project: {
    columns: [
      'id',
      'name',
      'status',
      'budget_cents',
      'started_date',
      'archived_date',
      'created_at',
    ],
    integerColumns: ['budget_cents'],
  },
  recurring_hint: {
    columns: [
      'id',
      'category_id',
      'payee',
      'status',
      'monthly_cents',
      'last_date',
      'next_date',
      'occurrences',
      'detected_at',
    ],
    integerColumns: ['monthly_cents', 'occurrences'],
  },
  template: {
    columns: [
      'id',
      'slot_key',
      'label',
      'category_id',
      'default_account_id',
      'default_amount_cents',
      'sort',
      'active',
    ],
    integerColumns: ['default_amount_cents', 'sort', 'active'],
  },
  txn: {
    columns: [
      'id',
      'occurred_date',
      'account_id',
      'amount_cents',
      'direction',
      'category_id',
      'project_id',
      'note',
      'payee',
      'slot_key',
      'is_fixed_cost',
      'transfer_group_id',
      'deleted_at',
      'created_at',
    ],
    integerColumns: ['amount_cents', 'is_fixed_cost'],
  },
  txn_tag: {
    columns: ['txn_id', 'tag_id'],
    integerColumns: [],
  },
  app_meta: {
    columns: ['key', 'value'],
    integerColumns: [],
  },
};

/**
 * Raised only when the file was written by a newer app. The class is private
 * to this module, but its name and code are part of the error contract so a
 * caller can tell "upgrade the app" apart from a generic corrupt file without
 * matching Chinese prose.
 */
export class BackupSchemaTooNewError extends Error {
  readonly code = 'BACKUP_SCHEMA_TOO_NEW';

  constructor(fileVersion: number, databaseVersion: number) {
    super(
      `备份文件来自更新版本的 App（schemaVersion ${fileVersion}，本机 ${databaseVersion}），` +
        '请先升级 App 再导入。本机的账一笔没动。'
    );
    this.name = 'BackupSchemaTooNewError';
  }
}

/**
 * Local wall-clock time with its numeric UTC offset, e.g.
 * 2026-10-23T12:00:00+08:00. The plan's example uses a local offset, and the
 * rest of the app treats dates as local calendar values; toISOString() would
 * silently move the timestamp to UTC. This is metadata only, never money.
 */
function localTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`
  );
}

/**
 * True only for a JSON-safe value that matches the column's declared kind:
 * INTEGER columns accept safe integers, TEXT columns accept strings, and NULL
 * is passed through for the database to accept or reject.
 */
function isValidCell(integer: boolean, value: unknown): value is BackupCell {
  if (value === null) return true;
  if (integer) return typeof value === 'number' && Number.isSafeInteger(value);
  return typeof value === 'string';
}

/** Copies exactly the declared columns, in schema order, without converting. */
function toBackupRow(
  table: BackupTable,
  raw: Record<string, unknown>,
  columns: readonly string[]
): BackupRow {
  const { integerColumns } = TABLE_SPECS[table];
  const row: BackupRow = {};
  for (const column of columns) {
    const value = raw[column];
    if (!isValidCell(integerColumns.includes(column), value)) {
      throw new Error(`数据库的 ${table}.${column} 不符合备份格式。`);
    }
    row[column] = value;
  }
  return row;
}

/**
 * Reads every row of every table plus the current schema version.
 *
 * Tables are read in dependency order and every table is present even when it
 * has no rows. Counts come from the rows actually read, so the file can always
 * be checked against itself before anything is restored.
 */
export async function buildBackup(db: Db): Promise<BackupFile> {
  const versionRow = await db.get<{ version: number | null }>(
    'SELECT MAX(version) AS version FROM schema_migrations'
  );

  const tables = {} as Record<BackupTable, BackupRow[]>;
  const counts = {} as Record<BackupTable, number>;

  for (const table of BACKUP_TABLES) {
    const { columns } = TABLE_SPECS[table];
    // rowid order preserves the order rows were created in and is stable for
    // every table in this schema (none uses WITHOUT ROWID).
    // Categories are the only self-referencing table: parents must be inserted
    // before their children, and rowid order alone does not promise that (a
    // child is always created after its parent today, but nothing enforces the
    // dump order). Parents first, then rowid for a stable file.
    const orderBy = table === 'category' ? 'parent_id IS NULL DESC, rowid' : 'rowid';
    const rows = await db.all<Record<string, unknown>>(
      `SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${orderBy}`
    );
    tables[table] = rows.map(raw => toBackupRow(table, raw, columns));
    counts[table] = rows.length;
  }

  return {
    magic: 'ledger-backup',
    formatVersion: 1,
    schemaVersion: versionRow?.version ?? 0,
    exportedAt: localTimestamp(new Date()),
    counts,
    tables,
  };
}

/** Canonical key order for one row: declared columns first, then anything else. */
function orderedRow(row: BackupRow, columns: readonly string[]): BackupRow {
  const ordered: BackupRow = {};
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(row, column)) {
      ordered[column] = row[column];
    }
  }
  // Unknown keys cannot come from parseBackup, which rejects them. If a caller
  // hands us one anyway, keep it in a deterministic position rather than
  // silently dropping data.
  for (const key of Object.keys(row).sort()) {
    if (!columns.includes(key)) ordered[key] = row[key];
  }
  return ordered;
}

/**
 * Pretty-printed v1 JSON with the same key order on every platform: top-level
 * fields, then counts, then tables in foreign-key order, and within each row
 * the columns in schema order. Object insertion order is therefore irrelevant.
 */
export function serializeBackup(file: BackupFile): string {
  const counts: Record<string, number> = {};
  for (const table of BACKUP_TABLES) {
    counts[table] = file.counts[table];
  }

  const tables: Record<string, BackupRow[]> = {};
  for (const table of BACKUP_TABLES) {
    tables[table] = file.tables[table].map(row => orderedRow(row, TABLE_SPECS[table].columns));
  }

  const ordered = {
    magic: file.magic,
    formatVersion: file.formatVersion,
    schemaVersion: file.schemaVersion,
    exportedAt: file.exportedAt,
    counts,
    tables,
  };
  return JSON.stringify(ordered, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBackupTable(value: string): value is BackupTable {
  return (BACKUP_TABLES as readonly string[]).includes(value);
}

function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

function parseCounts(value: unknown): Record<BackupTable, number> {
  if (!isRecord(value)) {
    throw new Error('备份文件缺少 counts 对象。');
  }

  const counts = {} as Record<BackupTable, number>;
  for (const table of BACKUP_TABLES) {
    if (!(table in value)) {
      // An older file simply never knew this table; it had zero rows.
      if (isOptionalTable(table)) {
        counts[table] = 0;
        continue;
      }
      throw new Error(`备份文件的 counts 缺少表 ${table}。`);
    }
    const count = value[table];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`备份文件的 counts.${table} 必须是非负整数。`);
    }
    counts[table] = count;
  }

  for (const key of Object.keys(value)) {
    if (!isBackupTable(key)) {
      throw new Error(`备份文件的 counts 含有未知表 ${key}。`);
    }
  }

  return counts;
}

function parseRow(table: BackupTable, value: unknown, index: number): BackupRow {
  const where = `备份文件的 ${table} 表第 ${index + 1} 行`;
  if (!isRecord(value)) {
    throw new Error(`${where}必须是对象。`);
  }

  const keys = Object.keys(value);
  if (keys.length === 0) {
    throw new Error(`${where}不能是空对象。`);
  }

  const { columns, integerColumns } = TABLE_SPECS[table];
  for (const key of keys) {
    if (!columns.includes(key)) {
      throw new Error(`${where}含有未知字段：${key}。`);
    }
  }

  const row: BackupRow = {};
  for (const column of columns) {
    if (!Object.prototype.hasOwnProperty.call(value, column)) continue;
    const integer = integerColumns.includes(column);
    const cell = value[column];
    if (!isValidCell(integer, cell)) {
      throw new Error(
        `${where}的字段 ${column} 必须是${integer ? '整数' : '字符串'}或 null。`
      );
    }
    row[column] = cell;
  }

  return row;
}

function parseTables(value: unknown): Record<BackupTable, BackupRow[]> {
  if (!isRecord(value)) {
    throw new Error('备份文件缺少 tables 对象。');
  }

  for (const table of BACKUP_TABLES) {
    if (!(table in value)) {
      // Pre-v3 files have no project array at all; that is an empty table.
      if (!isOptionalTable(table)) {
        throw new Error(`备份文件的 tables 缺少数据表：${table}。`);
      }
    }
  }
  for (const key of Object.keys(value)) {
    if (!isBackupTable(key)) {
      throw new Error(`备份文件的 tables 含有未知数据表：${key}。`);
    }
  }

  const tables = {} as Record<BackupTable, BackupRow[]>;
  for (const table of BACKUP_TABLES) {
    if (!(table in value)) {
      // Already proven optional above.
      tables[table] = [];
      continue;
    }
    const rows = value[table];
    if (!Array.isArray(rows)) {
      throw new Error(`备份文件的 tables.${table} 必须是数组。`);
    }
    tables[table] = rows.map((row, index) => parseRow(table, row, index));
  }
  return tables;
}

/**
 * Parses and validates one backup file.
 *
 * Everything is checked before the caller can reach restoreBackup, so a bad
 * file cannot start a transaction. The check covers the format envelope, the
 * eight table arrays (project may be absent in a pre-v3 file), and each row's
 * shape and column kinds (TEXT columns hold
 * strings, INTEGER columns hold safe integers, and NULL is allowed). Values
 * are still subject to the schema's own constraints when restored, which is
 * where foreign keys and CHECKs are enforced. counts is shape-checked here but intentionally not
 * compared with the array lengths: restoreBackup owns that check so it can
 * roll back a lying file.
 */
export function parseBackup(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error('备份文件不是有效的 JSON，无法解析。', { cause });
  }

  if (!isRecord(raw)) {
    throw new Error('备份文件的根节点必须是一个对象。');
  }
  if (raw.magic !== 'ledger-backup') {
    throw new Error('这不是记账本备份文件：magic 字段不是 ledger-backup。');
  }
  if (raw.formatVersion !== 1) {
    throw new Error(
      `备份文件的格式版本（formatVersion）是 ${show(raw.formatVersion)}，当前只支持 1。`
    );
  }
  if (
    typeof raw.schemaVersion !== 'number' ||
    !Number.isSafeInteger(raw.schemaVersion) ||
    raw.schemaVersion < 0
  ) {
    throw new Error('备份文件的 schemaVersion 必须是非负整数。');
  }
  if (typeof raw.exportedAt !== 'string' || raw.exportedAt.trim() === '') {
    throw new Error('备份文件缺少导出时间（exportedAt）。');
  }

  return {
    magic: 'ledger-backup',
    formatVersion: 1,
    schemaVersion: raw.schemaVersion,
    exportedAt: raw.exportedAt,
    counts: parseCounts(raw.counts),
    tables: parseTables(raw.tables),
  };
}

/**
 * Writes one row using only the columns the file actually carries.
 *
 * A column absent from the row is left to its schema DEFAULT. In v1
 * buildBackup always emits every column; this keeps a file from an older
 * schema version restorable without inventing NULLs for new defaulted columns.
 */
async function insertRow(
  db: Db,
  table: BackupTable,
  columns: readonly string[],
  row: BackupRow
): Promise<void> {
  const { integerColumns } = TABLE_SPECS[table];
  const present: string[] = [];
  const params: DbParam[] = [];

  // Final type guard at the database boundary. parseBackup already checked
  // this, but a caller that hands restoreBackup an object directly must not be
  // able to put text into amount_cents (SQLite would accept it silently).
  for (const column of columns) {
    if (!Object.prototype.hasOwnProperty.call(row, column)) continue;
    const cell = row[column];
    if (!isValidCell(integerColumns.includes(column), cell)) {
      throw new Error(`字段 ${column} 的类型不符合数据库列定义。`);
    }
    present.push(column);
    params.push(cell);
  }

  if (present.length === 0) {
    throw new Error('这一行没有任何列，无法写入。');
  }

  await db.run(
    `INSERT INTO ${table} (${present.join(', ')}) VALUES (${present
      .map(() => '?')
      .join(', ')})`,
    params
  );
}

/**
 * Replaces the whole database with one file, atomically.
 *
 * One transaction deletes all eight tables in reverse foreign-key order and
 * then inserts them in forward order. After each table the actual row count is
 * compared with counts; a disagreement throws, and the driver's transaction
 * wrapper rolls everything back so the local ledger is untouched.
 *
 * A file from a newer schema is refused before the transaction opens, with a
 * distinct error. A file from an older schema is allowed: this slice has no
 * historical versions, but the version gate deliberately does not reject down,
 * and insertRow already tolerates columns that did not exist yet.
 *
 * The caller must hand in a file produced by buildBackup or parseBackup; parse
 * has already checked the envelope and row shapes, so this function only deals
 * with database-level constraints and the counts agreement.
 */
export async function restoreBackup(db: Db, file: BackupFile): Promise<void> {
  const versionRow = await db.get<{ version: number | null }>(
    'SELECT MAX(version) AS version FROM schema_migrations'
  );
  const databaseVersion = versionRow?.version ?? 0;
  if (file.schemaVersion > databaseVersion) {
    throw new BackupSchemaTooNewError(file.schemaVersion, databaseVersion);
  }

  await db.transaction(async tx => {
    // Exact reverse of BACKUP_TABLES: children before their parents.
    for (const table of [...BACKUP_TABLES].reverse()) {
      await tx.run(`DELETE FROM ${table}`);
    }

    for (const table of BACKUP_TABLES) {
      const { columns } = TABLE_SPECS[table];
      const rows = file.tables[table];
      if (!Array.isArray(rows)) {
        throw new Error(
          `备份文件的 tables.${table} 必须是数组，导入已取消，本机的账一笔没动。`
        );
      }

      for (let index = 0; index < rows.length; index += 1) {
        try {
          await insertRow(tx, table, columns, rows[index]);
        } catch (cause) {
          throw new Error(
            `备份文件的 ${table} 表第 ${index + 1} 行无法写入，导入已取消，本机的账一笔没动。`,
            { cause }
          );
        }
      }

      const countRow = await tx.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      const actual = countRow?.n ?? 0;
      if (table === 'category') {
        // A file written before migration v2 has no system 未分类 row. Without
        // it, deleting a category later cannot reflow its transactions and the
        // foreign key refuses the update. Restoring a file is not the place to
        // run the whole migration chain, but this one row is the difference
        // between a usable ledger and a broken delete.
        await tx.run(
          `INSERT OR IGNORE INTO category (id, parent_id, name, kind, sort, archived_at)
           VALUES (?, NULL, ?, 'expense', ?, NULL)`,
          [UNCATEGORIZED_CATEGORY_ID, UNCATEGORIZED_CATEGORY_NAME, UNCATEGORIZED_CATEGORY_SORT]
        );
      }
      if (actual !== file.counts[table]) {
        throw new Error(
          `备份文件的 ${table} 表行数与 counts 不符（counts.${table} 为 ${file.counts[table]}，` +
            `实际写入 ${actual} 行），导入已取消，本机的账一笔没动。`
        );
      }
    }
  });
}
