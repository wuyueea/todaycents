import { describe, it, expect } from 'vitest';
import type { Db } from '../../src/db/driver';
import { buildBackup, parseBackup, serializeBackup, BackupSchemaTooNewError } from '../../src/db/backup';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';
import { archiveAccount, listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import { createExpense, listTxnsByMonth, softDeleteTxn } from '../../src/db/repos/txns';
import {
  confirmImport,
  exportBackup,
  exportMetaAction,
  prepareImport,
  resetWithBackup,
} from '../../src/backup/flow';
import { countTxnRows, readBackupMeta, readRestoreMeta, recordBackupMeta, recordRestoreMeta } from '../../src/backup/meta';
import type { BackupFileWriter } from '../../src/backup/flow';
import { beforeBackupFileName, utf8ByteLength } from '../../src/backup/format';
import { failingDb } from '../helpers/failingDb';

const NOW = new Date(2026, 9, 23, 13, 5, 7);
const LEDGER_NAME = '记账本-20261023-130507.ledger';
const LOCAL_BACKUP = { at: '2026-10-22T11:00:00+08:00', rows: 5, bytes: 2048 };
const LOCAL_RESTORE = {
  restoredAt: '2026-10-22T10:00:00+08:00',
  sourceExportedAt: '2026-10-21T15:00:00+08:00',
};

interface WrittenFile {
  fileName: string;
  text: string;
}

/** An in-memory stand-in for the cache + share sheet, so no device is needed. */
function memoryWriter(): BackupFileWriter & {
  shared: WrittenFile[];
  copies: WrittenFile[];
} {
  const shared: WrittenFile[] = [];
  const copies: WrittenFile[] = [];
  return {
    shared,
    copies,
    async writeForShare(fileName, text) {
      shared.push({ fileName, text });
      return { kind: 'folder', folderName: 'Books' };
    },
    async writeCopy(fileName, text) {
      copies.push({ fileName, text });
      return { kind: 'cache', uri: `file:///cache/${fileName}` };
    },
  };
}

async function seedExpense(db: Db, amountCents: number, note: string, date = '2026-10-20'): Promise<string> {
  const account = (await listAccounts(db))[0];
  const category = (await listCategories(db)).find(candidate => candidate.name === '饮食');
  if (account === undefined || category === undefined) throw new Error('seed is incomplete');
  return createExpense(db, {
    date,
    accountId: account.id,
    amountCents,
    categoryId: category.id,
    note,
  });
}

async function sourceBackupText(amountCents = 1230, note = 'source'): Promise<{ text: string; id: string }> {
  const source = await createTestDb();
  await seedDefaults(source);
  const id = await seedExpense(source, amountCents, note);
  return { text: serializeBackup(await buildBackup(source)), id };
}

describe('exportBackup', () => {
  it('reports the real folder filename when the system numbers a duplicate', async () => {
    const db = await createTestDb();
    const writer = memoryWriter();
    writer.writeForShare = async () => ({ kind: 'folder', folderName: 'Books', fileName: '备份 (2).ledger' });
    expect((await exportBackup(db, writer, NOW)).fileName).toBe('备份 (2).ledger');
  });

  it('writes the same JSON it can parse back and reports where it went', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    await seedExpense(db, 1230, '午饭');
    const writer = memoryWriter();

    const result = await exportBackup(db, writer, NOW);

    expect(result.fileName).toBe(LEDGER_NAME);
    expect(result.rows).toBe(1);
    expect(writer.shared).toHaveLength(1);
    expect(writer.shared[0].fileName).toBe(LEDGER_NAME);

    const text = writer.shared[0].text;
    const parsed = parseBackup(text);
    expect(parsed.counts.txn).toBe(1);
    expect(parsed.tables.txn[0].amount_cents).toBe(-1230);
    expect(result.bytes).toBe(utf8ByteLength(text));

    expect(result.meta).toEqual({ at: NOW.toISOString(), rows: 1, bytes: result.bytes });
    expect(result.destination).toEqual({ kind: 'folder', folderName: 'Books' });
    // The screen records a shared backup only after the owner confirms the save.
    expect(await readBackupMeta(db)).toBeNull();
  });

  it('records nothing when the writer fails before any destination exists', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    const writer: BackupFileWriter = {
      async writeForShare() {
        throw new Error('没有空间');
      },
      async writeCopy() {
        return { kind: 'none' };
      },
    };

    await expect(exportBackup(db, writer, NOW)).rejects.toThrow('没有空间');
    expect(await readBackupMeta(db)).toBeNull();
  });
});

