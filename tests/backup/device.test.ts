import { beforeAll, describe, expect, it } from 'vitest';
import {
  createCachedBackupStore,
  createDeviceWriters,
  isShareCanceled,
} from '../../src/backup/device';
import type {
  CachedFileInfo,
  DeviceWriterDeps,
  ShareOutcome,
} from '../../src/backup/device';
import type { FolderAccess, StoredFolder } from '../../src/storage/folder';
import { bytesToBase64 } from '../../src/export/base64';
import { XLSX_MIME_TYPE } from '../../src/export/writer';
import { buildBackup, serializeBackup } from '../../src/db/backup';
import { createTestDb } from '../helpers/nodeDb';

const FOLDER: StoredFolder = {
  name: 'Books',
};

interface HarnessOptions {
  native: boolean;
  folder: StoredFolder | null;
  /** Simulates a bridge that answers but did not save. */
  saved?: boolean;
  actualName?: string;
  folderId?: string;
  cachedName?: string;
  /** Simulates the owner dismissing the system share sheet. */
  share?: ShareOutcome;
  /** Simulates the native bridge rejecting instead of answering. */
  folderWriteError?: unknown;
  /** Simulates the app cache refusing its own fallback write. */
  cacheTextError?: unknown;
}

function harness({
  native,
  folder,
  saved = true,
  actualName,
  folderId,
  cachedName,
  share = 'shared',
  folderWriteError,
  cacheTextError,
}: HarnessOptions) {
  const folderWrites: { name: string; base64: string }[] = [];
  const cacheText: { fileName: string; text: string }[] = [];
  const cacheBytes: { fileName: string; bytes: Uint8Array }[] = [];
  const shared: { fileName: string; uri: string }[] = [];
  const downloads: { fileName: string; type: string }[] = [];

  const access: FolderAccess = {
    current: async () => folder,
    available: async () => true,
    status: async () => ({ folder, needsReselection: false }),
    choose: async () => false,
    clear: async () => {},
    open: async () => false,
    write: async (name, base64) => {
      folderWrites.push({ name, base64 });
      if (folderWriteError !== undefined) throw folderWriteError;
      return { saved, name: actualName ?? name, folderId };
    },
  };

  const deps: DeviceWriterDeps = {
    isNativePlatform: async () => native,
    folder: access,
    writeCacheFile: async (fileName, text) => {
      if (cacheTextError !== undefined) throw cacheTextError;
      cacheText.push({ fileName, text });
      const name = cachedName ?? fileName;
      return { fileName: name, uri: `file:///cache/${name}` };
    },
    writeCachedReport: async (fileName, bytes) => {
      cacheBytes.push({ fileName, bytes });
      const name = cachedName ?? fileName;
      return { fileName: name, uri: `file:///cache/${name}` };
    },
    shareCacheFile: async (fileName, uri) => {
      shared.push({ fileName, uri });
      return share;
    },
    downloadInBrowser: (fileName, blob) => {
      downloads.push({ fileName, type: blob.type });
    },
  };

  return {
    writers: createDeviceWriters(deps),
    folderWrites,
    cacheText,
    cacheBytes,
    shared,
    downloads,
  };
}

