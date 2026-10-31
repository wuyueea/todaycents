import { describe, it, expect } from 'vitest';
import {
  backupFileName,
  backupMetaLine,
  beforeBackupFileName,
  exportToast,
  fileSizeText,
  formatBackupTime,
  importDoneToast,
  importFailureCopy,
  importSummary,
  lastBackupTitle,
  resetDoneToast,
  resetFailureText,
  resetSummary,
  settingsBackupLine,
  utf8ByteLength,
} from '../../src/backup/format';
import type { BackupMeta } from '../../src/backup/format';
import { BackupSchemaTooNewError } from '../../src/db/backup';

/** Local wall-clock fixture: 2026-10-23 13:05:07, timezone-independent. */
const NOW = new Date(2026, 9, 23, 13, 5, 7);

function meta(overrides: Partial<BackupMeta> = {}): BackupMeta {
  return { at: NOW.toISOString(), rows: 231, bytes: 46 * 1024, ...overrides };
}

describe('backup file names', () => {
  it('stamps the local date and minute, never the UTC day', () => {
    expect(backupFileName(NOW)).toBe('记账本-20261023-1305.ledger');
    expect(backupFileName(new Date(2026, 0, 2, 3, 4))).toBe('记账本-20260102-0304.ledger');
  });

  it('marks the automatic before-copy without losing the .ledger extension', () => {
    expect(beforeBackupFileName(NOW)).toBe('记账本-20261023-1305-before.ledger');
  });
});

