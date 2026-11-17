/**
 * The device edge of export: the owner's folder first, then the old cache +
 * share sheet, plus the browser fallback.
 *
 * FolderPlugin writes backups and workbooks through the chosen directory grant.
 * If no usable folder exists, user exports use the app cache and share sheet.
 *
 * The Capacitor plugins are imported with a dynamic import() inside the
 * function that needs them, exactly as src/db/index.ts loads the SQLite driver.
 * Importing this module in a Node/Vitest process therefore never evaluates
 * native bridge code, and the web build does not pull the plugins into the
 * initial chunk.
 *
 * Directory.Cache stays private to the app. Share hands one cache file to
 * whichever app the owner picks.
 */
import type { BackupFileWriter, CopyDestination, ExportDestination } from './flow';
import { bytesToBase64 } from '../export/base64';
import type { BinaryFileWriter } from '../export/writer';
import { hasZipEnd, ZIP_END_BYTES } from '../export/zip';
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
async function writeNativeCacheFile(fileName: string, text: string): Promise<string> {
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
 * Publishes the workbook after all bytes are written. A failed write leaves
 * no .xlsx entry that could be offered again by the cache list.
 */
async function publishCacheWorkbook(fileName: string, bytes: Uint8Array): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const directory = Directory.Cache;
  const temporary = `${fileName}.writing`;
  const remove = (path: string) => Filesystem.deleteFile({ path, directory }).catch(() => {});
  try {
    await Filesystem.writeFile({ path: temporary, data: bytesToBase64(bytes), directory });
  } catch (error) {
    await remove(temporary);
    throw error;
  }
  try {
    await Filesystem.rename({ from: temporary, to: fileName, directory });
  } catch (error) {
    // Android may fall back to copying on a failed rename. This destination
    // was reserved as unused. Keep the source as an incomplete-publication
    // marker if deleting the partial destination also fails.
    try {
      await Filesystem.deleteFile({ path: fileName, directory });
      await remove(temporary);
    } catch (cleanupError) {
      if (
        typeof cleanupError === 'object' && cleanupError !== null &&
        'code' in cleanupError && cleanupError.code === 'OS-PLUG-FILE-0008'
      ) {
        // Rename failed before creating a destination, or it was already evicted.
        await remove(temporary);
      }
      // For other deletion failures, leave the .writing marker in place.
    }
    throw error;
  }
  return (await Filesystem.getUri({ path: fileName, directory })).uri;
}

/** What the share sheet did: handed the file over, or the owner backed out. */
export type ShareOutcome = 'shared' | 'canceled';

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
  writeCachedReport(fileName: string, bytes: Uint8Array): Promise<{ fileName: string; uri: string }>;
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
 * exists. A bridge that answers { saved: false } — or rejects, because the
 * folder became unwritable after it was read — is treated like "no folder":
 * the cache + share sheet still gets the file, so an export is never lost to
 * a folder that silently declined.
 */
export function createDeviceWriters(deps: DeviceWriterDeps): DeviceWriters {
  async function writeToFolder(
    fileName: string,
    bytes: Uint8Array
  ): Promise<{ folderName: string; fileName: string } | null> {
    const folder = await deps.folder.current();
    if (folder === null) return null;

    const base64 = bytesToBase64(bytes);
    try {
      const result = await deps.folder.write(fileName, base64);
      return result.saved ? { folderName: result.folderName ?? folder.name, fileName: result.name } : null;
    } catch {
      // A folder can turn unwritable between current() and write(): permission
      // revoked, directory deleted, read-only, or full. The native writer never
      // opens an old file for writing; this is the same fallback path as
      // a bridge that answered { saved: false }. Only the folder write is
      // caught — if the cache itself then fails, that error still reaches the
      // screen instead of inventing a successful export.
      return null;
    }
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
        if (folder !== null) return { kind: 'folder', folderName: folder.folderName, fileName: folder.fileName };

        const uri = await deps.writeCacheFile(fileName, text);
        const outcome = await deps.shareCacheFile(fileName, uri);
        return outcome === 'canceled' ? { kind: 'canceled' } : { kind: 'share' };
      },

      async writeCopy(fileName, text): Promise<CopyDestination> {
        if (!(await deps.isNativePlatform())) return { kind: 'none' };
        const folder = await writeToFolder(fileName, new TextEncoder().encode(text));
        if (folder !== null) return { kind: 'folder', folderName: folder.folderName, fileName: folder.fileName };
        const uri = await deps.writeCacheFile(fileName, text);
        return { kind: 'cache', uri };
      },
    },

    binary: {
      async writeForShare(fileName, bytes, mimeType) {
        const native = await deps.isNativePlatform();
        if (!native) {
          deps.downloadInBrowser(fileName, new Blob([new Uint8Array(bytes)], { type: mimeType }));
          return { kind: 'download' };
        }

        const folder = await writeToFolder(fileName, bytes);
        if (folder !== null) return { kind: 'folder', ...folder };

        const cached = await deps.writeCachedReport(fileName, bytes);
        const outcome = await deps.shareCacheFile(cached.fileName, cached.uri);
        return { kind: outcome === 'canceled' ? 'canceled' : 'share', fileName: cached.fileName };
      },
    },
  };
}

