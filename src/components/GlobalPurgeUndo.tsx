import { useEffect, useState } from 'react';
import type { PurgeUndoRecord } from '../db/repos/purge';
import { readPurgeUndo, undoPurge } from '../db/repos/purge';
import { useDb, useQuery } from '../store/useDb';
import { PurgeUndoToast, purgeUndoKey, selectPurgeUndo } from './PurgeUndoToast';
import { Toast, useToast } from './Toast';

/**
 * The purge's ten-second undo on the four dock tabs.
 *
 * A purge writes purge_undo in the same transaction as the delete. If the
 * process is killed before the management page can show its local bar, the
 * default 今天 tab would otherwise lose the only way to restore the row. This
 * component mounts in App on the four dock tabs.
 *
 * It is absent on pushed pages and 随手记, which own the bottom of their screen.
 * The management pages render their own local copy for their kind; when the
 * owner returns to a tab, this component remounts and reads the row again.
 *
 * App uses onActiveChange to lift "an undo bar is on screen" into the shell,
 * so the exit warning can stack above that bar instead of covering 撤销.
 */
interface GlobalPurgeUndoProps {
  onActiveChange?: (active: boolean) => void;
}

export default function GlobalPurgeUndo({ onActiveChange }: GlobalPurgeUndoProps) {
  const { db, bump } = useDb();
  const query = useQuery<PurgeUndoRecord | null>(readPurgeUndo, []);
  const { toast, showToast, clearToast } = useToast();
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const active = selectPurgeUndo(null, query.data, dismissedKey);

  useEffect(() => {
    onActiveChange?.(active !== null);
  }, [active, onActiveChange]);

  // Unmounting (a pushed page) hides the bar without changing active.
  useEffect(
    () => () => {
      onActiveChange?.(false);
    },
    [onActiveChange]
  );

  useEffect(() => {
    if (active === null) return;
    const key = purgeUndoKey(active);
    const remaining = Math.max(0, active.expiresAt - Date.now());
    const timer = window.setTimeout(() => setDismissedKey(key), remaining);
    return () => window.clearTimeout(timer);
  }, [active]);

  const handleUndo = async () => {
    if (db === null || active === null || busy) return;
    const target = active;
    const key = purgeUndoKey(target);

    if (Date.now() >= target.expiresAt) {
      setDismissedKey(key);
      showToast('撤销窗口已过');
      return;
    }

    setBusy(true);
    clearToast();
    try {
      const result = await undoPurge(db, {
        kind: target.kind,
        targetId: target.targetId,
        expiresAt: target.expiresAt,
      });
      setDismissedKey(key);
      bump();
      showToast(
        result.kind === 'category'
          ? `已恢复分类「${result.label}」，它回到「已归档」。`
          : `已恢复标签「${result.label}」，它回到「已归档」。`
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message === '撤销窗口已过') {
        setDismissedKey(key);
        showToast('撤销窗口已过');
      } else {
        showToast(`撤销失败：${message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {active !== null && (
        <PurgeUndoToast undo={active} onUndo={handleUndo} className="toast--above-dock" />
      )}
      {toast !== null && (
        <Toast
          text={toast}
          className={active !== null ? 'toast--above-dock-stacked' : 'toast--above-dock'}
        />
      )}
    </>
  );
}
