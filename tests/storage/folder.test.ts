import { describe, expect, it, vi } from 'vitest';
import { createFolderAccess } from '../../src/storage/folder';
import type { FolderPlugin, NativeBridge } from '../../src/storage/folder';

function fake(overrides: Partial<FolderPlugin> = {}): NativeBridge {
  const plugin: FolderPlugin = {
    getFolder: async () => ({}),
    chooseFolder: async () => ({ canceled: true }),
    clearFolder: async () => {},
    openFolder: async () => ({ opened: false }),
    writeFile: async ({ name }) => ({ saved: true, name }),
    ...overrides,
  };
  Object.defineProperty(plugin, 'then', {
    get() { throw new Error('Do not await the native plugin proxy'); },
  });
  return { plugin };
}

describe('folder bridge', () => {
  it('falls back to no folder in the browser', async () => {
    const access = createFolderAccess(async () => null);
    expect(await access.available()).toBe(false);
    expect(await access.current()).toBeNull();
    expect(await access.choose()).toBe(false);
    expect(await access.open()).toBe(false);
    expect(await access.write('x.ledger', '')).toEqual({ saved: false, name: 'x.ledger' });
  });

  it('reads the native folder through the wrapper, without awaiting the proxy', async () => {
    const access = createFolderAccess(async () => fake({ getFolder: async () => ({ name: ' 合成目录 ' }) }));
    expect(await access.current()).toEqual({ name: '合成目录' });
  });

  it('distinguishes a legacy or revoked directory from a new install', async () => {
    const access = createFolderAccess(async () => fake({ getFolder: async () => ({ needsReselection: true }) }));
    expect(await access.status()).toEqual({ folder: null, needsReselection: true });
    expect(await access.current()).toBeNull();
  });

  it('returns no usable folder after a bridge failure, but exposes the error to settings', async () => {
    const access = createFolderAccess(async () => fake({ getFolder: async () => { throw Error('provider offline'); } }));
    await expect(access.status()).rejects.toThrow('provider offline');
    expect(await access.current()).toBeNull();
  });

  it('allows export to fall back when a directory capability read stalls', async () => {
    vi.useFakeTimers();
    try {
      const access = createFolderAccess(async () => fake({ getFolder: () => new Promise(() => {}) }));
      const current = access.current();
      await vi.advanceTimersByTimeAsync(8000);
      await expect(current).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a system picker without passing any path and distinguishes cancel', async () => {
    const chooseFolder = vi.fn<FolderPlugin['chooseFolder']>()
      .mockResolvedValueOnce({ canceled: true }).mockResolvedValueOnce({ canceled: false });
    const access = createFolderAccess(async () => fake({ chooseFolder }));
    expect(await access.choose()).toBe(false);
    expect(await access.choose()).toBe(true);
    expect(chooseFolder.mock.calls).toEqual([[], []]);
  });

  it('reports the actual native filename and retains binary Base64', async () => {
    const writeFile = vi.fn<FolderPlugin['writeFile']>().mockResolvedValue({ saved: true, name: 'x (2).xlsx' });
    const access = createFolderAccess(async () => fake({ writeFile }));
    expect(await access.write('x.xlsx', 'AAEC')).toEqual({ saved: true, name: 'x (2).xlsx' });
    expect(writeFile).toHaveBeenCalledWith({ name: 'x.xlsx', base64: 'AAEC' });
  });
});
