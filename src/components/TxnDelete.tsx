import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import type { ReactNode } from 'react';
import type { Db } from '../db/driver';
import type { TxnRow } from '../db/repos/txns';
import { softDeleteTxn } from '../db/repos/txns';
import { deleteTransfer } from '../db/repos/transfers';
import { formatCentsDisplay } from './AmountText';
import { registerBackHandler } from './backButton';
import { Sheet } from './Sheet';
import { Toast } from './Toast';
import { useTxnDeleteGesture } from './useTxnDeleteGesture';

const UNDO_MS = 10_000;

type DeleteTarget =
  | { kind: 'txn'; id: string }
  | { kind: 'transfer'; id: string };

interface DeleteAction {
  target: DeleteTarget;
  trigger: HTMLButtonElement | null;
}

interface PendingDelete extends DeleteAction {
  routeKey: string;
  timer: number;
  committing: boolean;
}

function targetKey(target: DeleteTarget) {
  return `${target.kind}:${target.id}`;
}

function targetName(target: DeleteTarget) {
  return target.kind === 'transfer' ? '这笔转账' : '这笔流水';
}

interface DeleteContextValue {
  hidden: ReadonlySet<string>;
  available: boolean;
  confirm(action: DeleteAction): void;
}

const DeleteContext = createContext<DeleteContextValue | null>(null);

export function TxnDeleteRow({
  row, label, children,
}: {
  row: Pick<TxnRow, 'id' | 'direction' | 'amountCents' | 'transferGroupId'>;
  label: string;
  children: ReactNode;
}) {
  const deletion = useContext(DeleteContext);
  const target: DeleteTarget | null = row.direction !== 'transfer'
    ? { kind: 'txn', id: row.id }
    : row.transferGroupId ? { kind: 'transfer', id: row.transferGroupId } : null;
  if (deletion === null || target === null) {
    return <li>{children}</li>;
  }

  const description = `${label} · ${formatCentsDisplay(row.amountCents)}`;
  return (
    <li
      className="txn-delete-row"
      hidden={deletion.hidden.has(targetKey(target))}
      data-txn-delete-row={deletion.available ? description : undefined}
      data-txn-delete-id={row.id}
      data-transfer-group={target.kind === 'transfer' ? target.id : undefined}
    >
      {children}
      <button
        className="txn-delete-action"
        type="button"
        data-txn-delete-action
        aria-label={`删除${target.kind === 'transfer' ? '转账' : '流水'}，${description}`}
        aria-haspopup="dialog"
        aria-disabled={deletion.available ? undefined : true}
        onClick={event => {
          if (deletion.available) deletion.confirm({ target, trigger: event.currentTarget });
        }}
      >
        <span aria-hidden="true">···</span>
      </button>
    </li>
  );
}

