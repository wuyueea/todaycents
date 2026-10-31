import { Link } from 'react-router-dom';
import { orderTransferLegs } from '../components/txnOrder';
import { AmountText } from '../components/AmountText';
import { ProjectMark, UncategorisedLabel, isUncategorised } from '../components/TxnMarks';
import { useQuery } from '../store/useDb';
import { listTxnsByMonth } from '../db/repos/txns';
import type { TxnRow } from '../db/repos/txns';
import type { Db } from '../db/driver';
import { formatMonthDay, monthKeyOf, todayLocalISO } from '../domain/date';

/**
 * 今天: a plain list of the movements recorded on the local day.
 *
 * The screen is deliberately not a dashboard: there is no month total, no
 * balance, no budget and no count. The rows share one white card, each row
 * carrying a rounded category mark, the category/note line and the signed
 * amount. A transfer leg is shown read-only, exactly as the ledger does,
 * because a single leg must never lead to updateTxn or softDeleteTxn.
 */

/** Everything the screen renders from, loaded as one snapshot. */
export interface TodayData {
  /** The local day this snapshot describes. */
  date: string;
  /** Live movements recorded on that day, newest first (repository order). */
  rows: TxnRow[];
}

/**
 * Keeps exactly the live rows recorded on one day, preserving their order.
 *
 * listTxnsByMonth already returns live rows of one month newest first, but the
 * filter is repeated here so a hand-built list cannot render another day or a
 * soft-deleted row. Rows inside the day keep the repository's created_at order,
 * which is the order the user recorded them in.
 */
export function todayRows(rows: readonly TxnRow[], dateISO: string): TxnRow[] {
  return rows.filter(row => row.deletedAt === null && row.occurredDate === dateISO);
}

// The pair ordering is shared with 流水: see components/txnOrder.
export { orderTransferLegs } from '../components/txnOrder';

/** The screen's one query: the month row set, narrowed to this day. */
export async function loadTodayData(db: Db, dateISO: string): Promise<TodayData> {
  const monthRows = await listTxnsByMonth(db, monthKeyOf(dateISO));
  return { date: dateISO, rows: todayRows(monthRows, dateISO) };
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** The local weekday of a calendar day, without a UTC round trip. */
export function weekdayOf(dateISO: string): string {
  const [year, month, day] = dateISO.split('-').map(Number);
  return WEEKDAYS[new Date(year, month - 1, day).getDay()];
}

/** What sits in a row's category slot: a category, or the row's real kind. */
function cardLabel(row: TxnRow): string {
  if (row.direction === 'transfer') return '转账';
  if (row.direction === 'adjust') return '调整';
  return row.categoryName ?? '未分类';
}

/** The rounded mark before the name: a category initial or a kind glyph. */
function rowGlyph(row: TxnRow): string {
  if (row.direction === 'transfer') return '⇄';
  if (row.direction === 'adjust') return '≈';
  return (row.categoryName ?? '未').slice(0, 1);
}

/**
 * The muted second line.
 *
 * A normal row shows its note, or the account when there is no note, so the
 * line always carries a second fact. A transfer leg has no editor and no
 * category: it names its side and account instead, which is what tells the
 * two legs apart. An adjustment says why it is not spending.
 */
function rowMeta(row: TxnRow): string {
  if (row.direction === 'transfer') {
    const leg = row.amountCents < 0 ? '转出' : '转入';
    const note = row.note !== '' ? ` · ${row.note}` : '';
    return `${leg} · ${row.accountName}${note}`;
  }
  if (row.direction === 'adjust') return `${row.accountName} · 不算支出也不算收入`;
  return row.note !== '' ? `${row.accountName} · ${row.note}` : row.accountName;
}

/**
 * One movement as one row of the shared card.
 *
 * The amount is AmountText, the app's only amount renderer: expenses arrive
 * negative and take the expense colour, income arrives positive and takes the
 * income colour, and a transfer leg keeps its sign without taking either.
 */
function TodayCard({ row }: { row: TxnRow }) {
  const body = (
    <>
      <span className="today-card__dot" aria-hidden="true">
        {rowGlyph(row)}
      </span>
      <span className="today-card__body">
        <span className="today-card__category">
          {isUncategorised(row) ? <UncategorisedLabel /> : cardLabel(row)}
        </span>
        <span className="today-card__meta">
          {rowMeta(row)}
          <ProjectMark row={row} />
        </span>
      </span>
      <AmountText cents={row.amountCents} direction={row.direction} />
    </>
  );

  if (row.direction === 'transfer') {
    return (
      <div
        className="today-card today-card--readonly"
        data-txn-id={row.id}
        data-direction={row.direction}
      >
        {body}
      </div>
    );
  }

  return (
    <Link
      className="today-card"
      to={`/txn/${encodeURIComponent(row.id)}`}
      data-txn-id={row.id}
      data-direction={row.direction}
    >
      {body}
    </Link>
  );
}

export default function TodayScreen() {
  const today = todayLocalISO();
  const query = useQuery<TodayData>(database => loadTodayData(database, today), [today]);

  // A snapshot from another day must never be painted under this day's heading:
  // the app can stay open across midnight.
  const data = query.data?.date === today ? query.data : null;
  const rows = orderTransferLegs(data?.rows ?? []);

  return (
    <div className="today-screen">
      <header className="today-header">
        <p className="today-eyebrow">
          <time dateTime={today}>{formatMonthDay(today)}</time>
          <span>{weekdayOf(today)}</span>
        </p>
        <h1>今天</h1>
      </header>

      {data === null ? (
        query.error !== null ? (
          <p className="today-note today-note--error" role="alert">
            今天的记录暂时打不开
          </p>
        ) : (
          <p className="today-note" role="status">
            正在加载今天的记录…
          </p>
        )
      ) : rows.length === 0 ? (
        <div className="today-empty-card">
          <b>今天还没有一笔。</b>
          <p>点下面的 +，第一笔会落在这里。</p>
          <div className="today-ghost" aria-hidden="true">
            <i style={{ width: '80%' }} />
            <i style={{ width: '56%' }} />
            <i style={{ width: '68%' }} />
          </div>
        </div>
      ) : (
        <ul className="today-list">
          {rows.map(row => (
            <li key={row.id}>
              <TodayCard row={row} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}