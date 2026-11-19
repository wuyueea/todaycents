import { beforeAll, describe, expect, it } from 'vitest';
import { createCachedBackupStore } from '../../src/backup/device';
import type { CachedBackupPort, CachedFileInfo, ShareOutcome } from '../../src/backup/device';
import { buildBackup, serializeBackup } from '../../src/db/backup';
import { createTestDb } from '../helpers/nodeDb';

let completeBackup: string;
beforeAll(async () => {
  completeBackup = serializeBackup(await buildBackup(await createTestDb()));
});

function before(index: number, overrides: Partial<CachedFileInfo> = {}): CachedFileInfo {
  const name = `记账本-20261101-1200${String(index).padStart(2, '0')}-before.ledger`;
  return { name, type: 'file', uri: `file:///cache/${name}`, size: 100, mtime: index + 1000, ...overrides };
}

function harness(initial: CachedFileInfo[]) {
  let files = [...initial];
  const contents = new Map<string, string>();
  const deleted: string[] = [];
  const events: string[] = [];
  let writeError: Error | null = null;
  let listError: Error | null = null;
  let deleteErrorFor = '';
  let nextMtime = 9000;
  let share: () => Promise<ShareOutcome> = async () => 'shared';
  const port: CachedBackupPort = {
    isNativePlatform: async () => true,
    listFiles: async () => {
      events.push('list');
      if (listError) throw listError;
      return [...files];
    },
    writeFile: async (name, text) => {
      events.push(`write:${name}:${text}`);
      if (writeError) throw writeError;
      const file = before(0, { name, uri: `file:///cache/${name}`, mtime: nextMtime });
      files = [...files.filter(existing => existing.name !== name), file];
      return { fileName: name, uri: file.uri };
    },
    readFile: async name => contents.get(name) ?? completeBackup,
    deleteFile: async name => {
      events.push(`delete:${name}`);
      if (name === deleteErrorFor) throw new Error('read only');
      deleted.push(name);
      files = files.filter(file => file.name !== name);
    },
    share: async () => share(),
  };
  return {
    store: createCachedBackupStore(port), port, deleted, events,
    setWriteError: (error: Error | null) => { writeError = error; },
    setListError: (error: Error | null) => { listError = error; },
    setDeleteError: (name: string) => { deleteErrorFor = name; },
    setMtime: (mtime: number) => { nextMtime = mtime; },
    setShare: (fn: () => Promise<ShareOutcome>) => { share = fn; },
    contents,
  };
}

