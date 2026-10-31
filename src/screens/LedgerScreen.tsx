import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AmountText, formatCentsDisplay } from '../components/AmountText';
import { ProjectMark, UncategorisedLabel, isUncategorised } from '../components/TxnMarks';
import { countMovements, orderTransferLegs } from '../components/txnOrder';
import { useDb, useQuery } from '../store/useDb';
import { deleteTransfer } from '../db/repos/transfers';
import { listTxnsByMonth, monthSummary } from '../db/repos/txns';
import type { TxnRow } from '../db/repos/txns';
import type { Db } from '../db/driver';
import {
  formatMonthDay,
  formatMonthLabel,
  monthKeyOf,
  shiftMonthKey,
  todayLocalISO,
} from '../domain/date';

/**
 * 流水: the month's rows as one card per day, with a day-bar navigation strip.
 *
 * The list is listTxnsByMonth — live rows of the selected month, newest day
 * first — and the hero's numbers are monthSummary, computed from exactly the
 * same rows and joins. The month is state, not today: a finished month stays
 * readable. A soft-deleted row therefore leaves both the list and the totals in
 * the same refetch, and nothing on this screen sums money itself except the day
 * totals and the bars, which use the same direction rules.
 *
 * A transfer arrives as two legs, one negative and one positive. The display
 * keeps the pair together with the out leg first, and neither leg may be
 * edited or deleted on its own: the only action deletes the whole group, with
 * an inline second tap. Adjustments are readable and editable but count in
 * neither 出 nor 入.
 */

/** Everything the ledger renders from, loaded as one snapshot. */
export interface LedgerData {
  /** The month these rows and totals describe (YYYY-MM). */
  monthKey: string;
  /** Live rows of the month, repository order (newest day first). */
  rows: TxnRow[];
  /** Spending in positive integer cents, from monthSummary. */
  expenseCents: number;
  /** Earning in positive integer cents, from monthSummary. */
  incomeCents: number;
}

/** One date card: its rows and that day's own 出/入 totals. */
export interface LedgerDayGroup {
  date: string;
  rows: TxnRow[];
  /** Positive integer cents; only this day's expense rows. */
  expenseCents: number;
  /** Positive integer cents; only this day's income rows. */
  incomeCents: number;
}

/**
 * Groups the month's rows by day, newest day first.
 *
 * listTxnsByMonth already sorts by date, but this helper sorts a copy so a
 * hand-built list cannot render out of order. Array.prototype.sort is stable,
 * so rows inside one day keep the repository's created_at order. Soft-deleted
 * rows are ignored entirely, because the day totals must reconcile with
 * monthSummary even if a caller hands over a row the repository would hide.
 *
 * Day totals use the same rules as monthSummary: an expense contributes its
 * magnitude and an income its amount; transfers and adjustments contribute
 * nothing. No arithmetic here involves floating point.
 */
