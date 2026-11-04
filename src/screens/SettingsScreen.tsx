import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  importDoneToast,
  plannedCopyNote,
  resetDoneToast,
  resetFailureText,
  resetSummary,
} from '../backup/format';
import type { CopyLocation } from '../backup/format';
import { resetWithBackup } from '../backup/flow';
import { deviceFileWriter } from '../backup/device';
import { deviceFolder } from '../storage/folder';
import { readResetCounts } from '../db/reset';
import type { ResetCounts } from '../db/reset';
import { detectCandidates } from '../db/repos/fixedCosts';
import { Toast, useToast } from '../components/Toast';
import { useDialogFocus } from '../components/useDialogFocus';

import { useDb, useQuery } from '../store/useDb';

/**
 * 设置: the fourth tab, and the home of everything that is not a daily view.
 *
 * 账户 lives here rather than in the tab bar: the four tabs are the things you
 * open every day, while accounts, tags, projects and the rest are things you
 * arrange once in a while. Sub-pages are pushed over it and come back here.
 *
 * No dead links: a row that cannot be tapped would make the screen look
 * broken, so a feature appears here only once it has a page. A row is just the
 * name of the page behind it — the counts and timestamps it used to carry were
 * the first thing an owner stopped reading.
 *
 * 重置 is the last group and holds the one destructive action. It is a button
 * rather than a page: tapping it opens the confirmation sheet in place, so the
 * owner never lands on a second screen that only exists to be cancelled.
 */
/** Reads the before-copy location without trusting the shape of router state. */
function copyLocationFromState(value: unknown): CopyLocation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, folderName } = value as { kind?: unknown; folderName?: unknown };
  if (kind === 'cache') return { kind: 'cache' };
  if (kind === 'none') return { kind: 'none' };
  if (kind === 'folder' && typeof folderName === 'string' && folderName.trim() !== '') {
    return { kind: 'folder', folderName: folderName.trim() };
  }
  return undefined;
}

/** The router state /settings/backup hands over after a successful import. */
export function importNoticeFromState(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const imported = (state as { imported?: unknown }).imported;
  if (typeof imported !== 'object' || imported === null) return null;

  const { fileName, rows, clearedProjectRefs, beforeDestination } = imported as {
    fileName?: unknown;
    rows?: unknown;
    clearedProjectRefs?: unknown;
    beforeDestination?: unknown;
  };
  if (typeof fileName !== 'string' || fileName.trim() === '') return null;
  if (typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 0) return null;

  // Anything but a sane positive count is simply "nothing was repaired".
  const cleared =
    typeof clearedProjectRefs === 'number' &&
    Number.isSafeInteger(clearedProjectRefs) &&
    clearedProjectRefs > 0
      ? clearedProjectRefs
      : 0;

  return importDoneToast({
    fileName,
    rows,
    clearedProjectRefs: cleared,
    beforeDestination: copyLocationFromState(beforeDestination),
  });
}

export interface ResetConfirmSheetProps {
  counts: ResetCounts;
  /** The folder the automatic before-copy will use; null means the app cache. */
  folderName: string | null;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * The second gate before 清除所有数据 — the first one was the tap on the row.
 *
 * It states the real row counts and both promises: the app comes back as a
 * first launch (starter accounts and categories included), and a backup file
 * is written before anything is deleted. The danger action is the only way
 * forward. The scrim cancels, as on every other sheet, and nothing here is a
 * keyboard shortcut or a long press: 取消 sits below, in ink, and the wipe
 * needs this exact button.
 */
export function ResetConfirmSheet({
  counts,
  folderName,
  busy,
  onConfirm,
  onCancel,
}: ResetConfirmSheetProps) {
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
      aria-labelledby="reset-confirm-title"
    >
      <div className="sheet__scrim" aria-hidden="true" onClick={onCancel} />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="reset-confirm-title">
            清除所有数据
          </h2>
        </div>

        <p className="sheet__text">{resetSummary(counts)}</p>
        <p className="sheet__note">
          清除后只留下 3 个账户和 12 个分类，其余记录都不保留，也不能撤销。
        </p>
        <p className="sheet__note">
          按下按钮之后，会先把现在的账本写成一份备份文件，再清除。{plannedCopyNote(folderName)}
        </p>

        <button className="sheet__danger" type="button" onClick={onConfirm} disabled={busy}>
          确认清除
        </button>
        <button className="sheet__secondary" type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </div>
  );
}

/**
 * The 存储 row. It used to state the folder underneath; the page is name-only
 * now like every other row, and the location itself lives one tap away.
 */
export function StorageRow() {
  return (
    <Link className="settings-row" to="/settings/storage">
      <span className="settings-row__title">存储</span>
      <span className="settings-row__chev" aria-hidden="true">
        ›
      </span>
    </Link>
  );
}

