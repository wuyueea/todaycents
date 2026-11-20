import type { TxnRow } from '../db/repos/txns';
import { formatMonthDay } from '../domain/date';
import { AmountText } from './AmountText';
import { TxnDeleteRow } from './TxnDelete';
import { TxnEditLink } from './TxnEditNavigation';

function rowParts(row: TxnRow, includeYear: boolean) {
  const category = row.categoryName ?? '未分类';
  const day = includeYear ? row.occurredDate : formatMonthDay(row.occurredDate);
  if (row.direction === 'transfer') return { title: row.note || '转账', meta: day };
  if (row.direction === 'adjust') return { title: row.note || '调整', meta: day };
  return row.note
    ? { title: row.note, meta: `${day} · ${category}` }
    : { title: category, meta: day };
}

export function ProjectTxnList({ rows, includeYear = false }: { rows: readonly TxnRow[]; includeYear?: boolean }) {
  return (
    <ul className="project-recent">
      {rows.map(row => {
        const { title, meta } = rowParts(row, includeYear);
        const body = (
          <>
            <span className="project-txn__body">
              <span className="project-txn__title">{title}</span>
              <span className="project-txn__meta">{meta}</span>
            </span>
            <AmountText cents={row.amountCents} direction={row.direction} />
          </>
        );

        return (
          <TxnDeleteRow key={row.id} row={row} label={title}>
            {row.direction === 'transfer' ? (
              <div className="project-txn project-txn--readonly" data-txn-id={row.id}>{body}</div>
            ) : (
              <TxnEditLink className="project-txn" txnId={row.id}>{body}</TxnEditLink>
            )}
          </TxnDeleteRow>
        );
      })}
    </ul>
  );
}
