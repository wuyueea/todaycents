import { describe, expect, it } from 'vitest';
import {
  createCachedBackupStore,
  createDeviceWriters,
  isShareCanceled,
  ShareCanceledError,
} from '../../src/backup/device';
import type {
  CachedBackup,
  CachedFileInfo,
  DeviceWriterDeps,
  ShareOutcome,
} from '../../src/backup/device';
import type { FolderAccess, StoredFolder } from '../../src/storage/folder';
import { bytesToBase64 } from '../../src/export/base64';
import { XLSX_MIME_TYPE } from '../../src/export/writer';

const FOLDER: StoredFolder = {
  path: '/storage/emulated/0/Documents/Books',
  name: 'Books',
};

interface HarnessOptions {
  native: boolean;
  folder: StoredFolder | null;
  /** Simulates a bridge that answers but did not save. */
  saved?: boolean;
  /** Simulates the owner dismissing the system share sheet. */
  share?: ShareOutcome;
}

function harness({ native, folder, saved = true, share = 'shared' }: HarnessOptions) {
  const folderWrites: { name: string; base64: string }[] = [];
  const cacheText: { fileName: string; text: string }[] = [];
  const cacheBytes: { fileName: string; bytes: Uint8Array }[] = [];
  const shared: { fileName: string; uri: string }[] = [];
  const downloads: { fileName: string; type: string }[] = [];

  const access: FolderAccess = {
    current: async () => folder,
    available: async () => true,
    getAccess: async () => ({ granted: true }),
    requestAccess: async () => ({ granted: true }),
    list: async () => ({ path: '', parent: null, dirs: [] }),
    choose: async () => null,
    clear: async () => {},
    open: async () => false,
    write: async (name, base64) => {
      folderWrites.push({ name, base64 });
      return { saved, name };
    },
  };

  const deps: DeviceWriterDeps = {
    isNativePlatform: async () => native,
    folder: access,
    writeCacheFile: async (fileName, text) => {
      cacheText.push({ fileName, text });
      return `file:///cache/${fileName}`;
    },
    writeCacheBytes: async (fileName, bytes) => {
      cacheBytes.push({ fileName, bytes });
      return `file:///cache/${fileName}`;
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
  it('writes backup text into the folder as UTF-8 base64, with no cache or share sheet', async () => {
    const h = harness({ native: true, folder: FOLDER });

    const destination = await h.writers.text.writeForShare(
      '记账本-20261020-2214.ledger',
      '你好'
    );

    expect(destination).toEqual({ kind: 'folder', folderName: 'Books' });
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
    const h = harness({ native: true, folder: FOLDER });
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);

    await h.writers.binary.writeForShare('记账本-2026-10.xlsx', bytes, XLSX_MIME_TYPE);

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

    expect(destination).toEqual({ kind: 'folder', folderName: 'Books' });
    expect(h.folderWrites).toHaveLength(1);
    expect(h.cacheText).toHaveLength(0);
    expect(h.shared).toHaveLength(0);
  });
});

describe('deviceFileWriter without a chosen folder', () => {
  it('keeps the cache + share sheet path for exports and reports the hand-off', async () => {
    const h = harness({ native: true, folder: null });

    const destination = await h.writers.text.writeForShare('a.ledger', 'text');

    expect(destination).toEqual({ kind: 'share' });
    expect(h.folderWrites).toHaveLength(0);
    expect(h.cacheText).toEqual([{ fileName: 'a.ledger', text: 'text' }]);
    expect(h.shared).toEqual([{ fileName: 'a.ledger', uri: 'file:///cache/a.ledger' }]);
  });

  it('keeps the cache-only path for the pre-import copy and reports its uri', async () => {
    const h = harness({ native: true, folder: null });

    const destination = await h.writers.text.writeCopy('before.ledger', 'text');

    expect(destination).toEqual({ kind: 'cache', uri: 'file:///cache/before.ledger' });
    expect(h.folderWrites).toHaveLength(0);
    expect(h.cacheText).toEqual([{ fileName: 'before.ledger', text: 'text' }]);
    expect(h.shared).toHaveLength(0);
  });

  it('falls back to the cache when the bridge says it did not save', async () => {
    const h = harness({ native: true, folder: FOLDER, saved: false });

    const destination = await h.writers.text.writeForShare('a.ledger', 'text');

    expect(destination).toEqual({ kind: 'share' });
    expect(h.folderWrites).toHaveLength(1);
    expect(h.cacheText).toEqual([{ fileName: 'a.ledger', text: 'text' }]);
    expect(h.shared).toHaveLength(1);
  });

  it('rejects a cancelled workbook share, so the report screen cannot claim success', async () => {
    const h = harness({ native: true, folder: null, share: 'canceled' });
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

    await expect(
      h.writers.binary.writeForShare('记账本-2026-10.xlsx', bytes, XLSX_MIME_TYPE)
    ).rejects.toBeInstanceOf(ShareCanceledError);
    expect(h.cacheBytes).toHaveLength(1);
    expect(h.shared).toHaveLength(1);
  });

  it('reports a dismissed share sheet as canceled, not as a backup', async () => {
    const h = harness({ native: true, folder: null, share: 'canceled' });

    const destination = await h.writers.text.writeForShare('a.ledger', 'text');

    expect(destination).toEqual({ kind: 'canceled' });
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
      isNativePlatform: async () => true,
      listFiles: async () => files,
      share: async (fileName, uri) => {
        calls.push({ fileName, uri });
        return 'canceled';
      },
    });
    const file: CachedBackup = {
      name: 'new.ledger',
      uri: 'file:///cache/new.ledger',
      bytes: 340,
      modifiedAt: 3000,
    };

    expect(await store.share(file)).toBe('canceled');
    expect(calls).toEqual([
      { fileName: 'new.ledger', uri: 'file:///cache/new.ledger' },
    ]);
  });
});
