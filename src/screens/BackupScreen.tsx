import { useRef, useState } from 'react';
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
} from '../backup/format';
import { confirmImport, exportBackup, prepareImport } from '../backup/flow';
import type { PreparedImport } from '../backup/flow';
import { countTxnRows, readBackupMeta } from '../backup/meta';
import { deviceFileWriter } from '../backup/device';
import { Toast, useToast } from '../components/Toast';
import { useDialogFocus } from '../components/useDialogFocus';
import { useDb, useQuery } from '../store/useDb';

/**
 * 备份与恢复: one primary action (export) and one secondary action (import).
 *
 * Export writes a cache file and opens the system share sheet; on success it
 * records app_meta and shows a toast, but stays on this screen. Import goes
 * through the file picker, validates before anything is written, and opens a
 * confirmation sheet with both row counts. The before-copy and the atomic
 * replace live in flow.ts; this file owns only the UI states.
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

/** The two bottom sheets this screen can show. */
type SheetState =
  | { kind: 'confirm'; prepared: PreparedImport }
  | { kind: 'failure'; copy: ImportFailureCopy; fileName: string; fileMeta: string };

export interface ImportConfirmSheetProps {
  fileName: string;
  schemaVersion: number;
  fileRows: number;
  fileBytes: number;
  localRows: number;
  exportedAt: string;
  now: Date;
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
          按下按钮之后，会先把现在的账本导出成一份备份，再覆盖。这一份放在「设置 ›
          存储」的位置。
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

export default function BackupScreen() {
  const { db, bump } = useDb();
  const navigate = useNavigate();
  const query = useQuery<BackupScreenData>(loadBackupScreenData, []);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const { toast, showToast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

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
    try {
      const result = await exportBackup(db, deviceFileWriter, new Date());
      showToast(exportToast(result));
      // app_meta changed; refresh the last-backup block without leaving.
      bump();
    } catch (reason) {
      setStatus(`导出失败：${reason instanceof Error ? reason.message : String(reason)}`);
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
        state: { imported: { fileName: result.fileName, rows: result.rows } },
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

      {sheet?.kind === 'confirm' && (
        <ImportConfirmSheet
          fileName={sheet.prepared.fileName}
          schemaVersion={sheet.prepared.file.schemaVersion}
          fileRows={sheet.prepared.fileRows}
          fileBytes={sheet.prepared.fileBytes}
          localRows={sheet.prepared.localRows}
          exportedAt={sheet.prepared.exportedAt}
          now={now}
          busy={busy}
          onConfirm={handleConfirm}
          onCancel={closeSheet}
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