import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedFileInfo } from '../../src/backup/device';
import { buildBackup, serializeBackup } from '../../src/db/backup';
import { createTestDb } from '../helpers/nodeDb';

const native = vi.hoisted(() => ({
  files: [] as CachedFileInfo[],
  contents: new Map<string, string>(),
  write: vi.fn(), rename: vi.fn(), getUri: vi.fn(), remove: vi.fn(), read: vi.fn(),
  stat: vi.fn(), readFile: vi.fn(), share: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' },
  Filesystem: {
    writeFile: native.write,
    rename: native.rename,
    getUri: native.getUri,
    deleteFile: native.remove,
    readdir: native.read,
    stat: native.stat,
    readFile: native.readFile,
  },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: native.share } }));
vi.mock('../../src/storage/folder', () => ({ deviceFolder: { current: async () => null } }));
import { cachedBackups, deviceFileWriter } from '../../src/backup/device';

const fileMissing = { code: 'OS-PLUG-FILE-0008' };
let completeBackup: string;

beforeAll(async () => {
  const file = await buildBackup(await createTestDb());
  file.tables.app_meta.push({ key: '备注', value: '合成备份' });
  file.counts.app_meta = 1;
  completeBackup = serializeBackup(file);
});

beforeEach(() => {
  native.files = Array.from({ length: 10 }, (_, i) => {
    const name = `记账本-20261101-1200${String(i).padStart(2, '0')}-before.ledger`;
    return { name, uri: `file:///cache/${name}`, size: 100, type: 'file', mtime: i + 1000 };
  });
  native.contents = new Map(native.files.map(file => [file.name, completeBackup]));
  native.read.mockReset().mockImplementation(async () => ({ files: [...native.files] }));
  native.stat.mockReset().mockImplementation(async ({ path }: { path: string }) => {
    const file = native.files.find(entry => entry.name === path);
    if (!file) throw fileMissing;
    return file;
  });
  native.readFile.mockReset().mockImplementation(async ({ path }: { path: string }) => {
    const data = native.contents.get(path);
    if (data === undefined) throw fileMissing;
    return { data };
  });
  native.write.mockReset().mockImplementation(async ({ path, data }: { path: string; data: string }) => {
    const uri = `file:///cache/${path}`;
    native.files.push({ name: path, uri, size: 100, type: 'file', mtime: 9000 });
    native.contents.set(path, data);
    return { uri };
  });
  native.remove.mockReset().mockImplementation(async ({ path }: { path: string }) => {
    if (!native.contents.delete(path)) throw fileMissing;
    native.files = native.files.filter(file => file.name !== path);
  });
  native.rename.mockReset().mockImplementation(async ({ from, to }: { from: string; to: string }) => {
    const data = native.contents.get(from);
    if (data === undefined) throw fileMissing;
    native.contents.set(to, data);
    native.contents.delete(from);
    native.files = native.files.map(file => file.name === from
      ? { ...file, name: to, uri: `file:///cache/${to}` }
      : file);
  });
  native.getUri.mockReset().mockImplementation(async ({ path }: { path: string }) => ({ uri: `file:///cache/${path}` }));
  native.share.mockReset().mockResolvedValue({});
});

