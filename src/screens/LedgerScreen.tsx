import { useEffect, useRef, useState } from 'react';
import { AmountText, formatCentsDisplay } from '../components/AmountText';
import { LedgerCalendar } from '../components/LedgerCalendar';
import { TxnDeleteRow } from '../components/TxnDelete';
import { TxnEditLink, useRestoreTxnEditScroll } from '../components/TxnEditNavigation';
import type { TxnEditOrigin } from '../components/TxnEditNavigation';
import { ProjectMark, UncategorisedLabel, isUncategorised } from '../components/TxnMarks';
import { countMovements, orderTransferLegs } from '../components/txnOrder';
import { useQuery } from '../store/useDb';
import { useToday } from '../store/useToday';
import { listTxnsByMonth, monthSummary } from '../db/repos/txns';
import type { TxnRow } from '../db/repos/txns';
import type { Db } from '../db/driver';
import {
  daysBetweenISO,
  formatMonthDay,
  formatMonthLabel,
  monthKeyOf,
  monthRange,
  shiftMonthKey,
  weekdayIndex,
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
 * edited or deleted on its own. Adjustments are readable and editable but count in
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
  if (daysBetweenISO(dateISO, todayISO) === 1) return `${day} 昨天`;
  const weekday = WEEKDAYS[weekdayIndex(dateISO)];
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
  const days = Number(monthRange(monthKey).end.slice(-2));
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
    const date = `${monthKey}-${String(day).padStart(2, '0')}`;
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

// Transfer legs share one edit and delete target while retaining their row identity.
function LedgerRowView({ row, monthKey, calendarDay }: { row: TxnRow; monthKey: string; calendarDay?: string }) {
  const isTransfer = row.direction === 'transfer';
  const meta = isTransfer
    ? `${row.amountCents < 0 ? '转出' : '转入'} · ${row.accountName}${
        row.note !== '' ? ` ${row.note}` : ''
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
              <span className="ledger-row__account">{row.accountName}</span>
              {row.note !== '' && <span className="ledger-row__note">{row.note}</span>}
              <ProjectMark row={row} />
            </>
          )}
        </span>
      </span>
      <AmountText cents={row.amountCents} direction={row.direction} />
    </>
  );

  return (
    <TxnEditLink
      className="ledger-row"
      txnId={row.id}
      direction={row.direction}
      monthKey={monthKey}
      calendarDay={calendarDay}
    >
      {body}
    </TxnEditLink>
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

function scrollToLedgerDay(date: string, throughCalendar = false) {
  const target = document.getElementById(`ledger-day-${date}`);
  if (target === null) return;
  if (throughCalendar) target.querySelector('h2')?.focus({ preventScroll: true });
  // Keep the day heading below the translucent Android status bar.
  const inset = document.querySelector('.status-veil')?.getBoundingClientRect().height ?? 0;
  const top = target.getBoundingClientRect().top + window.scrollY - inset - 8;
  window.scrollTo({ top: Math.max(0, top), behavior: throughCalendar ? 'auto' : 'smooth' });
}

export default function LedgerScreen({ editReturn = null }: { editReturn?: TxnEditOrigin | null }) {
  const today = useToday();
  const currentMonthKey = monthKeyOf(today);
  const [monthKey, setMonthKey] = useState(editReturn?.monthKey ?? currentMonthKey);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [dayJump, setDayJump] = useState<{ date: string } | null>(() =>
    editReturn?.calendarDay === undefined ? null : { date: editReturn.calendarDay }
  );
  // The return restores the row's scroll position while keeping the date feedback.
  const handledJump = useRef(dayJump);
  const lastPositionedMonth = useRef(editReturn?.monthKey);
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
  const atFirstMonth = monthKey === '0000-01';
  const previousMonth = atFirstMonth ? monthKey : shiftMonthKey(monthKey, -1);
  const nextMonth = atCurrentMonth ? monthKey : shiftMonthKey(monthKey, 1);
  const monthLabel = formatMonthLabel(monthKey);
  const ready = data !== null && !query.loading;
  const selectedDay = dayJump?.date ?? null;
  const hasSelectedDay = groups.some(group => group.date === selectedDay);
  const emptyDay = selectedDay !== null && ready && !hasSelectedDay
    ? `${monthLabel}${Number(selectedDay.slice(-2))}日没有流水。` : null;

  useEffect(() => {
    if (lastPositionedMonth.current === monthKey) return;
    lastPositionedMonth.current = monthKey;
    window.scrollTo({ top: 0 });
  }, [monthKey]);
  useRestoreTxnEditScroll(editReturn, ready);
  useEffect(() => {
    if (dayJump === null || !ready || handledJump.current === dayJump) return;
    handledJump.current = dayJump;
    if (hasSelectedDay) scrollToLedgerDay(dayJump.date, true);
    else window.scrollTo({ top: 0 });
  }, [dayJump, ready, hasSelectedDay]);

  const showMonth = (next: string) => {
    setDayJump(null);
    setMonthKey(next);
    if (next === monthKey) window.scrollTo({ top: 0 });
  };

  return (
    <div className="ledger-screen">
      <header className="ledger-hero">
        <div className="ledger-month">
          <div>
            <p className="ledger-month__eyebrow">流水</p>
            <h1 className="ledger-month__title">
              <button type="button" className="ledger-month__calendar" aria-haspopup="dialog"
                aria-expanded={calendarOpen} title="选择日期" onClick={() => setCalendarOpen(true)}>
                {monthLabel}<span className="ledger-month__calendar-icon" aria-hidden="true" />
              </button>
            </h1>
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
        <LedgerBars bars={bars} onJump={date => {
          setDayJump(null);
          scrollToLedgerDay(date);
        }} />
      )}

      {emptyDay !== null && <p className="ledger-note ledger-note--empty-day" role="status">{emptyDay}</p>}
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
        emptyDay !== null ? null : <p className="ledger-note">本月还没有流水</p>
      ) : (
        <div className="ledger-days">
          {groups.map(group => (
            <section
              className="ledger-day"
              data-date={group.date}
              data-calendar-selected={selectedDay === group.date || undefined}
              id={`ledger-day-${group.date}`}
              key={group.date}
            >
              <header className="ledger-day__head">
                <h2 className="ledger-day__date" tabIndex={-1}>
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
                  <TxnDeleteRow key={row.id} row={row} label={ledgerLabel(row)}>
                    <LedgerRowView row={row} monthKey={monthKey} calendarDay={selectedDay ?? undefined} />
                  </TxnDeleteRow>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <div className="ledger-switch" role="group" aria-label="月份切换">
        <button
          type="button"
          aria-label="上个月"
          disabled={atFirstMonth}
          onClick={() => showMonth(previousMonth)}
        >
          {atFirstMonth ? '已是最早月份' : `‹ ${Number(previousMonth.slice(5, 7))}月`}
        </button>
        <button
          type="button"
          aria-label="下个月"
          disabled={atCurrentMonth}
          onClick={() => {
            if (!atCurrentMonth) showMonth(nextMonth);
          }}
        >
          {atCurrentMonth ? '已是本月' : `${Number(nextMonth.slice(5, 7))}月 ›`}
        </button>
      </div>
      {calendarOpen && (
        <LedgerCalendar monthKey={monthKey} today={today} selectedDay={selectedDay}
          onClose={() => setCalendarOpen(false)}
          onMonth={key => {
            setCalendarOpen(false);
            showMonth(key);
          }}
          onDay={date => {
            setCalendarOpen(false);
            setDayJump({ date });
            setMonthKey(monthKeyOf(date));
          }} />
      )}
    </div>
  );
}