describe('exportMetaAction', () => {
  it('records a real file, asks before a share, and never records a cancel', () => {
    expect(exportMetaAction({ kind: 'folder', folderName: 'Books' })).toBe('record');
    expect(exportMetaAction({ kind: 'download' })).toBe('record');
    expect(exportMetaAction({ kind: 'share' })).toBe('ask');
    expect(exportMetaAction({ kind: 'share' }, true)).toBe('record');
    expect(exportMetaAction({ kind: 'canceled' })).toBe('none');
    expect(exportMetaAction({ kind: 'canceled' }, true)).toBe('none');
  });
});

describe('prepareImport', () => {
  it('reads the file rows and counts the local transaction rows before asking', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    await seedExpense(db, 100, 'local one');
    await seedExpense(db, 200, 'local two');
    const { text } = await sourceBackupText();

    const prepared = await prepareImport(db, text, LEDGER_NAME, utf8ByteLength(text));

    expect(prepared.fileName).toBe(LEDGER_NAME);
    expect(prepared.fileRows).toBe(1);
    expect(prepared.fileDateRange).toEqual({ start: '2026-10-20', end: '2026-10-20' });
    expect(prepared.fileActiveAccounts).toBe(3);
    expect(prepared.localRows).toBe(2);
    expect(prepared.exportedAt).toBe(parseBackup(text).exportedAt);
  });

  it('summarizes dates and unarchived accounts from the file before replacing anything', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    const source = await createTestDb();
    await seedDefaults(source);
    const newest = await seedExpense(source, 1200, 'newest', '2026-10-21');
    const oldest = await seedExpense(source, 500, 'oldest', '2025-12-30');
    const deleted = await seedExpense(source, 200, 'deleted', '2024-02-29');
    await softDeleteTxn(source, deleted);
    const [account] = await listAccounts(source);
    await archiveAccount(source, account!.id);
    const file = await buildBackup(source);
    // These optional markers were not always present in old files.
    delete file.tables.txn.find(row => row.id === newest)!.deleted_at;
    delete file.tables.account.find(row => row.id !== account!.id)!.archived_at;
    const text = serializeBackup(file);

    const prepared = await prepareImport(db, text, LEDGER_NAME, utf8ByteLength(text));

    expect(prepared.fileDateRange).toEqual({ start: '2025-12-30', end: '2026-10-21' });
    expect(prepared.fileActiveAccounts).toBe(2);
    expect(prepared.fileRows).toBe(3);
    expect(prepared.localRows).toBe(0);

    await softDeleteTxn(source, newest);
    await softDeleteTxn(source, oldest);
    const onlyDeleted = serializeBackup(await buildBackup(source));
    expect((await prepareImport(db, onlyDeleted, LEDGER_NAME, utf8ByteLength(onlyDeleted))).fileDateRange).toBeNull();
  });

  it('rejects a non-JSON file before any write', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    await expect(prepareImport(db, '{', 'broken.ledger', 1)).rejects.toThrow(/JSON/);
    expect(await countTxnRows(db)).toBe(0);
  });

  it('rejects a file carrying a future day before the confirmation sheet', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    const raw = JSON.parse((await sourceBackupText()).text) as {
      tables: { txn: Array<{ occurred_date: string }> };
    };
    raw.tables.txn[0].occurred_date = '2999-01-01';

    await expect(
      prepareImport(db, JSON.stringify(raw), 'future.ledger', 10)
    ).rejects.toThrow(/晚于今天/);
    expect(await countTxnRows(db)).toBe(0);
  });

  it('rejects a file from a newer schema with the exported error class', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    const raw = JSON.parse((await sourceBackupText()).text) as Record<string, unknown>;
    raw.schemaVersion = 99;

    await expect(
      prepareImport(db, JSON.stringify(raw), 'future.ledger', 10)
    ).rejects.toBeInstanceOf(BackupSchemaTooNewError);
  });
});

