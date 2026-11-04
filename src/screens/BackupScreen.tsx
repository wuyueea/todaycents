import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Db } from '../db/driver';
import type { BackupMeta, ImportFailureCopy } from '../backup/format';
import {
  backupFileMeta,
  backupMetaLine,
  exportToast,
  fileSizeText,
  formatBackupTime,
  importFailureCopy,
  importSummary,
  lastBackupTitle,
  plannedCopyNote,
} from '../backup/format';
import { confirmImport, exportBackup, exportMetaAction, prepareImport } from '../backup/flow';
import type { ExportResult, PreparedImport } from '../backup/flow';
import { countTxnRows, readBackupMeta, recordBackupMeta } from '../backup/meta';
import { cachedBackups, deviceFileWriter } from '../backup/device';
import type { CachedBackup } from '../backup/device';
import { deviceFolder } from '../storage/folder';
import { Toast, useToast } from '../components/Toast';
import { useDialogFocus } from '../components/useDialogFocus';
import { useDb, useQuery } from '../store/useDb';

/**
 * 备份与恢复: one primary action (export) and one secondary action (import).
 *
 * Export writes a folder file when one is available; otherwise it hands a
 * cache file to the system share sheet and asks whether the other app saved
 * it. Only a file that really exists — or a share the owner confirms — updates
 * app_meta, because 上次备份 is a promise, not a button press. The cache list
 * below keeps every unconfirmed share reachable. Import goes through the file
 * picker, validates before anything is written, and opens a confirmation sheet
 * with both row counts. The before-copy and the atomic replace live in flow.ts;
 * this file owns only the UI states.
 *
 * Plugins are never named here. device.ts imports them dynamically, so this
 * screen renders in Node exactly as it does on a phone.
 */
export interface BackupScreenData {
  meta: BackupMeta | null;
  /** Local txn rows, compared with the file's count before confirmation. */
  localRows: number;
}

export async function loadBackupScreenData(db: Db): Promise<BackupScreenData> {
  return { meta: await readBackupMeta(db), localRows: await countTxnRows(db) };
}

/** The three bottom sheets this screen can show. */
type SheetState =
  | { kind: 'confirm'; prepared: PreparedImport }
  | { kind: 'export-confirm'; result: ExportResult }
  | { kind: 'failure'; copy: ImportFailureCopy; fileName: string; fileMeta: string };

export interface ImportConfirmSheetProps {
  fileName: string;
  schemaVersion: number;
  fileRows: number;
  fileBytes: number;
  localRows: number;
  exportedAt: string;
  now: Date;
  /** The folder the before-copy will use; null means the app cache. */
  folderName: string | null;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * The last gate before a destructive import. It states the file rows, the
 * local rows and 会整体替换 in the body, then offers 覆盖并导入 (danger as
 * outline and text only) and 取消.
 */
export function ImportConfirmSheet({
  fileName,
  schemaVersion,
  fileRows,
  fileBytes,
  localRows,
  exportedAt,
  now,
  folderName,
  busy,
  onConfirm,
  onCancel,
}: ImportConfirmSheetProps) {
  const panelRef = useDialogFocus({
    onClose: onCancel,
    initial: 'last',
    canClose: () => !busy,
  });

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-confirm-title"
    >
      <div className="sheet__scrim" aria-hidden="true" onClick={onCancel} />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="import-confirm-title">
            从文件导入
          </h2>
          <span className="sheet__version">版本 {schemaVersion}</span>
        </div>

        <div className="sheet__file">
          <div className="sheet__file-name">{fileName}</div>
          <div className="sheet__file-meta">
            {backupFileMeta(fileRows, fileBytes)} · {formatBackupTime(exportedAt, now)}
          </div>
        </div>

        <p className="sheet__text">{importSummary({ fileRows, localRows })}</p>
        <p className="sheet__note">
          按下按钮之后，会先把现在的账本导出成一份备份，再覆盖。{plannedCopyNote(folderName)}
        </p>

        <button
          className="sheet__danger"
          type="button"
          onClick={onConfirm}
          disabled={busy}
        >
          覆盖并导入
        </button>
        <button
          className="sheet__secondary"
          type="button"
          onClick={onCancel}
          disabled={busy}
        >
          取消
        </button>
      </div>
    </div>
  );
}

