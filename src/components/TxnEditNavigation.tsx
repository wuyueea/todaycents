import { useLayoutEffect, useRef } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { Location } from 'react-router-dom';
import { assertDateISO, isMonthKey } from '../domain/date';
import type { Direction } from '../domain/types';

export interface TxnEditOrigin {
  locationKey: string;
  pathname: string;
  search: string;
  hash: string;
  monthKey?: string;
  calendarDay?: string;
  txnId: string;
  rowTop: number;
  scrollY: number;
}

export function projectTransactionsParent(path: string): string | null {
  return path.match(/^(\/settings\/projects\/[^/?#]+)\/transactions\/?$/)?.[1] ?? null;
}

export function readTxnEditOrigin(state: unknown): TxnEditOrigin | null {
  const origin = (state as { txnEditOrigin?: Partial<TxnEditOrigin> } | null)?.txnEditOrigin;
  if (!origin || typeof origin.pathname !== 'string') return null;
  const ledger = /^\/ledger\/?$/.test(origin.pathname);
  const project = /^\/settings\/projects\/[^/?#]+\/?$/.test(origin.pathname);
  if (origin.pathname !== '/' && !ledger && !project && projectTransactionsParent(origin.pathname) === null) return null;
  if (ledger && (typeof origin.monthKey !== 'string' || !isMonthKey(origin.monthKey))) return null;
  if (ledger && origin.calendarDay !== undefined) {
    if (typeof origin.calendarDay !== 'string' || origin.calendarDay.slice(0, 7) !== origin.monthKey) return null;
    try {
      assertDateISO(origin.calendarDay);
    } catch {
      return null;
    }
  }
  if (typeof origin.locationKey !== 'string' || typeof origin.txnId !== 'string' ||
      typeof origin.search !== 'string' || typeof origin.hash !== 'string' ||
      !Number.isFinite(origin.rowTop) || !Number.isFinite(origin.scrollY)) return null;
  return origin as TxnEditOrigin;
}

export function isPlainLinkClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return !event.defaultPrevented && event.button === 0 &&
    !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function TxnEditLink({ txnId, direction, monthKey, calendarDay, className, children }: {
  txnId: string;
  direction?: Direction;
  monthKey?: string;
  calendarDay?: string;
  className: string;
  children: ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const to = `/txn/${encodeURIComponent(txnId)}`;

  return (
    <Link
      className={className}
      to={to}
      data-txn-id={txnId}
      data-direction={direction}
      onClick={event => {
        if (!isPlainLinkClick(event)) return;
        event.preventDefault();
        const origin: TxnEditOrigin = {
          locationKey: location.key,
          pathname: location.pathname,
          search: location.search,
          hash: location.hash,
          monthKey,
          calendarDay,
          txnId,
          rowTop: event.currentTarget.getBoundingClientRect().top,
          scrollY: window.scrollY,
        };
        navigate(to, { state: { txnEditOrigin: origin } });
      }}
    >
      {children}
    </Link>
  );
}

/** Carry the outgoing editor's snapshot only to the exact source history entry. */
export function useTxnEditReturn(location: Location): TxnEditOrigin | null {
  const previous = useRef({ location, origin: null as TxnEditOrigin | null });
  const last = previous.current;
  let origin = last.origin;
  if (last.location.key !== location.key) {
    const fromEditor = /^\/txn\/[^/]+\/?$/.test(last.location.pathname);
    const source = fromEditor ? readTxnEditOrigin(last.location.state) : null;
    origin = source?.locationKey === location.key && source.pathname === location.pathname ? source : null;
  }

  useLayoutEffect(() => {
    previous.current = { location, origin };
  }, [location, origin]);
  return origin;
}

export function useRestoreTxnEditScroll(origin: TxnEditOrigin | null, ready: boolean): void {
  const restored = useRef<TxnEditOrigin | null>(null);
  useLayoutEffect(() => {
    if (origin === null || !ready || restored.current === origin) return;
    restored.current = origin;
    const row = document.querySelector<HTMLAnchorElement>(`a[data-txn-id="${CSS.escape(origin.txnId)}"]`);
    const top = row === null
      ? origin.scrollY
      : window.scrollY + row.getBoundingClientRect().top - origin.rowTop;
    window.scrollTo({ top: Math.max(0, top) });
    row?.focus({ preventScroll: true });
  }, [origin, ready]);
}
