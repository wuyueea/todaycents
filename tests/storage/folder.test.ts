import { describe, expect, it } from 'vitest';
import { createFolderAccess, folderLabel } from '../../src/storage/folder';
import type { FolderListing, FolderPlugin, NativeBridge } from '../../src/storage/folder';

const ROOT = '/storage/emulated/0';
const FOLDER = { path: ROOT + '/Documents/Books', name: 'Books' };

/**
 * A native bridge stand-in. It comes back inside the holder on purpose: the
 * real loader must never resolve *to* the plugin proxy (see NativeBridge).
 */
function fakePlugin(overrides: Partial<FolderPlugin> = {}): NativeBridge {
  return {
    plugin: {
      getAccess: async () => ({ granted: true }),
      requestAccess: async () => ({ granted: true }),
      listDirs: async ({ path }) => ({ path: path ?? ROOT, parent: null, dirs: [] }),
      getFolder: async () => ({ path: null, name: null }),
      setFolder: async ({ path }) => ({ path, name: 'Books' }),
      clearFolder: async () => {},
      openFolder: async () => ({ opened: false }),
      writeFile: async ({ name }) => ({ saved: true, name }),
      ...overrides,
    },
  };
}

/**
 * The regression test for the bug this file's whole shape protects against.
 *
 * The real plugin proxy answers EVERY property with a stub, `then` included, so
 * a promise must never resolve to it: the resolution procedure would call that
 * stub and wait forever. A plugin object that throws when its `then` is read
 * proves the facade only ever touches it through the holder.
 */
function thenableTrap(): NativeBridge {
  const plugin = fakePlugin().plugin as FolderPlugin & { then?: unknown };
  Object.defineProperty(plugin, 'then', {
    get() {
      throw new Error('the plugin proxy was awaited, not used');
    },
  });
  return { plugin };
}

describe('folderLabel', () => {
  it('uses the chosen folder name and says when no location is usable', () => {
    expect(folderLabel(FOLDER)).toBe('Books');
    expect(folderLabel(null)).toBe('未设置');
  });
});

describe('createFolderAccess without a native plugin', () => {
  it('reports denied access, no folder, and never throws', async () => {
    const access = createFolderAccess(async () => null);

    expect(await access.current()).toBeNull();
    expect(await access.getAccess()).toEqual({ granted: false });
    expect(await access.requestAccess()).toEqual({ granted: false });
    expect(await access.list()).toEqual({ path: '', parent: null, dirs: [] });
    expect(await access.choose(FOLDER.path)).toBeNull();
    expect(await access.open()).toBe(false);
    await expect(access.clear()).resolves.toBeUndefined();
    expect(await access.write('记账本.ledger', 'AA==')).toEqual({
      saved: false,
      name: '记账本.ledger',
    });
  });
});

