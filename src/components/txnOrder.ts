import type { TxnRow } from '../db/repos/txns';

/**
 * Puts a transfer's two legs next to each other, out leg first.
 *
 * The repository returns rows newest first; the two legs of one transfer share
 * a created_at and can arrive in either order. A transfer is one movement, so
 * the display keeps the pair together at the position of its first leg and
 * always reads 转出 then 转入. This is presentation order only: no amount, id or
 * date changes, and each leg still renders exactly as the repository wrote it.
 */
export function orderTransferLegs(rows: readonly TxnRow[]): TxnRow[] {
  const ordered: TxnRow[] = [];
  const seenGroups = new Set<string>();

  for (const row of rows) {
    if (row.direction !== 'transfer' || row.transferGroupId === null) {
      ordered.push(row);
      continue;
    }
    if (seenGroups.has(row.transferGroupId)) continue;
    seenGroups.add(row.transferGroupId);

    const legs = rows.filter(
      candidate =>
        candidate.direction === 'transfer' &&
        candidate.transferGroupId === row.transferGroupId
    );
    // Out (negative) before in (positive). A legacy group with two same-sign
    // legs keeps repository order, because there is no "out" to put first.
    ordered.push(
      ...legs.filter(leg => leg.amountCents < 0),
      ...legs.filter(leg => leg.amountCents >= 0)
    );
  }

  return ordered;
}
/**
 * Counts movements, not legs: a transfer's two rows are one thing the owner did.
 * Legacy legs without a group id cannot be paired, so they still count separately.
 */
export function countMovements(rows: readonly TxnRow[]): number {
  const groups = new Set<string>();
  let count = 0;
  for (const row of rows) {
    if (row.direction === 'transfer' && row.transferGroupId !== null) {
      if (groups.has(row.transferGroupId)) continue;
      groups.add(row.transferGroupId);
    }
    count += 1;
  }
  return count;
}