describe('confirmImport', () => {
  it('writes a before copy first, then replaces the whole ledger', async () => {
    const target = await createTestDb();
    await seedDefaults(target);
    const localId = await seedExpense(target, 500, 'local');
    const { text, id: sourceId } = await sourceBackupText(1230, 'from file');
    const prepared = await prepareImport(target, text, LEDGER_NAME, utf8ByteLength(text));
    const writer = memoryWriter();

    const result = await confirmImport(target, prepared, writer, NOW);

    expect(result.rows).toBe(1);
    expect(result.beforeFileName).toBe(beforeBackupFileName(NOW));
    expect(result.beforeDestination).toEqual({
      kind: 'cache',
      uri: `file:///cache/${beforeBackupFileName(NOW)}`,
    });
    expect(writer.copies).toHaveLength(1);
    expect(writer.copies[0].fileName).toBe(beforeBackupFileName(NOW));

    const before = parseBackup(writer.copies[0].text);
    expect(before.counts.txn).toBe(1);
    expect(before.tables.txn[0].id).toBe(localId);

    expect(await countTxnRows(target)).toBe(1);
    const restored = await listTxnsByMonth(target, '2026-10');
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe(sourceId);
    expect(restored[0].note).toBe('from file');
  });

  it.each([LOCAL_BACKUP, null])('uses device history when importing a file with old backup keys (%j)', async localBackup => {
    const target = await createTestDb();
    await seedDefaults(target);
    if (localBackup !== null) await recordBackupMeta(target, localBackup);
    const legacy = parseBackup((await sourceBackupText()).text);
    legacy.exportedAt = '2026-10-21T20:00:00+08:00';
    legacy.tables.app_meta = [
      { key: 'last_backup_at', value: '2026-10-20T08:00:00+08:00' },
      { key: 'last_backup_rows', value: '12' },
      { key: 'last_backup_bytes', value: '4096' },
      { key: 'last_restore', value: JSON.stringify(LOCAL_RESTORE) },
      { key: '备注', value: '跟随账本' },
    ];
    legacy.counts.app_meta = legacy.tables.app_meta.length;
    const text = serializeBackup(legacy);
    const prepared = await prepareImport(target, text, LEDGER_NAME, utf8ByteLength(text));

    await confirmImport(target, prepared, memoryWriter(), NOW);

    expect(await readBackupMeta(target)).toEqual(localBackup);
    expect(await readRestoreMeta(target)).toEqual({
      restoredAt: NOW.toISOString(),
      sourceExportedAt: legacy.exportedAt,
    });
    const exportedAgain = await buildBackup(target);
    expect(exportedAgain.counts.app_meta).toBe(1);
    expect(exportedAgain.tables.app_meta).toEqual([{ key: '备注', value: '跟随账本' }]);
  });

  it('rolls back the ledger and keeps device history when recording a restore fails', async () => {
    const target = await createTestDb();
    await seedDefaults(target);
    await seedExpense(target, 500, 'keep me');
    await recordBackupMeta(target, LOCAL_BACKUP);
    await recordRestoreMeta(target, LOCAL_RESTORE);
    const { text } = await sourceBackupText();
    const prepared = await prepareImport(target, text, LEDGER_NAME, utf8ByteLength(text));
    const writer = memoryWriter();
    const unavailable = failingDb(target, sql => /INSERT INTO app_meta/.test(sql), 'disk full');

    await expect(confirmImport(unavailable, prepared, writer, NOW)).rejects.toThrow('disk full');

    expect(writer.copies).toHaveLength(1);
    expect((await listTxnsByMonth(target, '2026-10')).map(row => row.note)).toEqual(['keep me']);
    expect(await readBackupMeta(target)).toEqual(LOCAL_BACKUP);
    expect(await readRestoreMeta(target)).toEqual(LOCAL_RESTORE);
  });

  // The import toast has to be able to say what was repaired; a silent rewrite
  // of the owner's rows is the thing this whole fix is against.
  it('reports how many dangling project links it cleared', async () => {
    const target = await createTestDb();
    await seedDefaults(target);
    const { text } = await sourceBackupText(1230, 'from file');
    const raw = JSON.parse(text) as { tables: { txn: Record<string, unknown>[] } };
    raw.tables.txn[0].project_id = 'ghost-project';
    const prepared = await prepareImport(
      target,
      JSON.stringify(raw),
      LEDGER_NAME,
      utf8ByteLength(text)
    );
    const writer = memoryWriter();

    const result = await confirmImport(target, prepared, writer, NOW);

    expect(result.clearedProjectRefs).toBe(1);
    expect((await listTxnsByMonth(target, '2026-10'))[0].projectId).toBeNull();
  });

  it('leaves the local ledger untouched when the file lies about its counts', async () => {
    const target = await createTestDb();
    await seedDefaults(target);
    await seedExpense(target, 500, 'keep me');
    const raw = JSON.parse((await sourceBackupText()).text) as {
      counts: Record<string, number>;
    };
    raw.counts.txn = 2;
    const prepared = await prepareImport(target, JSON.stringify(raw), 'lying.ledger', 10);
    const writer = memoryWriter();

    await expect(confirmImport(target, prepared, writer, NOW)).rejects.toThrow(
      /本机的账一笔没动/
    );

    // The before copy exists even though the restore failed; the ledger did not move.
    expect(writer.copies).toHaveLength(1);
    expect(await countTxnRows(target)).toBe(1);
    expect((await listTxnsByMonth(target, '2026-10'))[0].note).toBe('keep me');
  });

  it('does not restore anything when the before copy cannot be written', async () => {
    const target = await createTestDb();
    await seedDefaults(target);
    await seedExpense(target, 500, 'keep me');
    const { text } = await sourceBackupText();
    const prepared = await prepareImport(target, text, LEDGER_NAME, utf8ByteLength(text));
    const writer: BackupFileWriter = {
      async writeForShare() {
        return { kind: 'download' };
      },
      async writeCopy() {
        throw new Error('缓存不可写');
      },
    };

    await expect(confirmImport(target, prepared, writer, NOW)).rejects.toThrow('缓存不可写');
    expect(await countTxnRows(target)).toBe(1);
    expect((await listTxnsByMonth(target, '2026-10'))[0].note).toBe('keep me');
  });
});