describe('deviceFileWriter with a chosen folder', () => {
  it('returns the actual filename for a renamed report or before-copy', async () => {
    const report = harness({ native: true, folder: FOLDER, actualName: '报表 (2).xlsx' });
    await expect(report.writers.binary.writeForShare('报表.xlsx', new Uint8Array([1, 2]), XLSX_MIME_TYPE))
      .resolves.toEqual({ kind: 'folder', fileName: '报表 (2).xlsx', folderName: 'Books' });
    const backup = harness({ native: true, folder: FOLDER, actualName: '记账本 (2)-before.ledger' });
    await expect(backup.writers.text.writeCopy('记账本-before.ledger', 'test'))
      .resolves.toEqual({ kind: 'folder', fileName: '记账本 (2)-before.ledger', folderName: 'Books' });
    expect(report.shared).toHaveLength(0);
    expect(backup.cacheText).toHaveLength(0);
  });
  it('writes backup text into the folder as UTF-8 base64, with no cache or share sheet', async () => {
    const h = harness({ native: true, folder: FOLDER });

    const destination = await h.writers.text.writeForShare(
      '记账本-20261020-2214.ledger',
      '你好'
    );

    expect(destination).toEqual({ kind: 'folder', folderName: 'Books', fileName: '记账本-20261020-2214.ledger' });
    expect(h.folderWrites).toEqual([
      {
        name: '记账本-20261020-2214.ledger',
        base64: bytesToBase64(new TextEncoder().encode('你好')),
      },
    ]);
    expect(h.cacheText).toHaveLength(0);
    expect(h.shared).toHaveLength(0);
  });

  it('writes workbook bytes into the folder without a second encoding', async () => {
    const h = harness({ native: true, folder: FOLDER, folderId: 'local-tree', actualName: '记账本 (2).xlsx' });
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);

    await expect(h.writers.binary.writeForShare('记账本-2026-10.xlsx', bytes, XLSX_MIME_TYPE)).resolves.toEqual({
      kind: 'folder', folderName: 'Books', folderId: 'local-tree', fileName: '记账本 (2).xlsx',
    });

    expect(h.folderWrites).toEqual([
      { name: '记账本-2026-10.xlsx', base64: bytesToBase64(bytes) },
    ]);
    expect(h.cacheBytes).toHaveLength(0);
    expect(h.shared).toHaveLength(0);
  });

  it('sends the automatic before-copy to the folder too', async () => {
    const h = harness({ native: true, folder: FOLDER });

    const destination = await h.writers.text.writeCopy(
      '记账本-20261020-2214-before.ledger',
      'before'
    );

    expect(destination).toEqual({ kind: 'folder', folderName: 'Books', fileName: '记账本-20261020-2214-before.ledger' });
    expect(h.folderWrites).toHaveLength(1);
    expect(h.cacheText).toHaveLength(0);
    expect(h.shared).toHaveLength(0);
  });
});

describe('deviceFileWriter when the chosen folder write rejects', () => {
  const folderError = new Error('写入「a.ledger」失败。');

  it('falls back to the cache and share sheet for a text export', async () => {
    const h = harness({ native: true, folder: FOLDER, folderWriteError: folderError });

    const destination = await h.writers.text.writeForShare('a.ledger', 'text');

    expect(destination).toEqual({ kind: 'share', fileName: 'a.ledger' });
    expect(h.folderWrites).toHaveLength(1);
    expect(h.cacheText).toEqual([{ fileName: 'a.ledger', text: 'text' }]);
    expect(h.shared).toEqual([
      { fileName: 'a.ledger', uri: 'file:///cache/a.ledger' },
    ]);
  });

  it('keeps a dismissed share sheet as canceled after the folder fallback', async () => {
    const h = harness({
      native: true,
      folder: FOLDER,
      folderWriteError: folderError,
      share: 'canceled',
      cachedName: 'a (2).ledger',
    });

    const destination = await h.writers.text.writeForShare('a.ledger', 'text');

    expect(destination).toEqual({ kind: 'canceled', fileName: 'a (2).ledger' });
    expect(h.cacheText).toEqual([{ fileName: 'a.ledger', text: 'text' }]);
    expect(h.shared).toHaveLength(1);
  });

  it('falls back to the cache for the automatic before-copy', async () => {
    const h = harness({ native: true, folder: FOLDER, folderWriteError: folderError });

    const destination = await h.writers.text.writeCopy('before.ledger', 'text');

    expect(destination).toEqual({ kind: 'cache', fileName: 'before.ledger', uri: 'file:///cache/before.ledger' });
    expect(h.folderWrites).toHaveLength(1);
    expect(h.cacheText).toEqual([{ fileName: 'before.ledger', text: 'text' }]);
    expect(h.shared).toHaveLength(0);
  });

  it('falls back to the cache and share sheet for workbook bytes', async () => {
    const h = harness({ native: true, folder: FOLDER, folderWriteError: folderError });
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

    await h.writers.binary.writeForShare('记账本-2026-10.xlsx', bytes, XLSX_MIME_TYPE);

    expect(h.folderWrites).toHaveLength(1);
    expect(h.cacheBytes).toHaveLength(1);
    expect(h.cacheBytes[0]?.fileName).toBe('记账本-2026-10.xlsx');
    expect(h.shared).toEqual([
      { fileName: '记账本-2026-10.xlsx', uri: 'file:///cache/记账本-2026-10.xlsx' },
    ]);
  });

  it('returns a canceled share and the actual cache filename after a folder write fails', async () => {
    const h = harness({
      native: true,
      folder: FOLDER,
      folderWriteError: folderError,
      share: 'canceled',
      cachedName: '记账本-2026-10 (2).xlsx',
    });
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

    await expect(
      h.writers.binary.writeForShare('记账本-2026-10.xlsx', bytes, XLSX_MIME_TYPE)
    ).resolves.toEqual({ kind: 'canceled', fileName: '记账本-2026-10 (2).xlsx' });
    expect(h.cacheBytes).toHaveLength(1);
    expect(h.shared).toEqual([{
      fileName: '记账本-2026-10 (2).xlsx', uri: 'file:///cache/记账本-2026-10 (2).xlsx',
    }]);
  });

  it('does not hide a cache failure behind the folder fallback', async () => {
    const h = harness({
      native: true,
      folder: FOLDER,
      folderWriteError: folderError,
      cacheTextError: new Error('cache full'),
    });

    await expect(h.writers.text.writeForShare('a.ledger', 'text')).rejects.toThrow(
      'cache full'
    );
    expect(h.shared).toHaveLength(0);
  });
});

