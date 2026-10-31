import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { deviceFolder, folderLabel } from '../storage/folder';
import type { FolderAccess, FolderListing, StoredFolder } from '../storage/folder';

/**
 * 设置 › 存储: where backups and exported workbooks go.
 *
 * The app holds 「所有文件访问」 and writes with java.io.File into an ordinary,
 * visible directory. Until that permission is granted the page offers exactly
 * one action: the system page where the switch lives. Once it is granted the
 * page shows the remembered location, a 更改位置 browser built from
 * FolderPlugin.listDirs, and 打开文件夹 for the system file manager.
 *
 * The export edge in src/backup/device.ts reads the same remembered folder, so
 * this screen never touches the writers directly.
 */

/** Shown when no app handles the folder or the Files app. */
export const OPEN_FOLDER_UNAVAILABLE = '这台设备没有能打开文件夹的应用。';

/** Shown when the native bridge is missing: the screen cannot do its job. */
export const PLUGIN_MISSING = '这台设备不支持存储设置。';

/** The short explanation under the one permission button. */
export const ACCESS_NEEDED = '需要「所有文件访问」，备份才能写进手机目录。';

/** The owner came back from settings without switching the permission on. */
export const ACCESS_STILL_DENIED = '还没有允许访问存储。';

/** Granted, but the remembered/default folder cannot be written right now. */
export const NO_USABLE_FOLDER = '当前文件夹不可用，导出会放进应用缓存。';

/** The three states the page can be in; checking is the first render. */
export type StorageAccessPhase = 'checking' | 'denied' | 'granted';

/** A failed open is a sentence, not an exception. */
export function openFolderNote(opened: boolean): string | null {
  return opened ? null : OPEN_FOLDER_UNAVAILABLE;
}

export interface StorageViewProps {
  access: StorageAccessPhase;
  folder: StoredFolder | null;
  /** Non-null while the in-app directory browser is open. */
  browser: FolderListing | null;
  busy: boolean;
  note: string | null;
  error: string | null;
  /** False in a browser, and on a device where the plugin did not register. */
  available?: boolean;
  /** The one line that says which layer is stuck while the check runs. */
  probe?: string;
  onRequestAccess(): void;
  onChange(): void;
  onOpen(): void;
  onUp(): void;
  onEnter(path: string): void;
  onChoose(): void;
  onCancelBrowse(): void;
}

