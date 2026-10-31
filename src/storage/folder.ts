/**
 * The owner-chosen storage folder.
 *
 * On Android the app asks for 「所有文件访问」 (MANAGE_EXTERNAL_STORAGE) and then
 * writes with java.io.File into a normal directory that any file manager can
 * see. The native FolderPlugin owns the permission, the remembered path and
 * the writes; this module is the only JS code that names that bridge.
 *
 * Like src/db/index.ts and src/backup/device.ts, the native plugin is imported
 * with a dynamic import() inside the function that needs it. A Node/Vitest
 * process therefore never evaluates bridge code, and the web build does not
 * pull the plugin into the initial chunk. In a browser there is no plugin, so
 * every method reports denied access / no folder and the export edge keeps its
 * old cache + share path.
 */

/** A folder the app can write into: an absolute path and its display name. */
export interface StoredFolder {
  path: string;
  name: string;
}

/** Whether the system-wide file permission is held. */
export interface StorageAccessState {
  granted: boolean;
  /** Present when the answer lives in system settings rather than a dialog. */
  reason?: 'settings';
}

/** One directory in the in-app browser. */
export interface FolderEntry {
  name: string;
  path: string;
}

/** One browser page: where it is, how to go up, and the subdirectories. */
export interface FolderListing {
  path: string;
  /** Null at the shared-storage root; the UI disables 上一级 there. */
  parent: string | null;
  dirs: FolderEntry[];
}

/** The native bridge's answer; a null path means "no usable folder". */
export interface FolderBridgeResult {
  path: string | null;
  name?: string | null;
}

/** What the bridge reports after a write; saved false means "not written". */
export interface FolderWriteResult {
  saved: boolean;
  name: string;
}

/** The methods FolderPlugin exposes to JavaScript. */
export interface FolderPlugin {
  getAccess(): Promise<StorageAccessState>;
  requestAccess(): Promise<StorageAccessState>;
  listDirs(options: { path?: string }): Promise<FolderListing>;
  getFolder(): Promise<FolderBridgeResult>;
  setFolder(options: { path: string }): Promise<FolderBridgeResult>;
  clearFolder(): Promise<void>;
  openFolder(): Promise<{ opened: boolean }>;
  writeFile(options: { name: string; base64: string }): Promise<FolderWriteResult>;
}

/**
 * The folder as the rest of the app sees it. Every call resolves to the
 * non-native answer when there is no bridge, so callers never branch on the
 * platform themselves.
 */
export interface FolderAccess {
  /** The remembered folder, or null when none is usable. */
  current(): Promise<StoredFolder | null>;
  /** Reads the system permission without prompting. */
  getAccess(): Promise<StorageAccessState>;
  /** Opens the system page, then reports the state after the owner returns. */
  requestAccess(): Promise<StorageAccessState>;
  /** Lists subdirectories; no path means the shared-storage root. */
  list(path?: string): Promise<FolderListing>;
  /** Remembers a directory after the bridge proves it is writable. */
  choose(path: string): Promise<StoredFolder | null>;
  /** True when the native plugin is actually reachable in this shell. */
  available(): Promise<boolean>;
  /** Forgets the remembered folder; the default location returns on demand. */
  clear(): Promise<void>;
  /** Opens the folder in the system file manager; false means no app handled it. */
  open(): Promise<boolean>;
  /** Creates or replaces one file in the folder. Rejects when it cannot. */
  write(name: string, base64: string): Promise<FolderWriteResult>;
}

/** The name used both in MainActivity and here. */
const PLUGIN_NAME = 'Folder';

/** A folder can come back without a display name; the UI still needs a word. */
const UNNAMED_FOLDER = '所选文件夹';

/** Normalizes { path, name } and turns a null path into null. */
function toFolder(result: FolderBridgeResult | null | undefined): StoredFolder | null {
  if (result === null || result === undefined) return null;
  const path = typeof result.path === 'string' ? result.path.trim() : '';
  if (path === '') return null;

  const name = typeof result.name === 'string' ? result.name.trim() : '';
  return { path, name: name === '' ? UNNAMED_FOLDER : name };
}

/** Keeps only the two fields the screen uses. */
function toAccess(result: StorageAccessState | null | undefined): StorageAccessState {
  if (result !== null && result !== undefined && result.granted === true) {
    return { granted: true };
  }
  return result?.reason === 'settings'
    ? { granted: false, reason: 'settings' }
    : { granted: false };
}