describe('createFolderAccess', () => {
  it('passes getFolder through and normalizes the pair', async () => {
    let called = 0;
    const access = createFolderAccess(async () =>
      fakePlugin({
        getFolder: async () => {
          called += 1;
          return FOLDER;
        },
      })
    );

    expect(await access.current()).toEqual(FOLDER);
    expect(called).toBe(1);
  });

  it('passes the access state through, including the settings reason', async () => {
    const access = createFolderAccess(async () =>
      fakePlugin({ getAccess: async () => ({ granted: false, reason: 'settings' }) })
    );

    expect(await access.getAccess()).toEqual({ granted: false, reason: 'settings' });
  });

  it('requests access and returns the re-checked state', async () => {
    let requested = 0;
    const access = createFolderAccess(async () =>
      fakePlugin({
        requestAccess: async () => {
          requested += 1;
          return { granted: true };
        },
      })
    );

    expect(await access.requestAccess()).toEqual({ granted: true });
    expect(requested).toBe(1);
  });

  it('lists the default root when no path is given', async () => {
    const seen: { path?: string }[] = [];
    const listing: FolderListing = {
      path: ROOT,
      parent: null,
      dirs: [{ name: 'Documents', path: ROOT + '/Documents' }],
    };
    const access = createFolderAccess(async () =>
      fakePlugin({
        listDirs: async options => {
          seen.push(options);
          return listing;
        },
      })
    );

    expect(await access.list()).toEqual(listing);
    expect(seen).toEqual([{}]);
  });

  it('lists a requested directory unchanged', async () => {
    const seen: { path?: string }[] = [];
    const listing: FolderListing = {
      path: FOLDER.path,
      parent: ROOT + '/Documents',
      dirs: [{ name: '2026', path: FOLDER.path + '/2026' }],
    };
    const access = createFolderAccess(async () =>
      fakePlugin({
        listDirs: async options => {
          seen.push(options);
          return listing;
        },
      })
    );

    expect(await access.list(FOLDER.path)).toEqual(listing);
    expect(seen).toEqual([{ path: FOLDER.path }]);
  });

  it('chooses a folder through setFolder and returns the remembered pair', async () => {
    const seen: string[] = [];
    const access = createFolderAccess(async () =>
      fakePlugin({
        setFolder: async ({ path }) => {
          seen.push(path);
          return { path, name: '账本备份' };
        },
      })
    );

    expect(await access.choose(FOLDER.path)).toEqual({
      path: FOLDER.path,
      name: '账本备份',
    });
    expect(seen).toEqual([FOLDER.path]);
  });

  it('lets a failed choice reach the caller, so the screen can explain it', async () => {
    const access = createFolderAccess(async () =>
      fakePlugin({
        setFolder: async () => {
          throw new Error('这个文件夹不能写，请换一个。');
        },
      })
    );

    await expect(access.choose('/storage/emulated/0/Books')).rejects.toThrow(
      '这个文件夹不能写，请换一个。'
    );
  });

  it('gives an unnamed folder a readable fallback name', async () => {
    const access = createFolderAccess(async () =>
      fakePlugin({ getFolder: async () => ({ path: FOLDER.path, name: '  ' }) })
    );

    expect(await access.current()).toEqual({ path: FOLDER.path, name: '所选文件夹' });
  });

  it('forwards clearFolder and openFolder', async () => {
    let cleared = 0;
    let opened = 0;
    const access = createFolderAccess(async () =>
      fakePlugin({
        clearFolder: async () => {
          cleared += 1;
        },
        openFolder: async () => {
          opened += 1;
          return { opened: false };
        },
      })
    );

    await access.clear();
    expect(await access.open()).toBe(false);
    expect(cleared).toBe(1);
    expect(opened).toBe(1);
  });

  it('forwards writeFile name and base64 unchanged', async () => {
    const seen: { name: string; base64: string }[] = [];
    const access = createFolderAccess(async () =>
      fakePlugin({
        writeFile: async options => {
          seen.push(options);
          return { saved: true, name: options.name };
        },
      })
    );

    expect(await access.write('记账本-20261020-2214.ledger', 'AAEC')).toEqual({
      saved: true,
      name: '记账本-20261020-2214.ledger',
    });
    expect(seen).toEqual([{ name: '记账本-20261020-2214.ledger', base64: 'AAEC' }]);
  });

  it('lets a write failure reach the caller, so an export can fail loudly', async () => {
    const access = createFolderAccess(async () =>
      fakePlugin({
        writeFile: async () => {
          throw new Error('写不进这个文件夹。');
        },
      })
    );

    await expect(access.write('a.ledger', 'AA==')).rejects.toThrow('写不进这个文件夹。');
  });
});

describe('the proxy is never awaited', () => {
  it('reads every method through the holder, never as a thenable', async () => {
    const access = createFolderAccess(async () => thenableTrap());

    // Each of these would hang or throw if the facade awaited the plugin itself.
    expect(await access.getAccess()).toEqual({ granted: true });
    expect(await access.current()).toBeNull();
    expect(await access.list()).toEqual({ path: ROOT, parent: null, dirs: [] });
    expect(await access.choose(FOLDER.path)).toEqual(FOLDER);
    expect(await access.open()).toBe(false);
    expect(await access.write('a.ledger', 'AA==')).toEqual({ saved: true, name: 'a.ledger' });
    await expect(access.clear()).resolves.toBeUndefined();
    expect(await access.available()).toBe(false);
  });
});