describe('deviceFileWriter without a chosen folder', () => {
  it('keeps the cache + share sheet path for exports and reports the hand-off', async () => {
    const h = harness({ native: true, folder: null });

    const destination = await h.writers.text.writeForShare('a.ledger', 'text');

    expect(destination).toEqual({ kind: 'share', fileName: 'a.ledger' });
    expect(h.folderWrites).toHaveLength(0);
    expect(h.cacheText).toEqual([{ fileName: 'a.ledger', text: 'text' }]);
    expect(h.shared).toEqual([{ fileName: 'a.ledger', uri: 'file:///cache/a.ledger' }]);
  });

  it('keeps the cache-only path for the pre-import copy and reports its uri', async () => {
    const h = harness({ native: true, folder: null });

    const destination = await h.writers.text.writeCopy('before.ledger', 'text');

    expect(destination).toEqual({ kind: 'cache', fileName: 'before.ledger', uri: 'file:///cache/before.ledger' });
    expect(h.folderWrites).toHaveLength(0);
    expect(h.cacheText).toEqual([{ fileName: 'before.ledger', text: 'text' }]);
    expect(h.shared).toHaveLength(0);
  });

  it('falls back to the cache when the bridge says it did not save', async () => {
    const h = harness({ native: true, folder: FOLDER, saved: false });

    const destination = await h.writers.text.writeForShare('a.ledger', 'text');

    expect(destination).toEqual({ kind: 'share', fileName: 'a.ledger' });
    expect(h.folderWrites).toHaveLength(1);
    expect(h.cacheText).toEqual([{ fileName: 'a.ledger', text: 'text' }]);
    expect(h.shared).toHaveLength(1);
  });

  it('returns a separate canceled outcome for a dismissed workbook share', async () => {
    const h = harness({ native: true, folder: null, share: 'canceled' });
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

    await expect(
      h.writers.binary.writeForShare('记账本-2026-10.xlsx', bytes, XLSX_MIME_TYPE)
    ).resolves.toEqual({ kind: 'canceled', fileName: '记账本-2026-10.xlsx' });
    expect(h.cacheBytes).toHaveLength(1);
    expect(h.shared).toHaveLength(1);
  });

  it('reports a dismissed share sheet as canceled, not as a backup', async () => {
    const h = harness({ native: true, folder: null, share: 'canceled' });

    const destination = await h.writers.text.writeForShare('a.ledger', 'text');

    expect(destination).toEqual({ kind: 'canceled', fileName: 'a.ledger' });
    // The cache file is still there; canceling the share does not delete it.
    expect(h.cacheText).toEqual([{ fileName: 'a.ledger', text: 'text' }]);
    expect(h.shared).toHaveLength(1);
  });

  it('keeps the browser Blob download when there is no native shell', async () => {
    const h = harness({ native: false, folder: FOLDER });
    const bytes = new Uint8Array([1, 2, 3]);

    const textDestination = await h.writers.text.writeForShare('a.ledger', 'text');
    await h.writers.binary.writeForShare('a.xlsx', bytes, XLSX_MIME_TYPE);

    expect(textDestination).toEqual({ kind: 'download' });
    expect(h.downloads).toEqual([
      { fileName: 'a.ledger', type: 'application/json' },
      { fileName: 'a.xlsx', type: XLSX_MIME_TYPE },
    ]);
    expect(h.folderWrites).toHaveLength(0);
    expect(h.cacheText).toHaveLength(0);
    expect(h.cacheBytes).toHaveLength(0);
  });

  it('does nothing for the before-copy in a browser', async () => {
    const h = harness({ native: false, folder: FOLDER });

    const destination = await h.writers.text.writeCopy('before.ledger', 'text');

    expect(destination).toEqual({ kind: 'none' });
    expect(h.downloads).toHaveLength(0);
    expect(h.cacheText).toHaveLength(0);
  });
});

