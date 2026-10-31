import { describe, it, expect } from 'vitest';
import type { Db } from '../../src/db/driver';
import { buildBackup, parseBackup, serializeBackup, BackupSchemaTooNewError } from '../../src/db/backup';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';
import { listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import { createExpense, listTxnsByMonth } from '../../src/db/repos/txns';
import { confirmImport, exportBackup, prepareImport, resetWithBackup } from '../../src/backup/flow';
import { countTxnRows, readBackupMeta } from '../../src/backup/meta';
import type { BackupFileWriter } from '../../src/backup/flow';
import { beforeBackupFileName, utf8ByteLength } from '../../src/backup/format';

const NOW = new Date(2026, 9, 23, 13, 5, 7);
const LEDGER_NAME = '记账本-20261023-1305.ledger';

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
    },
    async writeCopy(fileName, text) {
      copies.push({ fileName, text });
    },
  };
}

async function seedExpense(db: Db, amountCents: number, note: string): Promise<string> {
  const account = (await listAccounts(db))[0];
  const category = (await listCategories(db)).find(candidate => candidate.name === '饮食');
  if (account === undefined || category === undefined) throw new Error('seed is incomplete');
  return createExpense(db, {
    date: '2026-10-20',
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
  it('writes the same JSON it can parse back, then records the three meta keys', async () => {
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
    expect(await readBackupMeta(db)).toEqual(result.meta);
  });

  it('records nothing when the share step fails', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    const writer: BackupFileWriter = {
      async writeForShare() {
        throw new Error('没有空间');
      },
      async writeCopy() {},
    };

    await expect(exportBackup(db, writer, NOW)).rejects.toThrow('没有空间');
    expect(await readBackupMeta(db)).toBeNull();
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
    expect(prepared.localRows).toBe(2);
    expect(prepared.exportedAt).toBe(parseBackup(text).exportedAt);
  });

  it('rejects a non-JSON file before any write', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    await expect(prepareImport(db, '{', 'broken.ledger', 1)).rejects.toThrow(/JSON/);
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
      async writeForShare() {},
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
    const writer = memoryWriter();
    let rowsWhenCopied: number | null = null;
    const observingWriter: BackupFileWriter = {
      async writeForShare() {},
      async writeCopy(fileName, text) {
        writer.copies.push({ fileName, text });
        // The copy is the safety net: the ledger must still be whole here.
        rowsWhenCopied = await countTxnRows(db);
      },
    };

    const result = await resetWithBackup(db, observingWriter, NOW);

    expect(rowsWhenCopied).toBe(1);
    expect(result.beforeFileName).toBe(beforeBackupFileName(NOW));
    expect(writer.copies.map(file => file.fileName)).toEqual([beforeBackupFileName(NOW)]);
    // It is the pre-reset ledger, readable by the same codec an import uses.
    const copy = parseBackup(writer.copies[0].text);
    expect(copy.counts).toMatchObject({ txn: 1, account: 3, category: 13, template: 0 });
    expect(result.counts).toEqual({ txn: 1, account: 3, category: 12, tag: 0, project: 0 });

    // The reset copy stays in the cache: no second share sheet opens by itself.
    expect(writer.shared).toHaveLength(0);
    expect(await countTxnRows(db)).toBe(0);
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
      async writeForShare() {},
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
