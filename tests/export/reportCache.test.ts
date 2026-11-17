import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedReports, createCachedReportStore } from '../../src/backup/device';
import type { CachedFileInfo, ShareOutcome } from '../../src/backup/device';
import { bytesToBase64 } from '../../src/export/base64';
import { storeZip, ZIP_END_BYTES } from '../../src/export/zip';

const MONTH = '记账本-2026-10.xlsx';
const YEAR = '记账本-2026.xlsx';
const data = new Uint8Array([0x50, 0x4b]);
const workbook = storeZip([{ name: 'xl/workbook.xml', data: '<workbook/>' }]);

const native = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  writeFails: false,
  renameFails: false,
  renameLeavesPartial: true,
  deleteFails: false,
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: {
    readdir: async () => ({ files: [...native.files].map(([name, bytes]) => entry(name, 1000, { size: bytes.length })) }),
    writeFile: async ({ path, data }: { path: string; data: string }) => {
      native.files.set(path, Uint8Array.from(atob(data), character => character.charCodeAt(0)));
      if (native.writeFails) throw new Error('write failed');
    },
    rename: async ({ from, to }: { from: string; to: string }) => {
      const bytes = native.files.get(from)!;
      if (native.renameFails) {
        if (native.renameLeavesPartial) native.files.set(to, bytes.slice(0, -ZIP_END_BYTES));
        throw new Error('rename failed');
      }
      native.files.set(to, bytes);
      native.files.delete(from);
    },
    deleteFile: async ({ path }: { path: string }) => {
      if (!native.files.has(path)) throw Object.assign(new Error('not found'), { code: 'OS-PLUG-FILE-0008' });
      if (native.deleteFails && path.endsWith('.xlsx')) throw new Error('delete failed');
      native.files.delete(path);
    },
    getUri: async ({ path }: { path: string }) => ({ uri: `file:///cache/${path}` }),
    readFile: async ({ path, offset, length }: { path: string; offset: number; length: number }) => {
      const bytes = native.files.get(path);
      if (!bytes) throw new Error('not found');
      return { data: bytesToBase64(bytes.slice(offset, offset + length)) };
    },
  },
}));

function entry(name: string, mtime = 1000, fields: Partial<CachedFileInfo> = {}): CachedFileInfo {
  return { name, type: 'file', size: 42, mtime, uri: `file:///cache/${name}`, ...fields };
}

function harness(initial: CachedFileInfo[] = [], native = true) {
  const files = new Map(initial.map(file => [file.name, file]));
  const listFiles = vi.fn(async () => [...files.values()]);
  const publish = vi.fn(async (name: string, bytes: Uint8Array) => {
    const file = entry(name, 1000 + files.size, { size: bytes.length });
    files.set(name, file);
    return file.uri;
  });
  const share = vi.fn(async (_name: string, _uri: string): Promise<ShareOutcome> => 'canceled');
  const store = createCachedReportStore({
    isNativePlatform: async () => native,
    listFiles,
    publish,
    share,
    isComplete: async () => true,
  });
  return { files, listFiles, publish, share, store };
}

