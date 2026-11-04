/**
 * The device edge of export: the owner's folder first, then the old cache +
 * share sheet, plus the browser fallback.
 *
 * When a folder is set through 设置 › 存储, both backups and report workbooks
 * are written into it with the FolderPlugin (java.io.File under
 * MANAGE_EXTERNAL_STORAGE). When no folder is usable, or the native write
 * declines, the path is exactly what it was: app cache, then the system share
 * sheet.
 *
 * The Capacitor plugins are imported with a dynamic import() inside the
 * function that needs them, exactly as src/db/index.ts loads the SQLite driver.
 * Importing this module in a Node/Vitest process therefore never evaluates
 * native bridge code, and the web build does not pull the plugins into the
 * initial chunk.
 *
 * There is no network here: shared storage is reached only after the owner
 * grants 「所有文件访问」, Directory.Cache is the app's own sandbox, and Share
 * hands a cache file to whatever app the owner picks.
 */
import type { BackupFileWriter, CopyDestination, ExportDestination } from './flow';
import { bytesToBase64 } from '../export/base64';
import type { BinaryFileWriter } from '../export/writer';
import { deviceFolder } from '../storage/folder';
import type { FolderAccess, StoredFolder } from '../storage/folder';

/** True only inside the Android/iOS shell; false for pnpm dev in a browser. */
async function isNativePlatform(): Promise<boolean> {
  const { Capacitor } = await import('@capacitor/core');
  return Capacitor.isNativePlatform();
}

/**
 * pnpm dev has no native filesystem. A Blob download anchor is the smallest
 * browser equivalent: the same bytes, the same file name, saved by the browser.
 */
function downloadInBrowser(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking on the same tick can cancel the download in some engines.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Writes UTF-8 text into the app cache and returns its file:// URI. */
async function writeCacheFile(fileName: string, text: string): Promise<string> {
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
  const result = await Filesystem.writeFile({
    path: fileName,
    data: text,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  });
  return result.uri;
}

/**
 * Writes bytes into the app cache. Capacitor expects base64 when no encoding
 * is passed, which is how a store-only .xlsx reaches the share sheet without a
 * text round trip corrupting it.
 */
async function writeCacheBytes(fileName: string, bytes: Uint8Array): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const result = await Filesystem.writeFile({
    path: fileName,
    data: bytesToBase64(bytes),
    directory: Directory.Cache,
  });
  return result.uri;
}

/** What the share sheet did: handed the file over, or the owner backed out. */
export type ShareOutcome = 'shared' | 'canceled';

/**
 * The binary export channel (reports) has no destination object to report, so a
 * cancelled share has to surface as a rejection. The screen can still tell it
 * apart from a real failure and say the file is in the cache.
 */
export class ShareCanceledError extends Error {
  constructor() {
    super('分享已取消');
    this.name = 'ShareCanceledError';
  }
}

/**
 * True when a rejection is the owner dismissing the share sheet rather than a
 * real failure. @capacitor/share rejects with exactly "Share canceled" on
 * Android; matching that whole message keeps a real failure which happens to
 * contain the word "cancel" from being reported as a dismissal.
 */
export function isShareCanceled(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof error === 'object' &&
            error !== null &&
            typeof (error as { message?: unknown }).message === 'string'
          ? (error as { message: string }).message
          : '';
  return /^Share cancel+ed$/i.test(message.trim());
}

/** The one system share sheet both export channels use. */
async function shareCacheFile(fileName: string, uri: string): Promise<ShareOutcome> {
  const { Share } = await import('@capacitor/share');
  // Share with files, not a bare url: Android's FileProvider path for the
  // cache is already declared in android/app/src/main/res/xml/file_paths.xml.
  try {
    await Share.share({
      title: fileName,
      files: [uri],
      dialogTitle: '导出到文件',
    });
    return 'shared';
  } catch (error) {
    if (isShareCanceled(error)) return 'canceled';
    throw error;
  }
}

/**
 * Everything the writers touch outside this module. It is a parameter so Node
 * tests can observe the folder path and the cache fallback without a bridge.
 */
export interface DeviceWriterDeps {
  isNativePlatform(): Promise<boolean>;
  folder: FolderAccess;
  writeCacheFile(fileName: string, text: string): Promise<string>;
  writeCacheBytes(fileName: string, bytes: Uint8Array): Promise<string>;
  shareCacheFile(fileName: string, uri: string): Promise<ShareOutcome>;
  downloadInBrowser(fileName: string, blob: Blob): void;
}

/** The two export channels the screens inject into the flows. */
export interface DeviceWriters {
  text: BackupFileWriter;
  binary: BinaryFileWriter;
}

/**
 * Builds both writers around the same folder-first rule.
 *
 * The folder is only consulted on a native platform, and only after a folder
 * exists. A bridge that answers { saved: false } is treated like "no folder":
 * the cache + share sheet still gets the file, so an export is never lost to
 * a folder that silently declined.
 */
