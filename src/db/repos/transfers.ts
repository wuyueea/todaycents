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
import type { Account } from '../../domain/types';
import { accountBalance, allBalances, listAccounts } from './accounts';
import { assertTxnDate, assertTxnWritableDate, monthSummary } from './txns';

interface TransferMovement {
  fromAccountId: string;
  toAccountId: string;
  /** Positive integer cents; the sign is applied per leg. */
  amountCents: number;
}

/** Everything createTransfer needs; the amount is a positive integer. */
export interface CreateTransferInput extends TransferMovement {
  /** Calendar date as YYYY-MM-DD; both legs share it. */
  date: string;
  /** Optional free text stored on both legs. */
  note?: string;
}

export interface TransferEditInput extends TransferMovement {
  note: string;
}

export interface TransferPair extends TransferEditInput {
  groupId: string;
  date: string;
  fromTxnId: string;
  toTxnId: string;
}

export interface TransferEditData {
  pair: TransferPair;
  accounts: readonly Account[];
  balances: Readonly<Record<string, number>>;
}

export interface TransferBalanceChange {
  accountId: string;
  beforeCents: number;
  afterCents: number;
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
 * leave rows behind. Amounts are integer cents only: fractional money never
 * reaches SQL.
 */
function assertTransferMovement({ amountCents, fromAccountId, toAccountId }: TransferMovement): void {
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
  assertTxnWritableDate(input.date);
  assertTransferMovement(input);

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

interface TransferLegRow {
  id: string;
  occurred_date: string;
  account_id: string;
  amount_cents: number;
  note: string;
  direction: string;
  deleted_at: string | null;
  category_id: string | null;
  project_id: string | null;
  is_fixed_cost: number;
  has_tags: number;
}

async function readTransferPair(db: Db, groupId: string): Promise<TransferPair | null> {
  const legs = await db.all<TransferLegRow>(
    `SELECT t.id, t.occurred_date, t.account_id, t.amount_cents, t.note, t.direction,
            t.deleted_at, t.category_id, t.project_id, t.is_fixed_cost,
            EXISTS (SELECT 1 FROM txn_tag WHERE txn_id = t.id) AS has_tags
       FROM txn t WHERE t.transfer_group_id = ?`,
    [groupId]
  );
  if (legs.length !== 2 || legs.some(leg =>
    leg.direction !== 'transfer' || leg.deleted_at !== null ||
    leg.category_id !== null || leg.project_id !== null || leg.has_tags !== 0 || leg.is_fixed_cost !== 0
  )) return null;

  const from = legs.find(leg => leg.amount_cents < 0);
  const to = legs.find(leg => leg.amount_cents > 0);
  if (!from || !to || !Number.isSafeInteger(to.amount_cents) || from.amount_cents !== -to.amount_cents ||
      from.account_id === to.account_id || from.occurred_date !== to.occurred_date || from.note !== to.note) {
    return null;
  }
  try {
    assertTxnDate(from.occurred_date);
  } catch {
    return null;
  }
  return {
    groupId,
    date: from.occurred_date,
    fromTxnId: from.id,
    toTxnId: to.id,
    fromAccountId: from.account_id,
    toAccountId: to.account_id,
    amountCents: to.amount_cents,
    note: from.note,
  };
}

export async function loadTransferEditData(db: Db, groupId: string): Promise<TransferEditData | null> {
  return db.transaction(async tx => {
    const pair = await readTransferPair(tx, groupId);
    if (pair === null) return null;
    const accounts = await listAccounts(tx, { includeArchived: true });
    if (!accounts.some(account => account.id === pair.fromAccountId) ||
        !accounts.some(account => account.id === pair.toAccountId)) return null;
    return { pair, accounts, balances: await allBalances(tx) };
  });
}

/** Each side may keep its original account even after that account is archived. */
export function transferAccountOptions(accounts: readonly Account[], originalId: string): Account[] {
  return accounts.filter(account => account.archivedAt === null || account.id === originalId);
}

/** Remove the old transfer's contributions and apply the proposed ones. */
export function transferBalanceChanges(
  original: TransferMovement,
  next: TransferMovement,
  balances: Readonly<Record<string, number>>,
): TransferBalanceChange[] | null {
  const oldCents = BigInt(original.amountCents);
  const newCents = BigInt(next.amountCents);
  const contributions = [
    [original.fromAccountId, oldCents],
    [original.toAccountId, -oldCents],
    [next.fromAccountId, -newCents],
    [next.toAccountId, newCents],
  ] as const;
  // Exact intermediates matter when old and new movements reverse directions.
  const deltas = new Map<string, bigint>();
  for (const [accountId, cents] of contributions) {
    deltas.set(accountId, (deltas.get(accountId) ?? 0n) + cents);
  }

  const changes: TransferBalanceChange[] = [];
  for (const [accountId, delta] of deltas) {
    if (delta === 0n) continue;
    const beforeCents = balances[accountId];
    if (!Number.isSafeInteger(beforeCents)) return null;
    const afterCents = Number(BigInt(beforeCents) + delta);
    if (!Number.isSafeInteger(afterCents)) return null;
    changes.push({ accountId, beforeCents, afterCents });
  }
  return changes;
}

/** Update the two original rows only if the transfer and reviewed balances still match. */
export async function updateTransfer(
  db: Db,
  original: TransferPair,
  input: TransferEditInput,
  previewBalances: Readonly<Record<string, number>>,
): Promise<void> {
  assertTransferMovement(input);
  await db.transaction(async tx => {
    const current = await readTransferPair(tx, original.groupId);
    if (current === null) throw new Error('转账记录不完整或已删除，无法保存。');
    if (current.fromTxnId !== original.fromTxnId || current.toTxnId !== original.toTxnId ||
        current.fromAccountId !== original.fromAccountId || current.toAccountId !== original.toAccountId ||
        current.amountCents !== original.amountCents || current.note !== original.note || current.date !== original.date) {
      throw new Error('转账已变化，请返回并重新打开核对。');
    }

    const accounts = await listAccounts(tx, { includeArchived: true });
    if (!transferAccountOptions(accounts, current.fromAccountId).some(account => account.id === input.fromAccountId) ||
        !transferAccountOptions(accounts, current.toAccountId).some(account => account.id === input.toAccountId)) {
      throw new Error('所选账户不可用，请重新选择。');
    }
    const changes = transferBalanceChanges(current, input, previewBalances);
    if (changes === null) throw new Error('无法精确计算余额变化，请检查转账金额。');
    for (const change of changes) {
      if (await accountBalance(tx, change.accountId) !== change.beforeCents) {
        throw new Error('账户余额已变化，请返回并重新打开核对。');
      }
    }

    await tx.run(
      `UPDATE txn
          SET account_id = CASE WHEN id = ? THEN ? ELSE ? END,
              amount_cents = CASE WHEN id = ? THEN ? ELSE ? END,
              note = ?
        WHERE transfer_group_id = ? AND direction = 'transfer' AND deleted_at IS NULL
          AND id IN (?, ?)`,
      [current.fromTxnId, input.fromAccountId, input.toAccountId,
        current.fromTxnId, -input.amountCents, input.amountCents, input.note,
        current.groupId, current.fromTxnId, current.toTxnId]
    );
    const changed = await tx.get<{ n: number }>('SELECT changes() AS n');
    if (changed?.n !== 2) throw new Error('两条转账流水未能完整保存，请重试。');
  });
}

/**
 * Soft-deletes every live leg of the group. Rows are never removed, and the
 * first deletion timestamp is kept, so calling this twice is a no-op rather
 * than a rewrite. A missing group is an error. Checking the affected count
 * inside the transaction prevents a partially updated group from committing.
 * Only rows carrying this exact group id are touched.
 */
export async function deleteTransfer(db: Db, groupId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.get<{ total: number; live: number }>(
      `SELECT COUNT(*) AS total,
         COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) AS live
       FROM txn WHERE transfer_group_id = ?`,
      [groupId]
    );
    if (rows === undefined || rows.total === 0) throw new Error('转账不存在，请刷新后重试。');
    if (rows.live === 0) return;

    await tx.run('UPDATE txn SET deleted_at = ? WHERE transfer_group_id = ? AND deleted_at IS NULL', [
      new Date().toISOString(),
      groupId,
    ]);
    const changed = await tx.get<{ n: number }>('SELECT changes() AS n');
    if (changed?.n !== rows.live) throw new Error('删除转账失败，转账记录未完整更新，请重试。');
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
