import type { PurgeUndoRecord } from '../db/repos/purge';
import { Toast } from './Toast';

export interface PurgeUndoToastProps {
  undo: PurgeUndoRecord;
  onUndo(): void;
  /** Positioning override; the global copy sits above the tab dock. */
  className?: string;
}

/**
 * The ten-second escape hatch for a physical purge.
 *
 * A purge removes the row, so this is the only way back. It says which kind of
 * object disappeared because categories and tags share one bar, and it never
 * implies that 恢复 brings back links: undo restores the object in 已归档.
 */
export function PurgeUndoToast({ undo, onUndo, className }: PurgeUndoToastProps) {
  const text =
    undo.kind === 'category'
      ? `「${undo.label}」已彻底删除 · 10 秒内可撤销`
      : `标签「${undo.label}」已彻底删除 · 10 秒内可撤销`;
  return <Toast text={text} actionLabel="撤销" onAction={onUndo} className={className} />;
}

/** A record identity stable across renders, kinds and reloads. */
export function purgeUndoKey(undo: PurgeUndoRecord): string {
  return `${undo.kind}\u0000${undo.targetId}\u0000${undo.expiresAt}`;
}

/**
 * Pick the bar to show. A just-finished purge is fresher than the query
 * snapshot, so pending wins; both are still checked against the clock because
 * the stored result can predate the ten-second boundary. A dismissed key
 * suppresses only the record it belongs to.
 */
export function selectPurgeUndo(
  pending: PurgeUndoRecord | null,
  stored: PurgeUndoRecord | null,
  dismissedKey: string | null,
  now = Date.now()
): PurgeUndoRecord | null {
  const record = pending ?? stored;
  if (record === null || record.expiresAt <= now) return null;
  return dismissedKey === purgeUndoKey(record) ? null : record;
}
