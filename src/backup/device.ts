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
import type { BackupFileWriter } from './flow';
import { bytesToBase64 } from '../export/base64';
import type { BinaryFileWriter } from '../export/writer';
import { deviceFolder } from '../storage/folder';
import type { FolderAccess } from '../storage/folder';

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

/** The one system share sheet both export channels use. */
async function shareCacheFile(fileName: string, uri: string): Promise<void> {
  const { Share } = await import('@capacitor/share');
  // Share with files, not a bare url: Android's FileProvider path for the
  // cache is already declared in android/app/src/main/res/xml/file_paths.xml.
  await Share.share({
    title: fileName,
    files: [uri],
    dialogTitle: '导出到文件',
  });
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
  shareCacheFile(fileName: string, uri: string): Promise<void>;
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
  async function writeToFolder(fileName: string, bytes: Uint8Array): Promise<boolean> {
    const folder = await deps.folder.current();
    if (folder === null) return false;
    const result = await deps.folder.write(fileName, bytesToBase64(bytes));
    return result.saved;
  }

  return {
    text: {
      async writeForShare(fileName, text) {
        const native = await deps.isNativePlatform();
        if (!native) {
          deps.downloadInBrowser(fileName, new Blob([text], { type: 'application/json' }));
          return;
        }

        if (await writeToFolder(fileName, new TextEncoder().encode(text))) return;

        const uri = await deps.writeCacheFile(fileName, text);
        await deps.shareCacheFile(fileName, uri);
      },

      async writeCopy(fileName, text) {
        if (!(await deps.isNativePlatform())) return;
        if (await writeToFolder(fileName, new TextEncoder().encode(text))) return;
        await deps.writeCacheFile(fileName, text);
      },
    },

    binary: {
      async writeForShare(fileName, bytes, mimeType) {
        const native = await deps.isNativePlatform();
        if (!native) {
          deps.downloadInBrowser(fileName, new Blob([new Uint8Array(bytes)], { type: mimeType }));
          return;
        }

        if (await writeToFolder(fileName, bytes)) return;

        const uri = await deps.writeCacheBytes(fileName, bytes);
        await deps.shareCacheFile(fileName, uri);
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