export function TxnDeleteProvider({
  db, bump, routeKey, onListPage, dock, stacked, children,
}: {
  db: Db | null;
  bump(): void;
  routeKey: string;
  onListPage: boolean;
  dock: boolean;
  stacked: boolean;
  children: ReactNode;
}) {
  const active = useRef<PendingDelete | null>(null);
  const currentRoute = useRef(routeKey);
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const [committed, setCommitted] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmation, setConfirmation] = useState<DeleteAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);

  const cancel = useCallback((restoreFocus = false) => {
    const request = active.current;
    if (request === null || request.committing) return false;
    window.clearTimeout(request.timer);
    active.current = null;
    setPending(null);
    if (restoreFocus && request.trigger !== null) {
      const trigger = request.trigger;
      window.requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
    }
    return true;
  }, []);

  useLayoutEffect(() => {
    currentRoute.current = routeKey;
    cancel();
    setConfirmation(null);
    setCommitted(new Set());
    setError(null);
    setToast(null);
  }, [routeKey, cancel]);

  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const cancelWhenHidden = () => {
      if (document.visibilityState === 'hidden') cancel();
    };
    document.addEventListener('visibilitychange', cancelWhenHidden);
    return () => {
      document.removeEventListener('visibilitychange', cancelWhenHidden);
      if (active.current !== null) window.clearTimeout(active.current.timer);
    };
  }, [cancel]);

  useEffect(() => {
    if (pending === null || pending.committing) return;
    if (pending.trigger !== null) undoButton.current?.focus({ preventScroll: true });
    const undo = () => cancel(true);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && undo()) event.preventDefault();
    };
    document.addEventListener('keydown', escape);
    const unsubscribe = registerBackHandler(undo);
    return () => {
      document.removeEventListener('keydown', escape);
      unsubscribe();
    };
  }, [pending, cancel]);

  const stage = useCallback((action: DeleteAction) => {
    if (db === null || active.current !== null || document.visibilityState !== 'visible') return;
    const database = db;
    const request: PendingDelete = {
      ...action,
      routeKey,
      committing: false,
      timer: window.setTimeout(() => { void commit(); }, UNDO_MS),
    };
    active.current = request;
    setConfirmation(null);
    setError(null);
    setToast(null);
    setPending(request);

    async function commit() {
      if (active.current !== request) return;
      if (currentRoute.current !== routeKey || document.visibilityState !== 'visible') {
        cancel();
        return;
      }
      request.committing = true;
      setPending({ ...request });
      try {
        const { target } = request;
        if (target.kind === 'transfer') await deleteTransfer(database, target.id);
        else await softDeleteTxn(database, target.id);
        if (currentRoute.current === routeKey) {
          // Queries may still show the old snapshot while bump() reloads them.
          setCommitted(keys => new Set(keys).add(targetKey(target)));
          setToast(`已删除${targetName(target)}`);
        }
        bump();
      } catch (reason) {
        if (currentRoute.current === routeKey) {
          setError(`删除失败：${reason instanceof Error ? reason.message : String(reason)}`);
        }
      } finally {
        active.current = null;
        setPending(null);
      }
    }
  }, [db, bump, routeKey, cancel]);

  const onDrop = useCallback((row: HTMLElement) => {
    const id = row.dataset.txnDeleteId;
    const group = row.dataset.transferGroup;
    if (id) stage({ target: group ? { kind: 'transfer', id: group } : { kind: 'txn', id }, trigger: null });
  }, [stage]);
  const { drag, zoneRef } = useTxnDeleteGesture(db !== null && onListPage, routeKey, onDrop);

  const value = useMemo<DeleteContextValue>(() => {
    const hidden = new Set(committed);
    if (pending !== null) hidden.add(targetKey(pending.target));
    return {
      hidden,
      available: db !== null && pending === null && confirmation === null,
      confirm: setConfirmation,
    };
  }, [committed, db, pending, confirmation]);
  const feedback = dock ? 'toast--above-dock' : '';
  const feedbackClass = stacked && dock ? `${feedback} txn-delete-feedback--stacked` : feedback;

  return (
    <DeleteContext.Provider value={value}>
      {children}
      {drag !== null && (
        <div className="txn-drop-layer" aria-hidden="true">
          <div className="txn-drop-glow" data-over={drag.over} />
          <div className="txn-drop-zone" ref={zoneRef} data-over={drag.over}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4.5 6.5h15m-12.5 0 1 13h8l1-13M9.5 6.5v-3h5v3M10.5 10v6m3-6v6" />
            </svg>
            <span>{drag.over ? '松手，移到垃圾桶' : '拖到这里删除'}</span>
            {drag.transfer && <small>转出和转入会一起删除</small>}
          </div>
          <div className="txn-drag-chip" style={{ left: drag.point.x, top: drag.point.y }}>
            {drag.description}
          </div>
        </div>
      )}
      {confirmation !== null && (
        <Sheet
          className="txn-delete-confirmation"
          titleId="txn-delete-confirmation"
          title={`删除${targetName(confirmation.target)}`}
          onClose={() => setConfirmation(null)}
          initialFocus="last"
        >
          <p className="sheet__text">
            {confirmation.target.kind === 'transfer' ? '转出和转入会一起删除。' : ''}
            移到垃圾桶后有 10 秒可以撤销，写入删除后不可撤销。
          </p>
          <button className="sheet__danger" type="button" onClick={() => stage(confirmation)}>
            移到垃圾桶
          </button>
          <button className="sheet__secondary" type="button" onClick={() => setConfirmation(null)}>
            取消
          </button>
        </Sheet>
      )}
      {pending !== null && (
        <div className={`toast toast--action txn-delete-feedback ${feedbackClass}`} role="status">
          <span className="toast__text">
            {pending.committing ? '正在写入删除…' : `已移走${targetName(pending.target)} · 10 秒内可撤销`}
          </span>
          {!pending.committing && (
            <button ref={undoButton} className="toast__action" type="button" onClick={() => cancel(true)}>
              撤销
            </button>
          )}
        </div>
      )}
      {error !== null && <div className={`toast ${feedbackClass}`} role="alert">{error}</div>}
      {toast !== null && <Toast text={toast} className={feedbackClass} />}
    </DeleteContext.Provider>
  );
}
