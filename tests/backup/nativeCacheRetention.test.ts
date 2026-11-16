import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedFileInfo } from '../../src/backup/device';

const native = vi.hoisted(() => ({
  files: [] as CachedFileInfo[],
  write: vi.fn(), remove: vi.fn(), read: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' },
  Filesystem: { writeFile: native.write, deleteFile: native.remove, readdir: native.read },
}));
vi.mock('../../src/storage/folder', () => ({ deviceFolder: { current: async () => null } }));
import { deviceFileWriter } from '../../src/backup/device';

beforeEach(() => {
  native.files = Array.from({ length: 10 }, (_, i) => {
    const name = `记账本-20261101-1200${String(i).padStart(2, '0')}-before.ledger`;
    return { name, uri: `file:///cache/${name}`, size: 100, type: 'file', mtime: i + 1000 };
  });
  native.read.mockReset().mockImplementation(async () => ({ files: [...native.files] }));
  native.write.mockReset().mockImplementation(async ({ path }: { path: string }) => {
    const uri = `file:///cache/${path}`;
    native.files.push({ name: path, uri, size: 100, type: 'file', mtime: 9000 });
    return { uri };
  });
  native.remove.mockReset().mockImplementation(async ({ path }: { path: string }) => {
    native.files = native.files.filter(file => file.name !== path);
  });
});

describe('production cache writer binding', () => {
  it('routes automatic copies through retention and deletes only a cache base name', async () => {
    const name = '记账本-20261116-120000-before.ledger';
    await expect(deviceFileWriter.writeCopy(name, 'snapshot')).resolves.toEqual({
      kind: 'cache', uri: `file:///cache/${name}`,
    });
    expect(native.write).toHaveBeenCalledWith({ path: name, data: 'snapshot', directory: 'CACHE', encoding: 'utf8' });
    expect(native.remove).toHaveBeenCalledExactlyOnceWith({
      path: '记账本-20261101-120000-before.ledger', directory: 'CACHE',
    });
    expect(native.files).toHaveLength(10);
  });

  it('reports a saved cache copy even when cleanup fails', async () => {
    native.remove.mockRejectedValue(new Error('cache cleanup denied'));
    const name = '记账本-20261116-120001-before.ledger';
    await expect(deviceFileWriter.writeCopy(name, 'snapshot')).resolves.toEqual({
      kind: 'cache', uri: `file:///cache/${name}`,
    });
    expect(native.files).toHaveLength(11);
  });

  it('propagates a failed before write without starting cleanup', async () => {
    native.write.mockRejectedValue(new Error('disk full'));
    await expect(deviceFileWriter.writeCopy('记账本-20261116-120002-before.ledger', 'snapshot')).rejects.toThrow('disk full');
    expect(native.remove).not.toHaveBeenCalled();
    expect(native.read).not.toHaveBeenCalled();
  });
});