/** The screen without any bridge, so SSR can render each state. */
export function StorageView({
  access,
  folder,
  browser,
  busy,
  note,
  error,
  available = true,
  probe = '',
  onRequestAccess,
  onChange,
  onOpen,
  onUp,
  onEnter,
  onChoose,
  onCancelBrowse,
}: StorageViewProps) {
  const noFolder = folder === null;

  return (
    <div className="backup-screen backup-screen--v1 storage-screen">
      <header className="settings-header">
        <Link className="add-back" to="/settings" aria-label="返回设置">
          ‹
        </Link>
        <h1>存储</h1>
      </header>

      {access === 'checking' && (
        <p className="backup-note" role="status">
          正在检查权限…
        </p>
      )}

      {/*
        自检行：这一行是给「按钮没反应」这种故障用的。它把问题定位到具体的
        一层——插件在不在、权限给没给——而不是让页面一直转圈。
      */}
      {access === 'checking' && (
        <p className="backup-note" role="status" data-storage-probe>
          {probe}
        </p>
      )}

      {access === 'denied' && (
        <>
          <section className="backup-state">
            <p className="backup-state__label">存储权限</p>
            <p className="backup-state__value">未允许</p>
          </section>
          <p className="backup-note">{ACCESS_NEEDED}</p>
          {available && (
            <div className="backup-actions">
              <button
                className="backup-button backup-button--primary"
                type="button"
                onClick={onRequestAccess}
                disabled={busy}
              >
                允许访问存储
              </button>
            </div>
          )}
        </>
      )}

      {access === 'granted' && browser === null && (
        <>
          <section className="backup-state">
            <p className="backup-state__label">当前位置</p>
            <p className="backup-state__value">{folderLabel(folder)}</p>
            {folder !== null && (
              <p className="backup-state__meta storage-path">{folder.path}</p>
            )}
          </section>

          <div className="backup-actions">
            <button
              className="backup-button backup-button--primary"
              type="button"
              onClick={onChange}
              disabled={busy}
            >
              更改位置
            </button>
            <button
              className="backup-button backup-button--secondary"
              type="button"
              onClick={onOpen}
              disabled={busy || noFolder}
            >
              打开文件夹
            </button>
          </div>

          {noFolder && <p className="backup-note">{NO_USABLE_FOLDER}</p>}
        </>
      )}

      {access === 'granted' && browser !== null && (
        <>
          <section className="backup-state">
            <p className="backup-state__label">选择文件夹</p>
            <p className="backup-state__value storage-path">{browser.path}</p>
          </section>

          <div className="backup-actions">
            <button
              className="backup-button backup-button--secondary"
              type="button"
              onClick={onUp}
              disabled={busy || browser.parent === null}
            >
              上一级
            </button>
            <button
              className="backup-button backup-button--primary"
              type="button"
              onClick={onChoose}
              disabled={busy}
            >
              选这个文件夹
            </button>
            <button
              className="backup-button backup-button--secondary"
              type="button"
              onClick={onCancelBrowse}
              disabled={busy}
            >
              取消
            </button>
          </div>

          {browser.dirs.length === 0 ? (
            <p className="backup-note">没有子文件夹。</p>
          ) : (
            <ul className="storage-dirs">
              {browser.dirs.map(dir => (
                <li key={dir.path}>
                  <button
                    className="storage-dir"
                    type="button"
                    onClick={() => onEnter(dir.path)}
                    disabled={busy}
                  >
                    <span>{dir.name}</span>
                    <span className="storage-dir__chev" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {!available && (
        <p className="backup-note backup-note--error" role="alert">
          {PLUGIN_MISSING}
        </p>
      )}

      {note !== null && (
        <p className="backup-note" role="status">
          {note}
        </p>
      )}

      {error !== null && (
        <p className="backup-note backup-note--error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export interface StorageScreenProps {
  /** Test seam; the route passes nothing and gets the device facade. */
  folder?: FolderAccess;
}

export default function StorageScreen({ folder = deviceFolder }: StorageScreenProps) {
  const [access, setAccess] = useState<StorageAccessPhase>('checking');
  const [stored, setStored] = useState<StoredFolder | null>(null);
  const [browser, setBrowser] = useState<FolderListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [probe, setProbe] = useState('插件：检查中…');

  useEffect(() => {
    let live = true;
    // Every stage is raced against a deadline. A bridge that never answers must
    // end as a sentence, not as a spinner: the first version of this screen sat
    // on 正在检查权限… forever because one call never settled.
    const step = async <T,>(label: string, work: () => Promise<T>): Promise<T> => {
      if (live) setProbe(`插件：${label}…`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超过 8 秒没有响应`)), 8000);
      });
      try {
        return await Promise.race([work(), deadline]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    (async () => {
      const reachable = await step('查找原生插件', () => folder.available());
      if (!live) return;
      setAvailable(reachable);
      if (!reachable) {
        setProbe('插件：没有找到');
        setAccess('denied');
        return;
      }
      setProbe('插件：已找到，读取权限');

      const state = await step('读取权限', () => folder.getAccess());
      if (!live) return;
      if (!state.granted) {
        setProbe('插件：已找到，未授权');
        setAccess('denied');
        return;
      }

      setAccess('granted');
      const current = await step('读取目录', () => folder.current());
      if (live) setStored(current);
    })().catch(reason => {
      if (!live) return;
      setAccess('denied');
      setError(`读取失败：${reasonText(reason)}`);
    });
    return () => {
      live = false;
    };
  }, [folder]);

  /**
   * The one permission path. requestAccess only resolves after the system page
   * closes; getAccess is read again here rather than trusting the callback, so
   * an OEM that returns early cannot show a granted state that is not real.
   */
  const request = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      let state = await folder.getAccess();
      if (!state.granted) {
        await folder.requestAccess();
        state = await folder.getAccess();
      }
      if (!state.granted) {
        setAccess('denied');
        setNote(ACCESS_STILL_DENIED);
        return;
      }
      setAccess('granted');
      setStored(await folder.current());
    } catch (reason) {
      setError(`打开失败：${reasonText(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  /** Opens the browser at a path; no path starts at the shared-storage root. */
  const browse = async (path?: string) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      setBrowser(await folder.list(path));
    } catch (reason) {
      // A revoked permission is the one failure with its own screen state.
      const state = await folder.getAccess().catch(() => null);
      if (state !== null && !state.granted) {
        setAccess('denied');
        setStored(null);
        setBrowser(null);
        setNote(ACCESS_NEEDED);
        return;
      }
      setError(`打开失败：${reasonText(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const change = () => {
    void browse(stored?.path);
  };

  const up = () => {
    if (browser === null || browser.parent === null) return;
    void browse(browser.parent);
  };

  const enter = (path: string) => {
    void browse(path);
  };

  const choose = async () => {
    if (browser === null || busy) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const chosen = await folder.choose(browser.path);
      if (chosen === null) {
        setNote('没有选到文件夹。');
        return;
      }
      setStored(chosen);
      setBrowser(null);
      setNote('位置已更新。');
    } catch (reason) {
      setError(`选择失败：${reasonText(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const cancelBrowse = () => {
    if (busy) return;
    setBrowser(null);
    setNote(null);
  };

  /** False is a normal answer: the file manager simply is not there. */
  const open = async () => {
    if (busy || stored === null) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      setNote(openFolderNote(await folder.open()));
    } catch (reason) {
      setError(`打开失败：${reasonText(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <StorageView
      access={access}
      folder={stored}
      browser={browser}
      busy={busy}
      note={note}
      error={error}
      available={available}
      probe={probe}
      onRequestAccess={request}
      onChange={change}
      onOpen={open}
      onUp={up}
      onEnter={enter}
      onChoose={choose}
      onCancelBrowse={cancelBrowse}
    />
  );
}