describe('resetWithBackup', () => {
  it('writes the automatic backup first, then wipes and reseeds', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    await seedExpense(db, 1230, 'keep me');
    await recordBackupMeta(db, LOCAL_BACKUP);
    await recordRestoreMeta(db, LOCAL_RESTORE);
    const writer = memoryWriter();
    let rowsWhenCopied: number | null = null;
    const observingWriter: BackupFileWriter = {
      async writeForShare() {
        return { kind: 'download' };
      },
      async writeCopy(fileName, text) {
        writer.copies.push({ fileName, text });
        // The copy is the safety net: the ledger must still be whole here.
        rowsWhenCopied = await countTxnRows(db);
        return { kind: 'cache', uri: `file:///cache/${fileName}` };
      },
    };

    const result = await resetWithBackup(db, observingWriter, NOW);

    expect(rowsWhenCopied).toBe(1);
    expect(result.beforeFileName).toBe(beforeBackupFileName(NOW));
    expect(result.beforeDestination).toEqual({
      kind: 'cache',
      uri: `file:///cache/${beforeBackupFileName(NOW)}`,
    });
    expect(writer.copies.map(file => file.fileName)).toEqual([beforeBackupFileName(NOW)]);
    // It is the pre-reset ledger, readable by the same codec an import uses.
    const copy = parseBackup(writer.copies[0].text);
    expect(copy.counts).toMatchObject({ txn: 1, account: 3, category: 13, template: 0 });
    expect(result.counts).toEqual({ txn: 1, account: 3, category: 12, tag: 0, project: 0 });

    // The reset copy stays in the cache: no second share sheet opens by itself.
    expect(writer.shared).toHaveLength(0);
    expect(await countTxnRows(db)).toBe(0);
    expect(await readBackupMeta(db)).toBeNull();
    expect(await readRestoreMeta(db)).toBeNull();
    // The reset ends on the same starter set as a first launch: three accounts
    // and the twelve categories, not an empty account list.
    expect((await listAccounts(db)).map(account => account.name)).toEqual([
      '微信',
      '支付宝',
      '银行卡',
    ]);
    expect((await listCategories(db)).map(category => category.name)).toContain('饮食');
  });

  it('deletes nothing when the automatic copy cannot be written', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    await seedExpense(db, 500, 'keep me');
    const writer: BackupFileWriter = {
      async writeForShare() {
        return { kind: 'download' };
      },
      async writeCopy() {
        throw new Error('缓存不可写');
      },
    };

    await expect(resetWithBackup(db, writer, NOW)).rejects.toThrow('缓存不可写');

    expect(await countTxnRows(db)).toBe(1);
    expect((await listTxnsByMonth(db, '2026-10'))[0].note).toBe('keep me');
    expect(await listCategories(db)).toHaveLength(13);
    expect(await listAccounts(db)).toHaveLength(3);
  });
});