export interface ImportFailureSheetProps {
  copy: ImportFailureCopy;
  fileName?: string;
  fileMeta?: string;
  onClose(): void;
}

/**
 * 导入失败: the reason, then the plan's line that the local ledger is
 * untouched. A newer-schema file gets §7's upgrade advice verbatim.
 */
export function ImportFailureSheet({
  copy,
  fileName,
  fileMeta,
  onClose,
}: ImportFailureSheetProps) {
  const panelRef = useDialogFocus({ onClose });

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-failure-title"
    >
      <div className="sheet__scrim" aria-hidden="true" onClick={onClose} />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="import-failure-title">
            {copy.title}
          </h2>
        </div>

        {fileName !== undefined && (
          <div className="sheet__file">
            <div className="sheet__file-name">{fileName}</div>
            {fileMeta !== undefined && <div className="sheet__file-meta">{fileMeta}</div>}
          </div>
        )}

        <p className="sheet__text">{copy.reason}</p>
        <p className="sheet__note">{copy.advice}</p>

        <button className="sheet__secondary" type="button" onClick={onClose}>
          知道了
        </button>
      </div>
    </div>
  );
}

export interface ExportConfirmSheetProps {
  fileName: string;
  bytes: number;
  busy: boolean;
  onSaved(): void;
  onNotSaved(): void;
}

/**
 * The question the share sheet cannot answer. A resolved Share.share means
 * "another app took the file", not "it was saved"; only the owner knows which
 * happened. 没有保存 is the default — closing the sheet records nothing.
 */
export function ExportConfirmSheet({
  fileName,
  bytes,
  busy,
  onSaved,
  onNotSaved,
}: ExportConfirmSheetProps) {
  const panelRef = useDialogFocus({
    onClose: onNotSaved,
    initial: 'last',
    canClose: () => !busy,
  });

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-confirm-title"
    >
      <div
        className="sheet__scrim"
        aria-hidden="true"
        onClick={busy ? undefined : onNotSaved}
      />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="export-confirm-title">
            备份文件已生成
          </h2>
        </div>

        <div className="sheet__file">
          <div className="sheet__file-name">{fileName}</div>
          <div className="sheet__file-meta">{fileSizeText(bytes)}</div>
        </div>

        <p className="sheet__text">文件已经交给系统分享面板。它保存好了吗？</p>
        <p className="sheet__note">
          只有确认保存过，才会更新「上次备份」。没有保存的话，文件还在应用缓存里，可以在下面另存。
        </p>

        <button
          className="sheet__primary"
          type="button"
          onClick={onSaved}
          disabled={busy}
        >
          已保存
        </button>
        <button
          className="sheet__secondary"
          type="button"
          onClick={onNotSaved}
          disabled={busy}
        >
          没有保存
        </button>
      </div>
    </div>
  );
}

export interface CachedBackupListProps {
  files: CachedBackup[];
  now: Date;
  busy: boolean;
  onShare(file: CachedBackup): void;
}

/**
 * The rescue list for shares that were cancelled or never confirmed. These
 * files live in the app cache, which the system may clear at any time, so each
 * row offers the only exit that matters: hand it to the share sheet again.
 */