describe('isShareCanceled', () => {
  it('recognises the plugin rejection and its string shapes', () => {
    expect(isShareCanceled(new Error('Share canceled'))).toBe(true);
    expect(isShareCanceled(' Share canceled ')).toBe(true);
    expect(isShareCanceled({ message: 'Share cancelled' })).toBe(true);
  });

  it('does not mistake a real failure or an unrelated value for a cancel', () => {
    expect(isShareCanceled(new Error('Share canceled by user'))).toBe(false);
    expect(isShareCanceled(new Error('cancel failed: permission denied'))).toBe(false);
    expect(isShareCanceled(new Error('没有空间'))).toBe(false);
    expect(isShareCanceled(new Error('Permission denied'))).toBe(false);
    expect(isShareCanceled(null)).toBe(false);
    expect(isShareCanceled(undefined)).toBe(false);
    expect(isShareCanceled({})).toBe(false);
  });
});

describe('createCachedBackupStore', () => {
  let completeBackup: string;
  beforeAll(async () => {
    completeBackup = serializeBackup(await buildBackup(await createTestDb()));
  });
  const unusedWrites = {
    writeFile: async () => { throw new Error('unexpected write'); },
    readFile: async () => completeBackup,
    deleteFile: async () => { throw new Error('unexpected delete'); },
  };
  const files: CachedFileInfo[] = [
    {
      name: 'old.ledger',
      type: 'file',
      uri: 'file:///cache/old.ledger',
      size: 120,
      mtime: 1000,
    },
    {
      name: 'notes.txt',
      type: 'file',
      uri: 'file:///cache/notes.txt',
      size: 12,
      mtime: 4000,
    },
    {
      name: 'folder.ledger',
      type: 'directory',
      uri: 'file:///cache/folder.ledger',
      size: 0,
      mtime: 5000,
    },
    {
      name: 'new.ledger',
      type: 'file',
      uri: 'file:///cache/new.ledger',
      size: 340,
      mtime: 3000,
    },
    {
      name: 'bad-size.ledger',
      type: 'file',
      uri: 'file:///cache/bad-size.ledger',
      size: Number.NaN,
      mtime: 6000,
    },
    {
      name: 'bad-time.ledger',
      type: 'file',
      uri: 'file:///cache/bad-time.ledger',
      size: 10,
      mtime: Number.NaN,
    },
    {
      name: 'negative-size.ledger',
      type: 'file',
      uri: 'file:///cache/negative-size.ledger',
      size: -1,
      mtime: 7000,
    },
  ];

  it('lists only .ledger files, newest first, with the fields the sheet draws', async () => {
    const store = createCachedBackupStore({
      ...unusedWrites,
      isNativePlatform: async () => true,
      listFiles: async () => files,
      share: async () => 'shared',
    });

    expect(await store.list()).toEqual([
      {
        name: 'new.ledger',
        uri: 'file:///cache/new.ledger',
        bytes: 340,
        modifiedAt: 3000,
      },
      {
        name: 'old.ledger',
        uri: 'file:///cache/old.ledger',
        bytes: 120,
        modifiedAt: 1000,
      },
    ]);
  });

  it('returns nothing off-device without touching the filesystem', async () => {
    let listed = false;
    const store = createCachedBackupStore({
      ...unusedWrites,
      isNativePlatform: async () => false,
      listFiles: async () => {
        listed = true;
        return files;
      },
      share: async () => 'shared',
    });

    expect(await store.list()).toEqual([]);
    expect(listed).toBe(false);
  });

  it('hands the chosen cache file to the share sheet', async () => {
    const calls: { fileName: string; uri: string }[] = [];
    const store = createCachedBackupStore({
      ...unusedWrites,
      isNativePlatform: async () => true,
      listFiles: async () => files,
      share: async (fileName, uri) => {
        calls.push({ fileName, uri });
        return 'canceled';
      },
    });
    expect(await store.share('new.ledger')).toBe('canceled');
    expect(calls).toEqual([
      { fileName: 'new.ledger', uri: 'file:///cache/new.ledger' },
    ]);
  });
});