describe('automatic before cache retention', () => {
  it('keeps the ten newest automatic copies, using mtime instead of filename date', async () => {
    const files = Array.from({ length: 12 }, (_, i) => before(i));
    files[0] = before(0, { mtime: 2000 });
    const h = harness(files);
    const listed = await h.store.list();
    expect(h.deleted).toEqual([files[2]!.name, files[1]!.name]);
    expect(listed).toHaveLength(10);
    expect(listed[0]!.name).toBe(files[0]!.name);
  });

  it('leaves ten copies alone', async () => {
    const h = harness(Array.from({ length: 10 }, (_, i) => before(i)));
    expect(await h.store.list()).toHaveLength(10);
    expect(h.deleted).toEqual([]);
  });

  it('recognizes old minute names and preserves manual exports, unknown files and invalid metadata', async () => {
    const ordinary = [
      before(0, { name: '记账本-20261101-120000.ledger' }),
      before(0, { name: 'custom-before.ledger' }),
      before(0, { name: '../记账本-20261101-120000-before.ledger' }),
      before(0, { name: '记账本-20261101-999999-before.ledger' }),
      before(0, { name: '记账本-20260230-120000-before.ledger' }),
      before(0, { name: '记账本-20261101-120000-before.xlsx' }),
      before(0, { name: '记账本-20261102-120000-before.ledger', type: 'directory' }),
      before(0, { name: '记账本-20261103-120000-before.ledger', mtime: Number.NaN }),
      before(0, { name: '记账本-20261104-120000-before.ledger', size: -1 }),
    ];
    const old = before(0, { name: '记账本-20261001-1200-before.ledger', mtime: 1 });
    const h = harness([...ordinary, old, ...Array.from({ length: 10 }, (_, i) => before(i + 1))]);
    await h.store.list();
    expect(h.deleted).toEqual([old.name]);
  });

  it('never reads or deletes the native cache in a browser', async () => {
    const h = harness(Array.from({ length: 12 }, (_, i) => before(i)));
    const store = createCachedBackupStore({ ...h.port, isNativePlatform: async () => false });
    expect(await store.list()).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('writes first and preserves the just-written copy even if the clock moved backwards', async () => {
    const h = harness(Array.from({ length: 10 }, (_, i) => before(i)));
    const name = before(20).name;
    h.setMtime(1);
    expect(await h.store.write(name, 'snapshot')).toEqual({ fileName: name, uri: `file:///cache/${name}` });
    expect(h.events[0]).toBe(`write:${name}:snapshot`);
    const listed = await h.store.list();
    expect(listed).toHaveLength(11);
    expect(listed.some(file => file.name === name)).toBe(true);
    expect(h.deleted).toEqual([]);
  });

  it('does not prune after a failed write and allows a subsequent write', async () => {
    const h = harness(Array.from({ length: 12 }, (_, i) => before(i)));
    h.setWriteError(new Error('disk full'));
    await expect(h.store.write(before(20).name, 'snapshot')).rejects.toThrow('disk full');
    expect(h.deleted).toEqual([]);
    expect(h.events).toHaveLength(1);
    h.setWriteError(null);
    await expect(h.store.write(before(21).name, 'snapshot')).resolves.toMatchObject({ fileName: before(21).name });
    expect(await h.store.list()).toHaveLength(10);
  });

  it('keeps files whose deletion failed visible and continues cleaning others', async () => {
    const h = harness(Array.from({ length: 12 }, (_, i) => before(i)));
    h.setDeleteError(before(1).name);
    const listed = await h.store.list();
    expect(listed).toHaveLength(11);
    expect(listed.some(file => file.name === before(1).name)).toBe(true);
    expect(h.deleted).toEqual([before(0).name]);
  });

  it('does not fail a successful before write when cleanup cannot list or delete', async () => {
    const h = harness(Array.from({ length: 10 }, (_, i) => before(i)));
    h.setListError(new Error('readdir failed'));
    await expect(h.store.write(before(20).name, 'snapshot')).resolves.toMatchObject({ fileName: before(20).name });
    h.setListError(null);
    h.setDeleteError(before(0).name);
    await expect(h.store.write(before(21).name, 'snapshot')).resolves.toMatchObject({ fileName: before(21).name });
    expect(h.deleted).toEqual([before(1).name]);
  });

  it('serializes cache writes and cleanup behind an outstanding share', async () => {
    const h = harness(Array.from({ length: 10 }, (_, i) => before(i)));
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    h.setShare(() => new Promise<ShareOutcome>(resolve => {
      entered();
      finish = () => resolve('shared');
    }));
    const sharing = h.store.share(before(0).name);
    await started;
    const writing = h.store.write(before(20).name, 'snapshot');
    await Promise.resolve();
    expect(h.events).toEqual(['list']);
    finish();
    await sharing;
    await writing;
    expect(h.deleted).not.toContain(before(0).name);
    expect(h.deleted).toEqual([]);
    expect(await h.store.list()).toHaveLength(11);
  });

  it('protects shared URIs for the rest of this session, allowing a temporary excess', async () => {
    const files = Array.from({ length: 11 }, (_, i) => before(i));
    const h = harness(files);
    for (const file of files) await h.store.share(file.name);
    expect(await h.store.list()).toHaveLength(11);
    expect(h.deleted).toEqual([]);
    // In-memory pins are not restored after the app process restarts.
    const next = createCachedBackupStore(h.port);
    expect(await next.list()).toHaveLength(10);
    expect(h.deleted).toEqual([before(0).name]);
  });

  it('protects a requested share while it is queued behind a cache listing', async () => {
    const h = harness(Array.from({ length: 11 }, (_, i) => before(i)));
    const originalRead = h.port.listFiles;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.port.listFiles = async () => { entered(); await gate; return originalRead(); };
    const listing = h.store.list();
    await started;
    const sharing = h.store.share(before(0).name);
    release();
    expect(await listing).toHaveLength(11);
    await sharing;
    expect(h.deleted).toEqual([]);
  });

  it('rechecks queued shares between deletions rather than using a stale keep snapshot', async () => {
    const h = harness(Array.from({ length: 12 }, (_, i) => before(i)));
    const originalDelete = h.port.deleteFile;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.port.deleteFile = async name => {
      if (name === before(1).name) { entered(); await gate; }
      return originalDelete(name);
    };
    const listing = h.store.list();
    await started;
    const sharing = h.store.share(before(0).name);
    release();
    expect(await listing).toHaveLength(11);
    await sharing;
    expect(h.deleted).toEqual([before(1).name]);
  });

  it('keeps ten usable copies when a newer automatic copy is truncated', async () => {
    const invalid = before(10);
    const files = Array.from({ length: 10 }, (_, i) => before(i));
    const h = harness([...files, invalid]);
    h.contents.set(invalid.name, completeBackup.slice(0, -10));

    const listed = await h.store.list();

    expect(listed).toHaveLength(11);
    expect(listed[0]).toMatchObject({ name: invalid.name, unavailableReason: expect.stringContaining('JSON') });
    expect(listed.slice(1).every(file => file.unavailableReason === undefined)).toBe(true);
    expect(h.deleted).toEqual([]);
  });

  it('verifies the file on both actions when its contents changed after listing', async () => {
    const file = before(0);
    const h = harness([file]);
    const listed = await h.store.list();
    expect(listed[0]?.unavailableReason).toBeUndefined();
    const mismatch = JSON.parse(completeBackup);
    mismatch.counts.txn = 1;
    h.contents.set(file.name, JSON.stringify(mismatch));
    let shares = 0;
    h.setShare(async () => { shares += 1; return 'shared'; });

    await expect(h.store.read(file.name)).rejects.toThrow('txn 表行数与文件声明不符');
    await expect(h.store.share(file.name)).rejects.toThrow('txn 表行数与文件声明不符');

    expect(shares).toBe(0);
  });
});