describe('fileSizeText', () => {
  it('uses B, KB and MB, with whole KB for a ledger-sized file', () => {
    expect(fileSizeText(0)).toBe('0 B');
    expect(fileSizeText(999)).toBe('999 B');
    expect(fileSizeText(1024)).toBe('1 KB');
    expect(fileSizeText(46 * 1024)).toBe('46 KB');
    expect(fileSizeText(1024 * 1024)).toBe('1.0 MB');
    expect(fileSizeText(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('rejects negative or non-integer byte counts instead of formatting them', () => {
    expect(() => fileSizeText(-1)).toThrow(RangeError);
    expect(() => fileSizeText(1.5)).toThrow(RangeError);
  });
});

describe('utf8ByteLength', () => {
  it('counts bytes, not JavaScript code units', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('账本')).toBe(6);
  });
});

describe('formatBackupTime', () => {
  it('says 刚刚 for a backup less than a minute old', () => {
    expect(formatBackupTime(NOW.toISOString(), NOW)).toBe('刚刚');
  });

  it('uses 今天, 昨天 and month-day for older backups', () => {
    expect(formatBackupTime(new Date(2026, 9, 23, 12, 55).toISOString(), NOW)).toBe('今天 12:55');
    expect(formatBackupTime(new Date(2026, 9, 22, 22, 14).toISOString(), NOW)).toBe('昨天 22:14');
    expect(formatBackupTime(new Date(2026, 9, 20, 22, 14).toISOString(), NOW)).toBe(
      '10月20日 22:14'
    );
    expect(formatBackupTime(new Date(2025, 11, 31, 22, 14).toISOString(), NOW)).toBe(
      '2025年12月31日 22:14'
    );
  });

  it('handles absent and unreadable timestamps without throwing', () => {
    expect(formatBackupTime(null, NOW)).toBe('');
    expect(formatBackupTime('', NOW)).toBe('');
    expect(formatBackupTime('not a date', NOW)).toBe('时间未知');
  });
});

describe('backup copy', () => {
  it('draws the last-backup title and the settings row line', () => {
    const yesterday = meta({ at: new Date(2026, 9, 22, 22, 14).toISOString() });
    expect(lastBackupTitle(yesterday, NOW)).toBe('昨天 22:14');
    expect(lastBackupTitle(null, NOW)).toBe('还没有备份');
    expect(settingsBackupLine(yesterday, NOW)).toBe('上次备份 · 昨天 22:14');
    expect(settingsBackupLine(null, NOW)).toBe('还没有备份');
  });

  it('summarises rows and size under the last-backup title', () => {
    expect(backupMetaLine(meta())).toBe('231 笔流水 · 46 KB');
  });

  it('reports export and import in one line, with the file name', () => {
    expect(exportToast({ fileName: '记账本-20261023-1305.ledger', bytes: 46 * 1024 })).toBe(
      '已导出「记账本-20261023-1305.ledger」 · 46 KB'
    );
    expect(importDoneToast({ fileName: '记账本-20261023-1305.ledger', rows: 231 })).toBe(
      '已导入「记账本-20261023-1305.ledger」 · 231 笔'
    );
  });

  it('states file rows, local rows and whole-ledger replacement', () => {
    const summary = importSummary({ fileRows: 231, localRows: 12 });
    expect(summary).toContain('本机现在有 12 笔');
    expect(summary).toContain('文件里有 231 笔');
    expect(summary).toContain('会整体替换');
    expect(summary).toContain('不能撤销');
  });
});

describe('importFailureCopy', () => {
  it('ends every ordinary failure with the promise that local data is untouched', () => {
    const copy = importFailureCopy(new Error('备份文件不是有效的 JSON，无法解析。'));
    expect(copy.title).toBe('导入失败');
    expect(copy.reason).toContain('JSON');
    expect(copy.advice.endsWith('本机的账一笔没动。')).toBe(true);
  });

  it('uses the plan copy verbatim for a schema that is too new', () => {
    const copy = importFailureCopy(new BackupSchemaTooNewError(99, 1));
    expect(copy.title).toBe('导入失败');
    expect(copy.reason).toContain('schemaVersion 99');
    expect(copy.advice).toBe(
      '升级 App 之后再导入，或者用导出它的那台设备重新导一份。本机的账一笔没动。'
    );
    // The advice owns the ending; the reason must not repeat it.
    expect(copy.reason).not.toContain('本机的账一笔没动。');
  });

  it('strips a trailing no-change promise from restore errors before showing the advice', () => {
    const copy = importFailureCopy(new Error('备份文件的 txn 表行数与 counts 不符，导入已取消，本机的账一笔没动。'));
    expect(copy.reason.endsWith('本机的账一笔没动。')).toBe(false);
    expect(copy.advice.endsWith('本机的账一笔没动。')).toBe(true);
  });

  it('turns a non-Error rejection into readable text', () => {
    expect(importFailureCopy('磁盘已满').reason).toBe('磁盘已满');
  });
});

describe('reset copy', () => {
  const counts = { txn: 5, account: 7, category: 13, tag: 2, project: 2 };

  it('states exactly what 清除所有数据 removes, one count at a time', () => {
    expect(resetSummary(counts)).toBe(
      '将删除 5 笔流水、7 个账户、13 个分类、2 个标签、2 个项目。'
    );
    expect(resetSummary({ txn: 0, account: 6, category: 12, tag: 0, project: 0 })).toBe(
      '将删除 0 笔流水、6 个账户、12 个分类、0 个标签、0 个项目。'
    );
  });

  it('names the automatic backup file in the success toast', () => {
    expect(resetDoneToast({ beforeFileName: '记账本-20261023-1305-before.ledger' })).toBe(
      '已清除所有数据 · 备份「记账本-20261023-1305-before.ledger」'
    );
  });

  it('keeps the untouched-data promise on every failure, without doubling the stop', () => {
    expect(resetFailureText(new Error('缓存不可写'))).toBe(
      '清除失败：缓存不可写。本机的账一笔没动。'
    );
    expect(resetFailureText(new Error('已取消。'))).toBe('清除失败：已取消。本机的账一笔没动。');
    expect(resetFailureText('磁盘已满')).toBe('清除失败：磁盘已满。本机的账一笔没动。');
  });
});