export default function SettingsScreen() {
  const location = useLocation();
  const { db, bump } = useDb();
  const notice = importNoticeFromState(location.state);
  const { toast, showToast } = useToast(notice);
  /**
   * Detection runs here rather than only behind 设置 › 固定支出, so opening
   * 设置 is enough to learn that something is waiting. A failure leaves the
   * row plain: a background scan must never turn the settings page into an
   * error screen.
   */
  const pendingFixedCosts = useQuery(
    database => detectCandidates(database).then(candidates => candidates.length),
    []
  );
  const [busy, setBusy] = useState(false);
  const [resetCounts, setResetCounts] = useState<ResetCounts | null>(null);
  const [resetFolderName, setResetFolderName] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  /**
   * Reads the counts first, so the sheet can say what is about to disappear.
   * Nothing is written here; a failure only fills the inline error line.
   */
  const openReset = async () => {
    if (busy) return;
    setResetError(null);
    if (db === null) {
      setResetError('数据层未就绪，暂时不能清除数据。');
      return;
    }
    setBusy(true);
    try {
      const [folder, counts] = await Promise.all([
        deviceFolder.current(),
        readResetCounts(db),
      ]);
      setResetFolderName(folder?.name ?? null);
      setResetCounts(counts);
    } catch (reason) {
      setResetError(resetFailureText(reason));
    } finally {
      setBusy(false);
    }
  };

  const closeReset = () => {
    if (busy) return;
    setResetCounts(null);
    setResetFolderName(null);
  };

  /**
   * The one path forward. resetWithBackup writes the before-copy first, so a
   * rejection here means the ledger was never touched; the toast names the
   * file, the error line names the reason.
   */
  const confirmReset = async () => {
    if (db === null || resetCounts === null || busy) return;
    setBusy(true);
    setResetError(null);
    try {
      const result = await resetWithBackup(db, deviceFileWriter, new Date());
      setResetCounts(null);
      showToast(resetDoneToast(result));
      bump();
    } catch (reason) {
      setResetCounts(null);
      setResetError(resetFailureText(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-screen settings-screen--v1">
      <header className="settings-head">
        <h1>设置</h1>
      </header>

      <section className="settings-group" aria-labelledby="settings-structure">
        <h2 className="settings-group__title" id="settings-structure">
          结构
        </h2>
        <div className="settings-card">
          <Link className="settings-row" to="/accounts">
            <span className="settings-row__title">账户</span>
            <span className="settings-row__chev" aria-hidden="true">
              ›
            </span>
          </Link>
          <Link className="settings-row" to="/settings/categories">
            <span className="settings-row__title">分类</span>
            <span className="settings-row__chev" aria-hidden="true">
              ›
            </span>
          </Link>
          <Link className="settings-row" to="/settings/tags">
            <span className="settings-row__title">标签</span>
            <span className="settings-row__chev" aria-hidden="true">
              ›
            </span>
          </Link>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="settings-ledger">
        <h2 className="settings-group__title" id="settings-ledger">
          账本
        </h2>
        <div className="settings-card">
          <Link className="settings-row" to="/settings/projects">
            <span className="settings-row__title">项目</span>
            <span className="settings-row__chev" aria-hidden="true">
              ›
            </span>
          </Link>
          <Link className="settings-row" to="/settings/fixed">
            <span className="settings-row__title">固定支出</span>
            {pendingFixedCosts.data !== null && pendingFixedCosts.data > 0 && (
              <span className="settings-row__badge">
                {pendingFixedCosts.data} 条待确认
              </span>
            )}
            <span className="settings-row__chev" aria-hidden="true">
              ›
            </span>
          </Link>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="settings-data">
        <h2 className="settings-group__title" id="settings-data">
          数据
        </h2>
        <div className="settings-card">
          <StorageRow />
          <Link className="settings-row" to="/settings/backup">
            <span className="settings-row__title">备份与恢复</span>
            <span className="settings-row__chev" aria-hidden="true">
              ›
            </span>
          </Link>
          {/*
            Danger as text only, no red fill: the row reads like every other
            row until the sheet asks a second time.
          */}
          <button
            className="settings-row settings-row--danger"
            type="button"
            onClick={openReset}
            disabled={busy}
          >
            <span className="settings-row__title">清除所有数据</span>
          </button>
        </div>
      </section>

      {resetError !== null && (
        <p className="settings-note settings-note--error" role="alert">
          {resetError}
        </p>
      )}

      {resetCounts !== null && (
        <ResetConfirmSheet
          counts={resetCounts}
          folderName={resetFolderName}
          busy={busy}
          onConfirm={confirmReset}
          onCancel={closeReset}
        />
      )}

      {toast !== null && <Toast text={toast} />}
    </div>
  );
}