export function CachedBackupList({
  files,
  now,
  busy,
  onShare,
}: CachedBackupListProps) {
  if (files.length === 0) return null;

  return (
    <section className="backup-cache" aria-labelledby="backup-cache-title">
      <h2 className="backup-cache__title" id="backup-cache-title">
        应用缓存中的备份
      </h2>
      <p className="backup-cache__note">
        这些文件只在应用缓存里，系统可能清理。要留住，请点「另存」；另存只是把文件救出去，不会更新「上次备份」。
      </p>
      <ul className="backup-cache__list">
        {files.map((file) => (
          <li className="backup-cache__row" key={file.uri === '' ? file.name : file.uri}>
            <div className="backup-cache__body">
              <div className="backup-cache__name">{file.name}</div>
              <div className="backup-cache__meta">
                {fileSizeText(file.bytes)} ·{' '}
                {formatBackupTime(new Date(file.modifiedAt).toISOString(), now)}
              </div>
            </div>
            <button
              className="backup-cache__share"
              type="button"
              onClick={() => onShare(file)}
              disabled={busy}
            >
              另存
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function BackupScreen() {
  const { db, bump } = useDb();
  const navigate = useNavigate();
  const query = useQuery<BackupScreenData>(loadBackupScreenData, []);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [cached, setCached] = useState<CachedBackup[]>([]);
  const { toast, showToast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  // The import/reset sheets state where the automatic copy will go before the
  // owner commits. An unavailable folder is not an error; it is the cache path.
  useEffect(() => {
    let alive = true;
    deviceFolder.current().then(
      (folder) => {
        if (alive) setFolderName(folder?.name ?? null);
      },
      () => {
        if (alive) setFolderName(null);
      }
    );
    return () => {
      alive = false;
    };
  }, []);

  // Shares that were cancelled or never confirmed leave a real file in the
  // cache; list them so the owner can still get it out.
  useEffect(() => {
    let alive = true;
    cachedBackups.list().then(
      (files) => {
        if (alive) setCached(files);
      },
      () => {
        if (alive) setCached([]);
      }
    );
    return () => {
      alive = false;
    };
  }, []);

  const refreshCache = () => {
    cachedBackups.list().then(setCached, () => setCached([]));
  };

  const cacheNotice = (prefix: string): string =>
    `${prefix}文件还在应用缓存里，系统可能清理；如果下面列出了它，可以点「另存」。`;

  const data = query.data;
  const now = new Date();
  const lastTitle =
    query.error !== null
      ? '读取失败'
      : data === null
        ? '正在读取…'
        : lastBackupTitle(data.meta, now);
  const metaLine = data?.meta ? backupMetaLine(data.meta) : null;
  const disabled = db === null || busy;

  const handleExport = async () => {
    if (db === null || busy) return;
    setBusy(true);
    setStatus(null);
    setNotice(null);
    try {
      const result = await exportBackup(db, deviceFileWriter, new Date());
      refreshCache();

      const action = exportMetaAction(result.destination);
      if (action === 'none') {
        setNotice(cacheNotice('已取消导出，没有记录这次备份。'));
        return;
      }

      // A share only handed the file to another app. Ask before promising
      // that a backup exists; 没有保存 records nothing.
      if (action === 'ask') {
        setSheet({ kind: 'export-confirm', result });
        return;
      }

      try {
        await recordBackupMeta(db, result.meta);
      } catch (reason) {
        setStatus(
          `文件已生成，但没能记下这次备份：${
            reason instanceof Error ? reason.message : String(reason)
          }`
        );
        return;
      }

      // app_meta changed; refresh the last-backup block without leaving.
      bump();
      showToast(
        exportToast({
          fileName: result.fileName,
          bytes: result.bytes,
          folderName:
            result.destination.kind === 'folder'
              ? result.destination.folderName
              : undefined,
        })
      );
    } catch (reason) {
      setStatus(`导出失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleExportSaved = async () => {
    if (db === null || sheet?.kind !== 'export-confirm' || busy) return;
    const { result } = sheet;
    // Belt and braces: the button is 已保存, but only a share that was really
    // confirmed may become 上次备份.
    if (exportMetaAction(result.destination, true) !== 'record') {
      setSheet(null);
      return;
    }
    setBusy(true);
    try {
      await recordBackupMeta(db, result.meta);
      setSheet(null);
      bump();
      showToast(exportToast({ ...result, recorded: true }));
    } catch (reason) {
      setSheet(null);
      setStatus(
        `文件已生成，但没能记下这次备份：${
          reason instanceof Error ? reason.message : String(reason)
        }`
      );
    } finally {
      setBusy(false);
    }
  };

  const handleExportNotSaved = () => {
    if (busy) return;
    setSheet(null);
    setNotice(cacheNotice('没有记录这次备份。'));
  };

  const handleShareCached = async (file: CachedBackup) => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    setNotice(null);
    try {
      const outcome = await cachedBackups.share(file);
      if (outcome === 'canceled') {
        setNotice('已取消分享，文件还在应用缓存里。');
      } else {
        showToast(`已把「${file.name}」交给分享面板`);
      }
    } catch (reason) {
      setStatus(`分享失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const openPicker = () => {
    if (db === null || busy) return;
    setStatus(null);
    fileInput.current?.click();
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0] ?? null;
    // Clear first, so picking the same file again still fires onChange.
    input.value = '';
    if (file === null || db === null || busy) return;

    setBusy(true);
    setStatus(null);
    try {
      const text = await file.text();
      const prepared = await prepareImport(db, text, file.name, file.size);
      setSheet({ kind: 'confirm', prepared });
    } catch (reason) {
      setSheet({
        kind: 'failure',
        copy: importFailureCopy(reason),
        fileName: file.name,
        fileMeta: fileSizeText(file.size),
      });
    } finally {
      setBusy(false);
    }
  };

  const closeSheet = () => {
    if (busy) return;
    setSheet(null);
  };

  const handleConfirm = async () => {
    if (db === null || sheet?.kind !== 'confirm' || busy) return;
    const { prepared } = sheet;
    setBusy(true);
    try {
      const result = await confirmImport(db, prepared, deviceFileWriter, new Date());
      bump();
      navigate('/settings', {
        replace: true,
        state: {
          imported: {
            fileName: result.fileName,
            rows: result.rows,
            clearedProjectRefs: result.clearedProjectRefs,
            beforeDestination: result.beforeDestination,
          },
        },
      });
    } catch (reason) {
      setSheet({
        kind: 'failure',
        copy: importFailureCopy(reason),
        fileName: prepared.fileName,
        fileMeta: backupFileMeta(prepared.fileRows, prepared.fileBytes),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backup-screen backup-screen--v1">
      <header className="settings-header">
        <Link className="add-back" to="/settings" aria-label="返回设置">
          ‹
        </Link>
        <h1>备份与恢复</h1>
      </header>

      <section className="backup-state">
        <p className="backup-state__label">上次备份</p>
        <p className="backup-state__value">{lastTitle}</p>
        {metaLine !== null && <p className="backup-state__meta">{metaLine}</p>}
      </section>

      <div className="backup-actions">
        <section className="backup-action-card">
          <h2>导出备份</h2>
          <p>生成一份 .ledger 文件，可以保存到本机或分享出去。</p>
          <button
            className="backup-button backup-button--primary"
            type="button"
            onClick={handleExport}
            disabled={disabled}
          >
            导出到文件
          </button>
        </section>

        <section className="backup-action-card">
          <h2>从文件恢复</h2>
          <p>选择备份文件；确认后会整体替换当前账本，导入前会先留一份当前备份。</p>
          <button
            className="backup-button backup-button--secondary"
            type="button"
            onClick={openPicker}
            disabled={disabled}
          >
            从文件导入
          </button>
        </section>
        {/*
          The system picker is the whole import UI. .ledger is not a registered
          MIME type on Android, so application/octet-stream is listed as well;
          without it some file managers grey out the app's own export.
        */}
        <input
          ref={fileInput}
          className="backup-file-input"
          type="file"
          accept=".ledger,.json,text/plain,application/json,application/octet-stream"
          hidden
          aria-label="选择备份文件"
          onChange={handleFile}
        />
      </div>

      {status !== null && (
        <p className="backup-note backup-note--error" role="alert">
          {status}
        </p>
      )}

      {notice !== null && (
        <p className="backup-note" role="status">
          {notice}
        </p>
      )}

      <CachedBackupList
        files={cached}
        now={now}
        busy={busy}
        onShare={handleShareCached}
      />

      {sheet?.kind === 'confirm' && (
        <ImportConfirmSheet
          fileName={sheet.prepared.fileName}
          schemaVersion={sheet.prepared.file.schemaVersion}
          fileRows={sheet.prepared.fileRows}
          fileBytes={sheet.prepared.fileBytes}
          localRows={sheet.prepared.localRows}
          exportedAt={sheet.prepared.exportedAt}
          now={now}
          folderName={folderName}
          busy={busy}
          onConfirm={handleConfirm}
          onCancel={closeSheet}
        />
      )}

      {sheet?.kind === 'export-confirm' && (
        <ExportConfirmSheet
          fileName={sheet.result.fileName}
          bytes={sheet.result.bytes}
          busy={busy}
          onSaved={handleExportSaved}
          onNotSaved={handleExportNotSaved}
        />
      )}

      {sheet?.kind === 'failure' && (
        <ImportFailureSheet
          copy={sheet.copy}
          fileName={sheet.fileName}
          fileMeta={sheet.fileMeta}
          onClose={closeSheet}
        />
      )}

      {toast !== null && <Toast text={toast} />}
    </div>
  );
}