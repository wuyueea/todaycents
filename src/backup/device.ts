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
import type { Encoding } from '@capacitor/filesystem';
import { parseBackup } from '../db/backup';
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

function isMissingCacheFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === 'OS-PLUG-FILE-0008';
}

interface CachedWrite {
  fileName: string;
  uri: string;
}

/** Writes UTF-8 text into the app cache while holding the cache store queue. */
async function writeNativeCacheFile(fileName: string, text: string): Promise<CachedWrite> {
  const { Filesystem, Directory, Encoding: FileEncoding } = await import('@capacitor/filesystem');
  const directory = Directory.Cache;
  const exists = (path: string) => Filesystem.stat({ path, directory }).then(
    () => true,
    (error: unknown) => {
      if (isMissingCacheFile(error)) return false;
      throw error;
    }
  );
  if (!isLedgerCacheName(fileName)) throw new Error('缓存备份文件名无效。');
  const base = fileName.replace(/(?: \(\d+\))?\.ledger$/, '');
  let availableName = fileName;
  for (let number = 2; await exists(availableName) || await exists(writingName(availableName)); number += 1) {
    availableName = base + ' (' + number + ').ledger';
  }
  return { fileName: availableName, uri: await publishNativeCacheFile(availableName, text, FileEncoding.UTF8) };
}

function writingName(fileName: string): string {
  return fileName + '.writing';
}

