/**
 * Transfers: money moving between two of the user's own accounts.
 *
 * A transfer is two signed legs sharing one transfer_group_id — negative from
 * the source account's point of view, positive from the destination's — so
 * balances move while no income or expense is ever recorded. Both legs are
 * written inside one transaction: a half-written transfer would corrupt every
 * balance and every statistic derived from txn.
 */
import type { Db } from '../driver';
import { newId } from '../id';
import { assertTxnDate, monthSummary } from './txns';

/** Everything createTransfer needs; the amount is a positive integer. */
export interface CreateTransferInput {
  /** Calendar date as YYYY-MM-DD; both legs share it. */
  date: string;
  fromAccountId: string;
  toAccountId: string;
  /** Positive integer cents. The sign is applied per leg, never passed in. */
  amountCents: number;
  /** Optional free text stored on both legs. */
  note?: string;
}

/**
 * One leg of a transfer. direction, category_id and deleted_at are literals:
 * a transfer leg is never categorised and never starts out deleted.
 */
const INSERT_LEG = `INSERT INTO txn
   (id, occurred_date, account_id, amount_cents, direction, category_id, note,
    transfer_group_id, deleted_at, created_at)
 VALUES (?, ?, ?, ?, 'transfer', NULL, ?, ?, NULL, ?)`;

/**
 * Rejects bad input before any statement runs, so a failed validation cannot
 * leave rows behind. The date must be a real YYYY-MM-DD day (the same rule the
 * transaction repository applies), and amounts are integer cents only:
 * fractional money never reaches SQL.
 */
function assertTransferable(input: CreateTransferInput): void {
  assertTxnDate(input.date);
  const { amountCents, fromAccountId, toAccountId } = input;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new RangeError(
      `amountCents must be a positive integer number of cents, received ${amountCents}`
    );
  }
  if (fromAccountId === toAccountId) {
    throw new Error(`a transfer needs two different accounts, both are ${fromAccountId}`);
  }
}

/**
 * Creates both legs of a transfer and returns their shared transferGroupId.
 *
 * Validation happens outside the transaction; the two INSERTs happen inside
 * it, so the transfer either exists completely or not at all.
 */
export async function createTransfer(db: Db, input: CreateTransferInput): Promise<string> {
  assertTransferable(input);

  const transferGroupId = newId();
  const note = input.note ?? '';
  const createdAt = new Date().toISOString();

  await db.transaction(async (tx) => {
    const legs: ReadonlyArray<{ accountId: string; amountCents: number }> = [
      { accountId: input.fromAccountId, amountCents: -input.amountCents },
      { accountId: input.toAccountId, amountCents: input.amountCents },
    ];
    for (const leg of legs) {
      await tx.run(INSERT_LEG, [
        newId(),
        input.date,
        leg.accountId,
        leg.amountCents,
        note,
        transferGroupId,
        createdAt,
      ]);
    }
  });

  return transferGroupId;
}

/**
 * Soft-deletes every live leg of the group. Rows are never removed, and the
 * first deletion timestamp is kept, so calling this twice is a no-op rather
 * than a rewrite. Only rows carrying this exact group id are touched.
 */
export async function deleteTransfer(db: Db, groupId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run('UPDATE txn SET deleted_at = ? WHERE transfer_group_id = ? AND deleted_at IS NULL', [
      new Date().toISOString(),
      groupId,
    ]);
  });
}

/**
 * Sum of this month's spending in positive cents. Delegates to monthSummary so
 * "spending in a month" has exactly one definition: only live rows with
 * direction 'expense' count, and transfers move money the user already owns,
 * while adjustments correct it, so neither is spending.
 */
export async function monthExpenseTotal(db: Db, monthKey: string): Promise<number> {
  return (await monthSummary(db, monthKey)).expenseCents;
}