export function groupTxnsByDate(rows: readonly TxnRow[]): LedgerDayGroup[] {
  const sorted = [...rows].sort((a, b) => {
    if (a.occurredDate < b.occurredDate) return 1;
    if (a.occurredDate > b.occurredDate) return -1;
    return 0;
  });

  const groups: LedgerDayGroup[] = [];
  for (const row of sorted) {
    if (row.deletedAt !== null) continue;

    const current = groups[groups.length - 1];
    if (current !== undefined && current.date === row.occurredDate) {
      current.rows.push(row);
    } else {
      groups.push({
        date: row.occurredDate,
        rows: [row],
        expenseCents: 0,
        incomeCents: 0,
      });
    }

    const group = groups[groups.length - 1]!;
    if (row.direction === 'expense') {
      group.expenseCents += -row.amountCents;
    } else if (row.direction === 'income') {
      group.incomeCents += row.amountCents;
    }
  }
  return groups;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** Calendar-day arithmetic on the date string, free of local time zones. */
function utcDayMillis(dateISO: string): number {
  const [year, month, day] = dateISO.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function previousDayISO(dateISO: string): string {
  const previous = new Date(utcDayMillis(dateISO) - 86_400_000);
  const year = previous.getUTCFullYear();
  const month = String(previous.getUTCMonth() + 1).padStart(2, '0');
  const day = String(previous.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * A card heading: "10月21日 今天", "10月20日 昨天", otherwise the weekday.
 *
 * Only today and yesterday get a relative word; every other day is named by
 * its weekday, so a long month does not turn into a wall of numbers. The
 * comparison is calendar arithmetic, not elapsed hours, and works across a
 * month or year boundary.
 */
export function ledgerDayLabel(dateISO: string, todayISO: string): string {
  const day = formatMonthDay(dateISO);
  if (dateISO === todayISO) return `${day} 今天`;
  if (dateISO === previousDayISO(todayISO)) return `${day} 昨天`;
  const weekday = WEEKDAYS[new Date(utcDayMillis(dateISO)).getUTCDay()];
  return `${day} ${weekday}`;
}

/** One bar in the month strip: every calendar day, not only days with rows. */
export interface LedgerDayBar {
  date: string;
  /** Day of month, 1-based. */
  day: number;
  /** Positive integer cents spent that day; 0 when none. */
  expenseCents: number;
  /** True for a day after today; drawn blank and not clickable. */
  isFuture: boolean;
  /** True for the local today. */
  isToday: boolean;
  /** True when the day carries any live row (including transfers). */
  hasRows: boolean;
}

/**
 * Builds the month's day bars from the same rows the list uses.
 *
 * Every calendar day gets a bar, including zero days and future days. Only
 * expense rows contribute height; income, transfers and adjustments do not.
 * Future days are marked so they can be drawn blank, and hasRows keeps a
 * zero-expense day with a transfer clickable.
 */
export function dailyExpenseBars(
  rows: readonly TxnRow[],
  monthKey: string,
  todayISO: string
): LedgerDayBar[] {
  const [year, month] = monthKey.split('-').map(Number);
  const days = new Date(year, month, 0).getDate();
  const expenseByDay = new Map<string, number>();
  const busyDays = new Set<string>();

  for (const row of rows) {
    if (row.deletedAt !== null) continue;
    busyDays.add(row.occurredDate);
    if (row.direction === 'expense') {
      expenseByDay.set(
        row.occurredDate,
        (expenseByDay.get(row.occurredDate) ?? 0) - row.amountCents
      );
    }
  }

  const bars: LedgerDayBar[] = [];
  for (let day = 1; day <= days; day += 1) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    bars.push({
      date,
      day,
      expenseCents: expenseByDay.get(date) ?? 0,
      isFuture: date > todayISO,
      isToday: date === todayISO,
      hasRows: busyDays.has(date),
    });
  }
  return bars;
}

/** A bar's height in px: square-root scale, with a 2px floor. */
export function barHeightPx(cents: number, maxCents: number): number {
  if (cents <= 0) return 2;
  return Math.max(2, Math.round(Math.sqrt(cents / Math.max(1, maxCents)) * 74));
}

/**
 * The screen's one query. Both halves take the same month key, so the hero can
 * never describe a different set of rows than the cards below it.
 */
export async function loadLedgerData(db: Db, monthKey: string): Promise<LedgerData> {
  const rows = await listTxnsByMonth(db, monthKey);
  const summary = await monthSummary(db, monthKey);
  return {
    monthKey,
    rows,
    expenseCents: summary.expenseCents,
    incomeCents: summary.incomeCents,
  };
}

/**
 * Deletes the whole transfer that this row belongs to.
 *
 * The only transfer mutation the ledger offers. It never reaches softDeleteTxn
 * and refuses a non-transfer row or a legacy leg with no group id, so a single
 * side of a matched pair can never be deleted. Returns whether a group was
 * actually deleted.
 */
export async function deleteTransferFromLedger(
  db: Db,
  row: Pick<TxnRow, 'direction' | 'transferGroupId'>
): Promise<boolean> {
  if (row.direction !== 'transfer' || row.transferGroupId === null) return false;
  await deleteTransfer(db, row.transferGroupId);
  return true;
}

/** A row's rounded mark: a category initial or a kind glyph. */
function ledgerGlyph(row: TxnRow): string {
  if (row.direction === 'transfer') return '⇄';
  if (row.direction === 'adjust') return '≈';
  return (row.categoryName ?? '未').slice(0, 1);
}

/** The amount's neighbour: a category, or the row's real kind. */
function ledgerLabel(row: TxnRow): string {
  if (row.direction === 'transfer') return '转账';
  if (row.direction === 'adjust') return '调整';
  return row.categoryName ?? '未分类';
}

/**
 * One row of a day card.
 *
 * A transfer is a plain div rather than a Link: there is no edit screen for a
 * single leg. Its one action deletes the whole group, and the first tap only
 * opens an inline confirmation — no window.confirm and no undo. The in leg
 * carries no action, so the pair has exactly one delete entry.
 */
function LedgerRowView({
  row,
  deleting,
  confirming,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  row: TxnRow;
  deleting: boolean;
  confirming: boolean;
  onAskDelete: (row: TxnRow) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (row: TxnRow) => void;
}) {
  const isTransfer = row.direction === 'transfer';
  const canDelete =
    isTransfer && row.transferGroupId !== null && row.amountCents < 0;

  const meta = isTransfer
    ? `${row.amountCents < 0 ? '转出' : '转入'} · ${row.accountName}${
        row.note !== '' ? ` · ${row.note}` : ''
      }`
    : row.direction === 'adjust'
      ? `${row.accountName} · 不算支出也不算收入`
      : null;

  const body = (
    <>
      <span
        className={
          isTransfer ? 'ledger-row__dot ledger-row__dot--outline' : 'ledger-row__dot'
        }
        aria-hidden="true"
      >
        {ledgerGlyph(row)}
      </span>
      <span className="ledger-row__body">
        <span className="ledger-row__head">
          <span className="ledger-row__category">
            {isUncategorised(row) ? <UncategorisedLabel /> : ledgerLabel(row)}
          </span>
        </span>
        <span className="ledger-row__meta">
          {meta !== null ? (
            meta
          ) : (
            <>
              {row.note !== '' && <span className="ledger-row__note">{row.note}</span>}
              <span className="ledger-row__account">{row.accountName}</span>
              <ProjectMark row={row} />
            </>
          )}
        </span>
      </span>
      <AmountText cents={row.amountCents} direction={row.direction} />
      {canDelete && (
        <span className="ledger-row__act">
          {confirming ? (
            <>
              <span className="ledger-row__warn">两条一起删，删了不能撤销</span>
              <span className="ledger-row__confirm">
                <button
                  className="ledger-row__delete"
                  type="button"
                  disabled={deleting}
                  onClick={() => onConfirmDelete(row)}
                >
                  {deleting ? '正在删除…' : '删除'}
                </button>
                <button
                  className="ledger-row__delete ledger-row__delete--cancel"
                  type="button"
                  disabled={deleting}
                  onClick={onCancelDelete}
                >
                  算了
                </button>
              </span>
            </>
          ) : (
            <button
              className="ledger-row__delete"
              type="button"
              disabled={deleting}
              onClick={() => onAskDelete(row)}
            >
              删除这笔转账
            </button>
          )}
        </span>
      )}
    </>
  );

  if (isTransfer) {
    return (
      <div
        className="ledger-row ledger-row--readonly"
        data-txn-id={row.id}
        data-direction={row.direction}
      >
        {body}
      </div>
    );
  }

  return (
    <Link
      className="ledger-row"
      to={`/txn/${encodeURIComponent(row.id)}`}
      data-txn-id={row.id}
      data-direction={row.direction}
    >
      {body}
    </Link>
  );
}

/** The month's day bars, as a strip above the cards. */
function LedgerBars({
  bars,
  onJump,
}: {
  bars: readonly LedgerDayBar[];
  onJump: (date: string) => void;
}) {
  const maxCents = bars.reduce(
    (max, bar) => (bar.isFuture ? max : Math.max(max, bar.expenseCents)),
    0
  );

  return (
    <div className="ledger-bars">
      <div className="ledger-bars__plot">
        {bars.map(bar => {
          const height = bar.isFuture ? 2 : barHeightPx(bar.expenseCents, maxCents);
          return (
            <button
              key={bar.date}
              type="button"
              className={[
                'ledger-bars__bar',
                bar.expenseCents > 0 ? 'is-spent' : '',
                bar.isToday ? 'is-today' : '',
                bar.isFuture ? 'is-future' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-bar-date={bar.date}
              aria-label={
                bar.expenseCents > 0
                  ? `${formatMonthDay(bar.date)} 出 ${formatCentsDisplay(bar.expenseCents)}`
                  : `${formatMonthDay(bar.date)} 无支出`
              }
              disabled={bar.isFuture || !bar.hasRows}
              onClick={() => onJump(bar.date)}
            >
              <span
                className="ledger-bars__fill"
                style={{ height: `${height}px` }}
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>
      <div className="ledger-bars__axis" aria-hidden="true">
        <span>1</span>
        <span>每天支出，点柱跳到当天</span>
        <span>{bars.length}</span>
      </div>
    </div>
  );
}

export default function LedgerScreen() {
  const { db, bump } = useDb();
  const today = todayLocalISO();
  const currentMonthKey = monthKeyOf(today);
  const [monthKey, setMonthKey] = useState(currentMonthKey);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmGroupId, setConfirmGroupId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null
  );
  const query = useQuery<LedgerData>(
    database => loadLedgerData(database, monthKey),
    [monthKey]
  );

  // useQuery keeps the previous snapshot while the next month loads. Showing it
  // under the new month's heading would pair one month's label with another
  // month's numbers, so a snapshot from a different month is treated as absent.
  const data = query.data?.monthKey === monthKey ? query.data : null;
  const groups = data === null ? [] : groupTxnsByDate(data.rows);
  const bars = dailyExpenseBars(data?.rows ?? [], monthKey, today);
  const atCurrentMonth = monthKey >= currentMonthKey;
  const previousMonth = shiftMonthKey(monthKey, -1);
  const nextMonth = shiftMonthKey(monthKey, 1);

  useEffect(() => {
    window.scrollTo({ top: 0 });
    setConfirmGroupId(null);
    setStatus(null);
  }, [monthKey]);

  useEffect(() => {
    if (status?.kind !== 'success') return;
    const timer = window.setTimeout(() => setStatus(null), 2600);
    return () => window.clearTimeout(timer);
  }, [status]);

  const jumpToDay = (date: string) => {
    const target = document.getElementById(`ledger-day-${date}`);
    if (target === null) return;
    // Keep the day header below the translucent status bar, not under it.
    // scrollIntoView aligns to the viewport top, which the edge-to-edge WebView
    // shares with the status bar, so both the inset and a small gap are removed.
    const veil = document.querySelector('.status-veil');
    const inset = veil === null ? 0 : veil.getBoundingClientRect().height;
    const top =
      target.getBoundingClientRect().top + window.scrollY - inset - 8;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  };

  /** The first tap only opens the confirmation; the second deletes the pair. */
  const handleDeleteTransfer = async (row: TxnRow) => {
    if (db === null || row.transferGroupId === null) return;

    setDeletingId(row.id);
    setStatus(null);
    try {
      await deleteTransferFromLedger(db, row);
      setConfirmGroupId(null);
      setStatus({ kind: 'success', text: '已删除这笔转账' });
      bump();
    } catch (reason) {
      setStatus({
        kind: 'error',
        text: `删除转账失败：${reason instanceof Error ? reason.message : String(reason)}`,
      });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="ledger-screen">
      <header className="ledger-hero">
        <div className="ledger-month">
          <div>
            <p className="ledger-month__eyebrow">流水</p>
            <h1 className="ledger-month__title">{formatMonthLabel(monthKey)}</h1>
          </div>
          {data !== null && (
            <span className="ledger-month__count">{countMovements(data.rows)} 笔</span>
          )}
        </div>

        {data !== null && (
          <div className="ledger-sum" aria-label="本月合计">
            <div className="ledger-sum__cell">
              <span className="ledger-hero__label">出</span>
              <strong className="num">{formatCentsDisplay(data.expenseCents)}</strong>
            </div>
            <div className="ledger-sum__cell">
              <span className="ledger-hero__label">入</span>
              <strong className="num">{formatCentsDisplay(data.incomeCents)}</strong>
            </div>
          </div>
        )}
      </header>

      {data !== null && data.rows.length > 0 && (
        <LedgerBars bars={bars} onJump={jumpToDay} />
      )}

      {data === null ? (
        query.error !== null ? (
          <p className="ledger-note ledger-note--error" role="alert">
            流水暂时打不开
          </p>
        ) : (
          <p className="ledger-note" role="status">
            正在加载流水…
          </p>
        )
      ) : groups.length === 0 ? (
        <p className="ledger-note">本月还没有流水</p>
      ) : (
        <div className="ledger-days">
          {groups.map(group => (
            <section
              className="ledger-day"
              data-date={group.date}
              id={`ledger-day-${group.date}`}
              key={group.date}
            >
              <header className="ledger-day__head">
                <h2 className="ledger-day__date">
                  <time dateTime={group.date}>{ledgerDayLabel(group.date, today)}</time>
                </h2>
                <p className="ledger-day__totals">
                  <span className="ledger-day__total ledger-day__total--expense">
                    出 {formatCentsDisplay(group.expenseCents)}
                  </span>
                  <span className="ledger-day__total ledger-day__total--income">
                    入 {formatCentsDisplay(group.incomeCents)}
                  </span>
                </p>
              </header>
              <ul className="ledger-day__rows">
                {orderTransferLegs(group.rows).map(row => (
                  <li key={row.id}>
                    <LedgerRowView
                      row={row}
                      deleting={deletingId === row.id}
                      confirming={
                        row.transferGroupId !== null &&
                        confirmGroupId === row.transferGroupId
                      }
                      onAskDelete={candidate => setConfirmGroupId(candidate.transferGroupId)}
                      onCancelDelete={() => setConfirmGroupId(null)}
                      onConfirmDelete={candidate => void handleDeleteTransfer(candidate)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {status !== null && (
        <p
          className={`ledger-note ledger-note--${status.kind}`}
          role={status.kind === 'error' ? 'alert' : 'status'}
        >
          {status.text}
        </p>
      )}

      <div className="ledger-switch" role="group" aria-label="月份切换">
        <button
          type="button"
          aria-label="上个月"
          onClick={() => setMonthKey(previousMonth)}
        >
          ‹ {Number(previousMonth.slice(5, 7))}月
        </button>
        <button
          type="button"
          aria-label="下个月"
          disabled={atCurrentMonth}
          onClick={() => {
            if (!atCurrentMonth) setMonthKey(nextMonth);
          }}
        >
          {atCurrentMonth ? '已是本月' : `${Number(nextMonth.slice(5, 7))}月 ›`}
        </button>
      </div>
    </div>
  );
}