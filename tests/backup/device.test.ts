import { describe, expect, it } from 'vitest';
import { createDeviceWriters } from '../../src/backup/device';
import type { DeviceWriterDeps } from '../../src/backup/device';
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
}

function harness({ native, folder, saved = true }: HarnessOptions) {
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

    await h.writers.text.writeForShare('记账本-20261020-2214.ledger', '你好');

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

    await h.writers.text.writeCopy('记账本-20261020-2214-before.ledger', 'before');

    expect(h.folderWrites).toHaveLength(1);
    expect(h.cacheText).toHaveLength(0);
    expect(h.shared).toHaveLength(0);
  });
});

describe('deviceFileWriter without a chosen folder', () => {
  it('keeps the cache + share sheet path for exports', async () => {
    const h = harness({ native: true, folder: null });

    await h.writers.text.writeForShare('a.ledger', 'text');

    expect(h.folderWrites).toHaveLength(0);
    expect(h.cacheText).toEqual([{ fileName: 'a.ledger', text: 'text' }]);
    expect(h.shared).toEqual([{ fileName: 'a.ledger', uri: 'file:///cache/a.ledger' }]);
  });

  it('keeps the cache-only path for the pre-import copy', async () => {
    const h = harness({ native: true, folder: null });

    await h.writers.text.writeCopy('before.ledger', 'text');

    expect(h.folderWrites).toHaveLength(0);
    expect(h.cacheText).toEqual([{ fileName: 'before.ledger', text: 'text' }]);
    expect(h.shared).toHaveLength(0);
  });

  it('falls back to the cache when the bridge says it did not save', async () => {
    const h = harness({ native: true, folder: FOLDER, saved: false });

    await h.writers.text.writeForShare('a.ledger', 'text');

    expect(h.folderWrites).toHaveLength(1);
    expect(h.cacheText).toEqual([{ fileName: 'a.ledger', text: 'text' }]);
    expect(h.shared).toHaveLength(1);
  });

  it('keeps the browser Blob download when there is no native shell', async () => {
    const h = harness({ native: false, folder: FOLDER });
    const bytes = new Uint8Array([1, 2, 3]);

    await h.writers.text.writeForShare('a.ledger', 'text');
    await h.writers.binary.writeForShare('a.xlsx', bytes, XLSX_MIME_TYPE);

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

    await h.writers.text.writeCopy('before.ledger', 'text');

    expect(h.downloads).toHaveLength(0);
    expect(h.cacheText).toHaveLength(0);
  });
});