describe('production cache writer binding', () => {
  it('routes automatic copies through retention and deletes only a cache base name', async () => {
    const name = '记账本-20261116-120000-before.ledger';
    await expect(deviceFileWriter.writeCopy(name, completeBackup)).resolves.toEqual({
      kind: 'cache', fileName: name, uri: `file:///cache/${name}`,
    });
    expect(native.write).toHaveBeenCalledExactlyOnceWith({
      path: name + '.writing', data: completeBackup, directory: 'CACHE', encoding: 'utf8',
    });
    expect(native.rename).toHaveBeenCalledExactlyOnceWith({ from: name + '.writing', to: name, directory: 'CACHE' });
    expect(native.remove).toHaveBeenCalledExactlyOnceWith({
      path: '记账本-20261101-120000-before.ledger', directory: 'CACHE',
    });
    expect(native.files).toHaveLength(10);
  });

  it('reports a saved cache copy even when cleanup fails', async () => {
    native.remove.mockRejectedValue(new Error('cache cleanup denied'));
    const name = '记账本-20261116-120001-before.ledger';
    await expect(deviceFileWriter.writeCopy(name, completeBackup)).resolves.toEqual({
      kind: 'cache', fileName: name, uri: `file:///cache/${name}`,
    });
    expect(native.files).toHaveLength(11);
  });

  it('propagates a failed before write without starting cleanup', async () => {
    const name = '记账本-20261116-120002-before.ledger';
    const createFile = native.write.getMockImplementation()!;
    native.write.mockImplementationOnce(async ({ path }) => {
      await createFile({ path, data: '{' });
      throw new Error('disk full');
    });
    await expect(deviceFileWriter.writeCopy(name, completeBackup)).rejects.toThrow('disk full');
    expect(native.rename).not.toHaveBeenCalled();
    expect(native.remove).toHaveBeenCalledExactlyOnceWith({ path: name + '.writing', directory: 'CACHE' });
    expect(native.contents.has(name + '.writing')).toBe(false);
    expect(native.contents.has(name)).toBe(false);
    expect(native.read).not.toHaveBeenCalled();
  });

  it('numbers a same-second automatic copy and retains the existing file', async () => {
    const original = native.files[9]!;
    const name = original.name.replace('.ledger', ' (2).ledger');
    await expect(deviceFileWriter.writeCopy(original.name, completeBackup)).resolves.toEqual({
      kind: 'cache', fileName: name, uri: `file:///cache/${name}`,
    });
    expect(native.write).toHaveBeenCalledExactlyOnceWith({
      path: name + '.writing', data: completeBackup, directory: 'CACHE', encoding: 'utf8',
    });
    expect(native.files).toContain(original);
    expect(await cachedBackups.list()).toHaveLength(10);
  });

  it('reads UTF-8 from the cache by base name and reports a missing backup', async () => {
    const name = native.files[0]!.name;
    await expect(cachedBackups.read(name)).resolves.toBe(completeBackup);
    expect(native.readFile).toHaveBeenCalledExactlyOnceWith({
      path: name, directory: 'CACHE', encoding: 'utf8',
    });
    await expect(cachedBackups.read('../other.ledger')).rejects.toThrow('文件名无效');
    expect(native.readFile).toHaveBeenCalledTimes(1);
    native.readFile.mockRejectedValue(fileMissing);
    await expect(cachedBackups.read(name)).rejects.toThrow('备份已不在应用缓存中');
  });

  it('flags incomplete publication when renaming fails and cleanup cannot remove it', async () => {
    const name = '记账本-20261116-120005-before.ledger';
    native.rename.mockImplementationOnce(async ({ from, to }) => {
      const partial = completeBackup.slice(0, -10);
      native.contents.set(to, partial);
      native.files.push({ ...native.files.find(file => file.name === from)!, name: to, uri: `file:///cache/${to}` });
      throw new Error('rename failed');
    });
    native.remove.mockRejectedValueOnce(new Error('cleanup denied'));

    await expect(deviceFileWriter.writeCopy(name, completeBackup)).rejects.toThrow('rename failed');
    const listing = await cachedBackups.list();
    expect(listing.find(file => file.name === name)?.unavailableReason).toContain('写入未完成');
    expect(listing.some(file => file.name.endsWith('.writing'))).toBe(false);
    await expect(cachedBackups.share(name)).rejects.toThrow('写入未完成');
    expect(native.share).not.toHaveBeenCalled();

    await native.remove({ path: name + '.writing' });
    expect((await cachedBackups.list()).find(file => file.name === name)?.unavailableReason).toContain('JSON');
    await expect(cachedBackups.read(name)).rejects.toThrow('JSON');
  });

  it('numbers a manual export if a leftover temporary file has the same name', async () => {
    const name = '记账本-20261116-120005.ledger';
    const numbered = '记账本-20261116-120005 (2).ledger';
    await native.write({ path: name + '.writing', data: '{' });
    await expect(cachedBackups.list()).resolves.not.toContainEqual(expect.objectContaining({ name }));
    await expect(deviceFileWriter.writeForShare(name, completeBackup)).resolves.toEqual({
      kind: 'share', fileName: numbered,
    });
    expect(native.contents.get(name + '.writing')).toBe('{');
    expect(native.contents.get(numbered)).toBe(completeBackup);
    expect(native.share).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      title: numbered, files: [`file:///cache/${numbered}`],
    }));
  });
});