/** Publishes a cache file after its temporary contents are fully written. */
async function publishNativeCacheFile(fileName: string, data: string, encoding?: Encoding): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const directory = Directory.Cache;
  const temporary = writingName(fileName);
  const remove = (path: string) => Filesystem.deleteFile({ path, directory }).catch(() => {});
  try {
    await Filesystem.writeFile({ path: temporary, data, directory, ...(encoding === undefined ? {} : { encoding }) });
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
      if (isMissingCacheFile(cleanupError)) {
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
  writeCacheFile(fileName: string, text: string): Promise<CachedWrite>;
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
  ): Promise<{ folderName: string; fileName: string; folderId?: string } | null> {
    const folder = await deps.folder.current();
    if (folder === null) return null;

    const base64 = bytesToBase64(bytes);
    try {
      const result = await deps.folder.write(fileName, base64);
      return result.saved
        ? { folderName: result.folderName ?? folder.name, fileName: result.name, folderId: result.folderId }
        : null;
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
        if (folder !== null) return { kind: 'folder', ...folder };

        const cached = await deps.writeCacheFile(fileName, text);
        const outcome = await deps.shareCacheFile(cached.fileName, cached.uri);
        return { kind: outcome === 'canceled' ? 'canceled' : 'share', fileName: cached.fileName };
      },

      async writeCopy(fileName, text): Promise<CopyDestination> {
        if (!(await deps.isNativePlatform())) return { kind: 'none' };
        const folder = await writeToFolder(fileName, new TextEncoder().encode(text));
        if (folder !== null) return { kind: 'folder', folderName: folder.folderName, fileName: folder.fileName };
        return { kind: 'cache', ...await deps.writeCacheFile(fileName, text) };
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
  /** A cached backup with this status cannot be restored or shared. */
  unavailableReason?: string;
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
  writeFile(fileName: string, text: string): Promise<CachedWrite>;
  readFile(fileName: string): Promise<string>;
  /** Deletes a base name in Directory.Cache, never a caller-supplied URI. */
  deleteFile(fileName: string): Promise<void>;
  share(fileName: string, uri: string): Promise<ShareOutcome>;
}

export interface CachedBackupStore {
  /** Lists checked .ledger files, pruning only excess usable automatic copies. */
  list(): Promise<CachedBackup[]>;
  /** Writes first; best-effort retention can never turn a saved copy into failure. */
  write(fileName: string, text: string): Promise<CachedWrite>;
  /** Reads and verifies one backup base name from Directory.Cache. */
  read(fileName: string): Promise<string>;
  /** Opens the share sheet for one of them; cancel is an outcome, not an error. */
  share(fileName: string): Promise<ShareOutcome>;
}

export const AUTO_BEFORE_CACHE_LIMIT = 10;

function isLedgerCacheName(name: string): boolean {
  return /^[^/\\:\0]+\.ledger$/.test(name);
}

const MISSING_BACKUP = '备份已不在应用缓存中，可能已被系统清理。';

/** Only the app's automatic-copy names, including the old minute precision. */
function isAutomaticBeforeCopy(name: string): boolean {
  const match = /^记账本-(\d{4})(\d{2})(\d{2})-(?:[01]\d|2[0-3])[0-5]\d(?:[0-5]\d)?-before(?: \((?:[2-9]|[1-9]\d+)\))?\.ledger$/.exec(name);
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
    const entries = await port.listFiles();
    const names = new Set(entries.map(entry => entry.name));
    return cachedEntries(entries, isLedgerCacheName).map(file => names.has(writingName(file.name))
      ? { ...file, unavailableReason: '文件写入未完成。' }
      : file);
  }

  async function readChecked(file: CachedBackup): Promise<string> {
    if (file.unavailableReason !== undefined) throw new Error(file.unavailableReason);
    if (file.bytes === 0) throw new Error('备份文件是空的。');
    let text: string;
    try {
      text = await port.readFile(file.name);
    } catch (error) {
      if (isMissingCacheFile(error)) throw new Error(MISSING_BACKUP);
      throw new Error('无法读取缓存备份。', { cause: error });
    }
    parseBackup(text, { checkCounts: true });
    return text;
  }

  async function inspect(files: CachedBackup[]): Promise<CachedBackup[]> {
    const checked: CachedBackup[] = [];
    for (const file of files) {
      try {
        await readChecked(file);
        checked.push(file);
      } catch (error) {
        checked.push({ ...file, unavailableReason: error instanceof Error ? error.message : '无法校验备份文件。' });
      }
    }
    return checked;
  }

  async function findFile(fileName: string): Promise<CachedBackup> {
    if (!isLedgerCacheName(fileName)) throw new Error('缓存备份文件名无效。');
    if (!(await port.isNativePlatform())) throw new Error('此环境无法读取应用缓存。');
    const file = (await readFiles()).find(entry => entry.name === fileName);
    if (file === undefined) throw new Error(MISSING_BACKUP);
    return file;
  }

  async function prune(files: CachedBackup[]): Promise<CachedBackup[]> {
    const copies = files.filter(file => file.unavailableReason === undefined && isAutomaticBeforeCopy(file.name));
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
      return prune(await inspect(await readFiles()));
    }),

    write: (fileName, text) => enqueue(async () => {
      const saved = await port.writeFile(fileName, text);
      if (isAutomaticBeforeCopy(saved.fileName)) latestWrittenCopy = saved.fileName;
      try {
        const copies = (await readFiles()).filter(file => isAutomaticBeforeCopy(file.name));
        if (copies.length > AUTO_BEFORE_CACHE_LIMIT) await prune(await inspect(copies));
      } catch {
        // The new copy is already saved. A failed directory read must not
        // block import/reset or misreport the successful write as a failure.
      }
      return saved;
    }),

    read: fileName => enqueue(async () => readChecked(await findFile(fileName))),

    share(fileName) {
      // A target app may read the URI after the chooser returns. Protect it
      // for this app session, including ambiguous failures, rather than
      // assuming that Share's result is a receipt or an end-of-read signal.
      // Register at request time, before waiting behind an earlier prune.
      if (isAutomaticBeforeCopy(fileName)) sharedNames.add(fileName);
      return enqueue(async () => {
        const file = await findFile(fileName);
        await readChecked(file);
        return port.share(file.name, file.uri);
      });
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
  async readFile(fileName) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const { data } = await Filesystem.readFile({
      path: fileName,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    if (typeof data !== 'string') throw new Error('无法读取缓存备份。');
    return data;
  },
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
  publish: (fileName, bytes) => publishNativeCacheFile(fileName, bytesToBase64(bytes)),
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