/** Defensive shape of one bridge listing; the native side returns these fields. */
function toListing(
  result: FolderListing | null | undefined,
  requested: string | undefined
): FolderListing {
  if (result === null || result === undefined) {
    return { path: requested ?? '', parent: null, dirs: [] };
  }
  const dirs = Array.isArray(result.dirs)
    ? result.dirs.filter(
        (entry): entry is FolderEntry =>
          typeof entry?.name === 'string' &&
          entry.name !== '' &&
          typeof entry.path === 'string' &&
          entry.path !== ''
      )
    : [];
  return {
    path: typeof result.path === 'string' ? result.path : requested ?? '',
    parent: typeof result.parent === 'string' ? result.parent : null,
    dirs,
  };
}

/**
 * The bridge, handed over inside a plain object.
 *
 * This wrapper is not decoration — it is the fix for a bug that cost three
 * rounds of debugging. registerPlugin returns a Proxy whose every property,
 * including `then`, answers with a "call this plugin method" stub. Returning
 * that proxy from an async function makes the promise-resolution procedure
 * probe `.then`, call the stub, and then wait forever for a resolve that the
 * native side never receives: the plugin method name arrives as "Folder.then".
 * A promise may therefore never *resolve to* the proxy, only to something that
 * holds it.
 */
export interface NativeBridge {
  readonly plugin: FolderPlugin;
}

/**
 * Loads the bridge on first use. A browser never gets past isNativePlatform,
 * and Node tests that pass their own loader never import @capacitor/core.
 */
async function loadNativePlugin(): Promise<NativeBridge | null> {
  const { Capacitor, registerPlugin } = await import('@capacitor/core');
  if (!Capacitor.isNativePlatform()) return null;
  return { plugin: registerPlugin<FolderPlugin>(PLUGIN_NAME) };
}

/**
 * Builds the folder facade around a plugin loader. The loader is a parameter
 * so tests can put a fake bridge behind the exact code the app runs.
 */
export function createFolderAccess(
  loadPlugin: () => Promise<NativeBridge | null> = loadNativePlugin
): FolderAccess {
  return {
    async current() {
      // A missing or broken bridge is the same thing as no folder: the export
      // edge then uses the cache + share sheet it has always used.
      const bridge = await loadPlugin().catch(() => null);
      if (bridge === null) return null;
      try {
        return toFolder(await bridge.plugin.getFolder());
      } catch {
        return null;
      }
    },

    async getAccess() {
      const bridge = await loadPlugin().catch(() => null);
      if (bridge === null) return { granted: false };
      try {
        return toAccess(await bridge.plugin.getAccess());
      } catch {
        // An unanswered permission check is not a grant.
        return { granted: false };
      }
    },

    async requestAccess() {
      const bridge = await loadPlugin();
      if (bridge === null) return { granted: false };
      // Let a failure reach the screen: it can say the system page did not open.
      return toAccess(await bridge.plugin.requestAccess());
    },

    async list(path) {
      const bridge = await loadPlugin();
      if (bridge === null) {
        return { path: path ?? '', parent: null, dirs: [] };
      }
      return toListing(
        await bridge.plugin.listDirs(path === undefined ? {} : { path }),
        path
      );
    },

    async choose(path) {
      const bridge = await loadPlugin();
      if (bridge === null) return null;
      return toFolder(await bridge.plugin.setFolder({ path }));
    },

    async available() {
      try {
        const { Capacitor } = await import('@capacitor/core');
        return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable(PLUGIN_NAME);
      } catch {
        return false;
      }
    },

    async clear() {
      const bridge = await loadPlugin();
      if (bridge !== null) await bridge.plugin.clearFolder();
    },

    async open() {
      const bridge = await loadPlugin();
      if (bridge === null) return false;
      try {
        const result = await bridge.plugin.openFolder();
        return result.opened === true;
      } catch {
        // A rejected ACTION_VIEW is the same owner-facing outcome as no
        // handler: a sentence, not a crash.
        return false;
      }
    },

    async write(name, base64) {
      const bridge = await loadPlugin();
      if (bridge === null) return { saved: false, name };
      return bridge.plugin.writeFile({ name, base64 });
    },
  };
}

/** The app-wide facade. Nothing native is imported until a method runs. */
export const deviceFolder: FolderAccess = createFolderAccess();

/** The settings screen's location line: the folder name, or "not set". */
export function folderLabel(folder: StoredFolder | null): string {
  return folder === null ? '未设置' : folder.name;
}