describe('cached reports', () => {
  it('recognizes legacy month/year and numbered reports, newest first, with valid metadata', async () => {
    const { store } = harness([
      entry(YEAR), entry(MONTH, 2000), entry('记账本-2026 (10).xlsx', 3000),
      entry('记账本-20261101-before.ledger'), entry('other.xlsx'),
      entry('记账本-2026-13.xlsx'), entry('记账本-2026-04.xlsx.writing'),
      entry('记账本-2026-03.xlsx', 4000, { type: 'directory' }),
      entry('记账本-2026-02.xlsx', 5000, { mtime: Infinity }),
      entry('记账本-2026-01.xlsx', 6000, { size: 0 }),
      entry('记账本-2025.xlsx', 7000), entry('记账本-2025.xlsx.writing'),
    ]);
    expect((await store.list()).map(file => file.name)).toEqual(['记账本-2026 (10).xlsx', MONTH, YEAR]);
  });

  it('serializes same-name writes and preserves a file or directory already using the name', async () => {
    const original = entry(MONTH);
    const marker = entry('记账本-2026-10 (3).xlsx.writing');
    const { store, files, publish } = harness([
      original, entry('记账本-2026-10 (2).xlsx', 1000, { type: 'directory' }), marker,
    ]);
    const results = await Promise.all([store.write(MONTH, data), store.write(MONTH, data)]);
    expect(results.map(result => result.fileName)).toEqual(['记账本-2026-10 (4).xlsx', '记账本-2026-10 (5).xlsx']);
    expect(files.get(MONTH)).toBe(original);
    expect(files.get(marker.name)).toBe(marker);
    expect(publish.mock.calls).toEqual(results.map(result => [result.fileName, data]));
  });

  it('uses the current cache URI and declines a file that was evicted before reshare', async () => {
    const { store, files, share } = harness([entry(YEAR)]);
    await expect(store.share(YEAR)).resolves.toBe('canceled');
    expect(share).toHaveBeenCalledWith(YEAR, `file:///cache/${YEAR}`);
    files.delete(YEAR);
    await expect(store.share(YEAR)).rejects.toThrow('报表已不在应用缓存中');
    expect(share).toHaveBeenCalledTimes(1);
  });

  it('rejects paths and recovers the write queue after a failure', async () => {
    const { store, publish } = harness();
    await expect(store.write(`../${YEAR}`, data)).rejects.toThrow('报表文件名无效');
    expect(publish).not.toHaveBeenCalled();
    publish.mockRejectedValueOnce(new Error('cache full'));
    await expect(store.write(YEAR, data)).rejects.toThrow('cache full');
    expect(await store.list()).toEqual([]);
    await expect(store.write(YEAR, data)).resolves.toMatchObject({ fileName: YEAR });
  });

  it('does not read the native cache in a browser', async () => {
    const { store, listFiles } = harness([entry(YEAR)], false);
    expect(await store.list()).toEqual([]);
    expect(listFiles).not.toHaveBeenCalled();
  });

  it('waits for a pending publication before listing files', async () => {
    const { store, files, publish } = harness();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    publish.mockImplementationOnce(async name => {
      files.set(name, entry(name, 1000, { size: 1 }));
      await pending;
      files.set(name, entry(name));
      return `file:///cache/${name}`;
    });
    const writing = store.write(YEAR, data);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    let listed = false;
    const listing = store.list().then(result => { listed = true; return result; });
    await Promise.resolve();
    expect(listed).toBe(false);
    finish();
    await writing;
    expect(await listing).toEqual([expect.objectContaining({ name: YEAR, bytes: 42 })]);
  });
});

describe('native report publication failures', () => {
  beforeEach(() => {
    native.files.clear();
    native.writeFails = false;
    native.renameFails = false;
    native.renameLeavesPartial = true;
    native.deleteFails = false;
  });

  it('cleans an incomplete write and allows a later export', async () => {
    native.writeFails = true;
    await expect(cachedReports.write(YEAR, workbook)).rejects.toThrow('write failed');
    expect([...native.files]).toEqual([]);
    native.writeFails = false;
    await expect(cachedReports.write(YEAR, workbook)).resolves.toEqual({ fileName: YEAR, uri: `file:///cache/${YEAR}` });
    expect([...native.files.keys()]).toEqual([YEAR]);
  });

  it('removes a partial destination left by a failed rename', async () => {
    native.renameFails = true;
    await expect(cachedReports.write(YEAR, workbook)).rejects.toThrow('rename failed');
    expect([...native.files]).toEqual([]);
    expect(await cachedReports.list()).toEqual([]);
  });

  it('cleans the temporary file when rename fails before creating a destination', async () => {
    native.renameFails = true;
    native.renameLeavesPartial = false;
    await expect(cachedReports.write(YEAR, workbook)).rejects.toThrow('rename failed');
    expect([...native.files]).toEqual([]);
  });

  it('hides a partial destination even if cleanup fails and preserves its marker on retry', async () => {
    native.renameFails = true;
    native.deleteFails = true;
    await expect(cachedReports.write(YEAR, workbook)).rejects.toThrow('rename failed');
    expect([...native.files.keys()]).toEqual([`${YEAR}.writing`, YEAR]);
    expect(await cachedReports.list()).toEqual([]);
    native.renameFails = false;
    await expect(cachedReports.write(YEAR, workbook)).resolves.toMatchObject({ fileName: '记账本-2026 (2).xlsx' });
    expect((await cachedReports.list()).map(file => file.name)).toEqual(['记账本-2026 (2).xlsx']);
    expect(native.files.get(YEAR)).toEqual(workbook.slice(0, -ZIP_END_BYTES));
    expect(native.files.has(`${YEAR}.writing`)).toBe(true);
    // Android manages the two cache entries independently.
    native.files.delete(`${YEAR}.writing`);
    expect((await cachedReports.list()).map(file => file.name)).toEqual(['记账本-2026 (2).xlsx']);
    await expect(cachedReports.share(YEAR)).rejects.toThrow('报表已不在应用缓存中');
  });

  it('lists an intact legacy report but skips one truncated during the old direct write', async () => {
    native.files.set(YEAR, workbook);
    native.files.set(MONTH, workbook.slice(0, -1));
    expect((await cachedReports.list()).map(file => file.name)).toEqual([YEAR]);
  });
});