const deviceWriters = createDeviceWriters({
  isNativePlatform,
  folder: deviceFolder,
  // Defer access until an action runs; the store is initialized below. All
  // text cache writes share its queue with retention and cached-file sharing.
  writeCacheFile: (fileName, text) => cachedBackups.write(fileName, text),
  writeCachedReport: (fileName, bytes) => cachedReports.write(fileName, bytes),
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

/** One exported file in the app cache. */
export interface CachedFile {
  name: string;
  uri: string;
  bytes: number;
  /** Epoch milliseconds from the file's mtime. */
  modifiedAt: number;
}

export type CachedBackup = CachedFile;

/** The filesystem fields the cache listing reads; a subset of Capacitor's FileInfo. */
export interface CachedFileInfo {
  name: string;
  type: string;
  uri: string;
  size: number;
  mtime: number;
}

function cachedEntries(files: readonly CachedFileInfo[], accept: (name: string) => boolean): CachedFile[] {
  return files
    .filter(file =>
      file.type === 'file' && accept(file.name) &&
      Number.isSafeInteger(file.size) && file.size >= 0 &&
      Number.isFinite(file.mtime) && !Number.isNaN(new Date(file.mtime).getTime())
    )
    .map(file => ({ name: file.name, uri: file.uri, bytes: file.size, modifiedAt: file.mtime }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name));
}

export interface CachedBackupPort {
  isNativePlatform(): Promise<boolean>;
  listFiles(): Promise<readonly CachedFileInfo[]>;
  writeFile(fileName: string, text: string): Promise<string>;
  /** Deletes a base name in Directory.Cache, never a caller-supplied URI. */
  deleteFile(fileName: string): Promise<void>;
  share(fileName: string, uri: string): Promise<ShareOutcome>;
}

export interface CachedBackupStore {
  /** Prunes old automatic copies, then lists remaining .ledger files newest first. */
  list(): Promise<CachedBackup[]>;
  /** Writes first; best-effort retention can never turn a saved copy into failure. */
  write(fileName: string, text: string): Promise<string>;
  /** Opens the share sheet for one of them; cancel is an outcome, not an error. */
  share(file: CachedBackup): Promise<ShareOutcome>;
}

export const AUTO_BEFORE_CACHE_LIMIT = 10;

/** Only the app's automatic-copy names, including the old minute precision. */
function isAutomaticBeforeCopy(name: string): boolean {
  const match = /^记账本-(\d{4})(\d{2})(\d{2})-(?:[01]\d|2[0-3])[0-5]\d(?:[0-5]\d)?-before\.ledger$/.exec(name);
  if (match === null) return false;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00`);
  return date.getFullYear() === Number(match[1]) &&
    date.getMonth() + 1 === Number(match[2]) && date.getDate() === Number(match[3]);
}

/**
 * The cache backups the owner can still rescue. They are not "backups" in the
 * app_meta sense — the system may delete them — but they are the only copy of
 * a share that was never confirmed, so the screen has to make them reachable.
 */
export function createCachedBackupStore(port: CachedBackupPort): CachedBackupStore {
  let tail: Promise<void> = Promise.resolve();
  const sharedNames = new Set<string>();
  let latestWrittenCopy: string | null = null;

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function readFiles(): Promise<CachedBackup[]> {
    return cachedEntries(await port.listFiles(), name => name.endsWith('.ledger'));
  }

  async function prune(files: CachedBackup[]): Promise<CachedBackup[]> {
    const copies = files.filter(file => isAutomaticBeforeCopy(file.name));
    const keep = new Set(copies.slice(0, AUTO_BEFORE_CACHE_LIMIT).map(file => file.name));
    for (const file of copies) {
      if (sharedNames.has(file.name) || file.name === latestWrittenCopy) keep.add(file.name);
    }
    const removed = new Set<string>();
    for (const file of copies) {
      // Share requests can arrive while this pass awaits another deletion.
      // Check the live protection set, not only the initial keep snapshot.
      if (keep.has(file.name) || sharedNames.has(file.name)) continue;
      try {
        await port.deleteFile(file.name);
        removed.add(file.name);
      } catch {
        // Keep failed deletions visible/recoverable; try again on a later pass.
      }
    }
    return files.filter(file => !removed.has(file.name));
  }

  return {
    list: () => enqueue(async () => {
      if (!(await port.isNativePlatform())) return [];
      return prune(await readFiles());
    }),

    write: (fileName, text) => enqueue(async () => {
      const uri = await port.writeFile(fileName, text);
      if (isAutomaticBeforeCopy(fileName)) latestWrittenCopy = fileName;
      try {
        await prune(await readFiles());
      } catch {
        // The new copy is already saved. A failed directory read must not
        // block import/reset or misreport the successful write as a failure.
      }
      return uri;
    }),

    share(file) {
      // A target app may read the URI after the chooser returns. Protect it
      // for this app session, including ambiguous failures, rather than
      // assuming that Share's result is a receipt or an end-of-read signal.
      // Register at request time, before waiting behind an earlier prune.
      if (isAutomaticBeforeCopy(file.name)) sharedNames.add(file.name);
      return enqueue(() => port.share(file.name, file.uri));
    },
  };
}

async function listNativeCacheFiles(): Promise<readonly CachedFileInfo[]> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  return (await Filesystem.readdir({ path: '', directory: Directory.Cache })).files;
}

const nativeCachedBackupPort: CachedBackupPort = {
  isNativePlatform,
  listFiles: listNativeCacheFiles,
  writeFile: writeNativeCacheFile,
  async deleteFile(fileName) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    await Filesystem.deleteFile({ path: fileName, directory: Directory.Cache });
  },
  share: shareCacheFile,
};

/** The app-wide cache listing. Nothing native is imported until list() runs. */
export const cachedBackups: CachedBackupStore = createCachedBackupStore(nativeCachedBackupPort);

type CachedReportPort = Pick<CachedBackupPort, 'isNativePlatform' | 'listFiles' | 'share'> & {
  publish(fileName: string, bytes: Uint8Array): Promise<string>;
  isComplete(file: CachedFile): Promise<boolean>;
};

// Recognizes the original month/year names and numbered copies in Directory.Cache.
const reportName = /^(记账本-[1-9]\d{3}(?:-(?:0[1-9]|1[0-2]))?)(?: \((?:[2-9]|[1-9]\d+)\))?\.xlsx$/;

export function createCachedReportStore(port: CachedReportPort) {
  let tail: Promise<void> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function list(): Promise<CachedFile[]> {
    // An Android rename may copy bytes as a fallback. A listing queued behind
    // the write only sees published reports after that step or its cleanup.
    return enqueue(async () => {
      if (!(await port.isNativePlatform())) return [];
      const files = await port.listFiles();
      const incomplete = new Set(files.map(file => file.name).filter(name => name.endsWith('.writing')));
      const candidates = cachedEntries(files, name => reportName.test(name) && !incomplete.has(`${name}.writing`));
      const complete: CachedFile[] = [];
      for (const file of candidates) {
        if (file.bytes >= ZIP_END_BYTES && file.uri.startsWith('file://') && await port.isComplete(file)) {
          complete.push(file);
        }
      }
      return complete;
    });
  }

  return {
    list,
    write(fileName: string, bytes: Uint8Array): Promise<{ fileName: string; uri: string }> {
      return enqueue(async () => {
        const base = reportName.exec(fileName)?.[1];
        if (!base) throw new Error('报表文件名无效。');
        const names = new Set((await port.listFiles()).map(file => file.name));
        let available = fileName;
        for (let number = 2; names.has(available) || names.has(`${available}.writing`); number += 1) {
          available = `${base} (${number}).xlsx`;
        }
        return { fileName: available, uri: await port.publish(available, bytes) };
      });
    },
    async share(fileName: string): Promise<ShareOutcome> {
      const file = (await list()).find(entry => entry.name === fileName);
      if (!file) throw new Error('报表已不在应用缓存中。');
      return port.share(file.name, file.uri);
    },
  };
}

export const cachedReports = createCachedReportStore({
  isNativePlatform,
  listFiles: listNativeCacheFiles,
  publish: publishCacheWorkbook,
  async isComplete(file) {
    // Older exports wrote directly to the final filename, and Android can
    // evict a .writing marker separately. Verify the ZIP footer as well.
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    try {
      const { data } = await Filesystem.readFile({
        path: file.name,
        directory: Directory.Cache,
        offset: file.bytes - ZIP_END_BYTES,
        length: ZIP_END_BYTES,
      });
      return typeof data === 'string' &&
        hasZipEnd(Uint8Array.from(atob(data), character => character.charCodeAt(0)), file.bytes);
    } catch {
      // The system may have removed this file since readdir.
      return false;
    }
  },
  share: shareCacheFile,
});