export function createDeviceWriters(deps: DeviceWriterDeps): DeviceWriters {
  async function writeToFolder(
    fileName: string,
    bytes: Uint8Array
  ): Promise<StoredFolder | null> {
    const folder = await deps.folder.current();
    if (folder === null) return null;
    const result = await deps.folder.write(fileName, bytesToBase64(bytes));
    return result.saved ? folder : null;
  }

  return {
    text: {
      async writeForShare(fileName, text): Promise<ExportDestination> {
        const native = await deps.isNativePlatform();
        if (!native) {
          deps.downloadInBrowser(fileName, new Blob([text], { type: 'application/json' }));
          return { kind: 'download' };
        }

        const folder = await writeToFolder(fileName, new TextEncoder().encode(text));
        if (folder !== null) return { kind: 'folder', folderName: folder.name };

        const uri = await deps.writeCacheFile(fileName, text);
        const outcome = await deps.shareCacheFile(fileName, uri);
        return outcome === 'canceled' ? { kind: 'canceled' } : { kind: 'share' };
      },

      async writeCopy(fileName, text): Promise<CopyDestination> {
        if (!(await deps.isNativePlatform())) return { kind: 'none' };
        const folder = await writeToFolder(fileName, new TextEncoder().encode(text));
        if (folder !== null) return { kind: 'folder', folderName: folder.name };
        const uri = await deps.writeCacheFile(fileName, text);
        return { kind: 'cache', uri };
      },
    },

    binary: {
      async writeForShare(fileName, bytes, mimeType) {
        const native = await deps.isNativePlatform();
        if (!native) {
          deps.downloadInBrowser(fileName, new Blob([new Uint8Array(bytes)], { type: mimeType }));
          return;
        }

        if ((await writeToFolder(fileName, bytes)) !== null) return;

        const uri = await deps.writeCacheBytes(fileName, bytes);
        const outcome = await deps.shareCacheFile(fileName, uri);
        if (outcome === 'canceled') throw new ShareCanceledError();
      },
    },
  };
}

const deviceWriters = createDeviceWriters({
  isNativePlatform,
  folder: deviceFolder,
  writeCacheFile,
  writeCacheBytes,
  shareCacheFile,
  downloadInBrowser,
});

/** The app-wide writer. Nothing is imported from the plugins until it is used. */
export const deviceFileWriter: BackupFileWriter = deviceWriters.text;

/**
 * The workbook writer. It is the same channel as backups — the folder when
 * set, otherwise app cache and the system share sheet — with bytes and a MIME
 * type instead of a JSON string. A browser build gets the Blob download.
 */
export const deviceBinaryFileWriter: BinaryFileWriter = deviceWriters.binary;

/** One .ledger file sitting in the app cache, newest first on the screen. */
export interface CachedBackup {
  name: string;
  uri: string;
  bytes: number;
  /** Epoch milliseconds from the file's mtime. */
  modifiedAt: number;
}

/** The filesystem fields the cache listing reads; a subset of Capacitor's FileInfo. */
export interface CachedFileInfo {
  name: string;
  type: string;
  uri: string;
  size: number;
  mtime: number;
}

export interface CachedBackupPort {
  isNativePlatform(): Promise<boolean>;
  listFiles(): Promise<readonly CachedFileInfo[]>;
  share(fileName: string, uri: string): Promise<ShareOutcome>;
}

export interface CachedBackupStore {
  /** Every .ledger in the cache, newest first. A browser has no native cache. */
  list(): Promise<CachedBackup[]>;
  /** Opens the share sheet for one of them; cancel is an outcome, not an error. */
  share(file: CachedBackup): Promise<ShareOutcome>;
}

/**
 * The cache backups the owner can still rescue. They are not "backups" in the
 * app_meta sense — the system may delete them — but they are the only copy of
 * a share that was never confirmed, so the screen has to make them reachable.
 */
export function createCachedBackupStore(port: CachedBackupPort): CachedBackupStore {
  return {
    async list() {
      if (!(await port.isNativePlatform())) return [];
      const files = await port.listFiles();
      return files
        .filter((file) => file.type === 'file' && file.name.endsWith('.ledger'))
        // FileInfo crosses the native bridge. An invalid size or mtime would
        // throw in fileSizeText/toISOString while the screen renders, so drop
        // the row instead of taking the whole list down.
        .filter(
          (file) =>
            Number.isSafeInteger(file.size) &&
            file.size >= 0 &&
            Number.isFinite(file.mtime) &&
            !Number.isNaN(new Date(file.mtime).getTime())
        )
        .map((file) => ({
          name: file.name,
          uri: file.uri,
          bytes: file.size,
          modifiedAt: file.mtime,
        }))
        .sort((left, right) => right.modifiedAt - left.modifiedAt);
    },

    async share(file) {
      return port.share(file.name, file.uri);
    },
  };
}

const nativeCachedBackupPort: CachedBackupPort = {
  isNativePlatform,
  async listFiles() {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const result = await Filesystem.readdir({ path: '', directory: Directory.Cache });
    return result.files;
  },
  share: shareCacheFile,
};

/** The app-wide cache listing. Nothing native is imported until list() runs. */
export const cachedBackups: CachedBackupStore = createCachedBackupStore(nativeCachedBackupPort);
