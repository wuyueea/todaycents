/**
 * The copy and formatting the backup screens share.
 *
 * Everything here is pure: no database, no device, no clock of its own (the
 * caller passes "now"). That keeps the exact 文案 unit-testable and keeps the
 * screens free of date arithmetic.
 *
 * The copy follows docs/原型交接说明.md §4.1 / §7. The three app_meta keys are
 * the ones the plan names; nothing else is written.
 */
import { BackupSchemaTooNewError } from '../db/backup';
import type { ResetCounts } from '../db/reset';

/** What app_meta remembers about the last successful export. */
export interface BackupMeta {
  /** ISO-8601 instant, stored verbatim and formatted in local time. */
  at: string;
  /** Transaction rows in that backup (the plan's "笔流水"). */
  rows: number;
  /** Size of the serialised JSON, in bytes. */
  bytes: number;
}

/** The exact app_meta keys the plan asks for. */
export const BACKUP_META_KEYS = {
  at: 'last_backup_at',
  rows: 'last_backup_rows',
  bytes: 'last_backup_bytes',
} as const;

const UNTOUCHED = '本机的账一笔没动。';

/** §7 导入失败补充, verbatim. */
const UPGRADE_ADVICE =
  '升级 App 之后再导入，或者用导出它的那台设备重新导一份。本机的账一笔没动。';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYYMMDD in local wall-clock time, as the file name requires. */
function dateStamp(date: Date): string {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

/** HHmm in local wall-clock time. */
function timeStamp(date: Date): string {
  return `${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

/** 记账本-YYYYMMDD-HHmm.ledger — local time, never the UTC day. */
export function backupFileName(date: Date): string {
  return `记账本-${dateStamp(date)}-${timeStamp(date)}.ledger`;
}

/**
 * The automatic pre-import copy. It keeps the .ledger extension so the same
 * file can be imported again, and carries the before marker §4.1 asks for.
 */
export function beforeBackupFileName(date: Date): string {
  return `记账本-${dateStamp(date)}-${timeStamp(date)}-before.ledger`;
}

/**
 * Human-readable byte count. A ledger is small, so KB is the unit that matters
 * (46 KB in the prototype); MB only appears if a file actually grows that big.
 */
export function fileSizeText(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError(`fileSizeText expects a non-negative integer, received ${bytes}`);
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** UTF-8 byte length, not JavaScript code-unit length (Chinese is 3 bytes). */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Local calendar key, used to tell 今天 / 昨天 apart across DST and offsets. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function clock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * The big "上次备份" value: 刚刚 / 今天 22:14 / 昨天 22:14 / 10月20日 22:14,
 * and the year too when the backup is from an earlier year.
 */
export function formatBackupTime(value: string | null, now: Date): string {
  if (value === null || value.trim() === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';

  if (dayKey(date) === dayKey(now)) {
    const ageMs = now.getTime() - date.getTime();
    if (ageMs >= 0 && ageMs < 60_000) return '刚刚';
    return `今天 ${clock(date)}`;
  }

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return `昨天 ${clock(date)}`;

  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  if (date.getFullYear() === now.getFullYear()) return `${monthDay} ${clock(date)}`;
  return `${date.getFullYear()}年${monthDay} ${clock(date)}`;
}

/** The large value under 上次备份. */
export function lastBackupTitle(meta: BackupMeta | null, now: Date): string {
  return meta === null ? '还没有备份' : formatBackupTime(meta.at, now);
}

/** The settings row's quiet second line (§4.7: every row carries its state). */
export function settingsBackupLine(meta: BackupMeta | null, now: Date): string {
  return meta === null ? '还没有备份' : `上次备份 · ${formatBackupTime(meta.at, now)}`;
}

/** "231 笔流水 · 46 KB", under the 上次备份 value. */
export function backupMetaLine(meta: BackupMeta): string {
  return `${meta.rows} 笔流水 · ${fileSizeText(meta.bytes)}`;
}

/** "231 笔 · 46 KB", for the file card in the import sheet. */
export function backupFileMeta(rows: number, bytes: number): string {
  return `${rows} 笔 · ${fileSizeText(bytes)}`;
}

/** Export success toast; it names the file and its size, never a fake location. */
export function exportToast(result: { fileName: string; bytes: number }): string {
  return `已导出「${result.fileName}」 · ${fileSizeText(result.bytes)}`;
}

/** Import success toast, shown on 设置 after the sheet closes. */
export function importDoneToast(result: { fileName: string; rows: number }): string {
  return `已导入「${result.fileName}」 · ${result.rows} 笔`;
}

/**
 * The confirmation body: file rows, local rows, and the fact that this is a
 * replacement rather than a merge. "会整体替换" is deliberately literal.
 */
export function importSummary(result: { fileRows: number; localRows: number }): string {
  return (
    `本机现在有 ${result.localRows} 笔，文件里有 ${result.fileRows} 笔。` +
    '导入后会整体替换本机的账——当前的记录不保留，也不能撤销。'
  );
}

/** Everything the failure sheet shows, split so the advice can stay verbatim. */
export interface ImportFailureCopy {
  title: '导入失败';
  reason: string;
  advice: string;
}

/**
 * Turns any parse/restore rejection into the failure sheet's copy.
 *
 * A newer schema is the one case with actionable advice (§7's upgrade line).
 * Every other failure still ends with the promise the plan requires; the
 * codec's own messages already end that way, so the duplicate sentence is
 * stripped before the advice is appended.
 */
export function importFailureCopy(error: unknown): ImportFailureCopy {
  const raw = error instanceof Error ? error.message : String(error);
  const reason = raw.trim().replace(/本机的账一笔没动。$/, '').trim();
  const isTooNew = error instanceof BackupSchemaTooNewError;
  return {
    title: '导入失败',
    reason: reason === '' ? '这个文件读不了。' : reason,
    advice: isTooNew ? UPGRADE_ADVICE : UNTOUCHED,
  };
}

/**
 * What 清除所有数据 takes away, count by count. Every number is a row the wipe
 * removes (archived rows included; the system 未分类 row excluded because it
 * comes straight back), so the sheet says what will actually happen rather
 * than what the pickers happen to show.
 */
export function resetSummary(counts: ResetCounts): string {
  return (
    `将删除 ${counts.txn} 笔流水、${counts.account} 个账户、${counts.category} 个分类、` +
    `${counts.tag} 个标签、${counts.project} 个项目。`
  );
}

/**
 * Reset success toast. It names the automatic before-copy, because that file
 * is the only way back — the reset itself is not undoable.
 */
export function resetDoneToast(result: { beforeFileName: string }): string {
  return `已清除所有数据 · 备份「${result.beforeFileName}」`;
}

/**
 * Reset failure line: the reason, then the same promise the import failures
 * make. It is true for every path — a failed backup copy never reaches the
 * delete, and a failed delete rolls back its transaction.
 */
export function resetFailureText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const reason = raw.trim().replace(/。$/, '');
  return `清除失败：${reason === '' ? '原因未知' : reason}。${UNTOUCHED}`;
}

