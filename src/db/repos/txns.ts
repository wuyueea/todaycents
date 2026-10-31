/**
 * Transactions: the rows that turn money movement into a record.
 *
 * Sign convention: amount_cents is signed from its account's point of view,
 * and callers always pass a positive amount. This module owns the sign —
 * expenses are written negative, income positive — so no caller ever has to
 * reason about it, and no arithmetic here touches floating point.
 *
 * Transfers and adjustments are written by other repositories and never count
 * as spending or earning: every summary query below narrows to a direction.
 */
import type { Db, DbParam } from '../driver';
import { newId } from '../id';
import { assertDateISO, monthRange } from '../../domain/date';
import { UNCATEGORIZED_CATEGORY_ID } from '../schema';
import type { Direction } from '../../domain/types';

/** A transaction as the ledger screen consumes it: names resolved, no columns. */
export interface TxnRow {
  id: string;
  occurredDate: string;
  accountId: string;
  accountName: string;
  amountCents: number;
  direction: Direction;
  categoryId: string | null;
  categoryName: string | null;
  note: string;
  slotKey: string | null;
  isFixedCost: boolean;
  /** Shared id of a transfer's two legs; null for every other direction. */
  transferGroupId: string | null;
  deletedAt: string | null;
  /**
   * The project this row belongs to, or null when it belongs to none.
   *
   * txn.project_id has no foreign key, so a legacy backup may point at a
   * project the file no longer carries: projectId can then be set while
   * projectName is null. Every marker rule keys off projectName for exactly
   * that reason — a project that cannot be named is not drawn.
   */
  projectId: string | null;
  /** The project's display name, joined from project.name. */
  projectName: string | null;
  /** True when that project is archived: the name stays, but reads as history. */
  projectArchived: boolean;
}

/** Everything createExpense needs; categoryId may be null for 未分类. */
export interface CreateExpenseInput {
  /** Calendar date as YYYY-MM-DD. Never coerced. */
  date: string;
  accountId: string;
  /** Positive integer cents; the expense sign is applied by this module. */
  amountCents: number;
  categoryId: string | null;
  note?: string;
  /** Retained slot this row came from, when submitDay wrote it. */
  slotKey?: string;
}

/** Everything createIncome needs. Income rows carry no slot key. */
export interface CreateIncomeInput {
  /** Calendar date as YYYY-MM-DD. Never coerced. */
  date: string;
  accountId: string;
  /** Positive integer cents; the income sign is applied by this module. */
  amountCents: number;
  categoryId: string | null;
  note?: string;
}

/**
 * Fields updateTxn may change. occurred_date is deliberately absent: the edit
 * screen edits an existing day's row, it never moves it to another day.
 */
export interface UpdateTxnPatch {
  amountCents?: number;
  categoryId?: string | null;
  note?: string;
  accountId?: string;
}

/** Raw row shape; the only place that knows the snake_case column names. */
interface RawTxnRow {
  id: string;
  occurred_date: string;
  account_id: string;
  account_name: string;
  amount_cents: number;
  direction: Direction;
  category_id: string | null;
  category_name: string | null;
  note: string;
  slot_key: string | null;
  is_fixed_cost: number;
  transfer_group_id: string | null;
  deleted_at: string | null;
  project_id: string | null;
  project_name: string | null;
  project_status: string | null;
}

/**
 * Rejects anything that is not a real calendar day written YYYY-MM-DD.
 *
 * The rule itself lives in domain/date (assertDateISO) so every write in the
 * ledger — a transaction, a transfer leg, a project start date, a fixed-cost
 * bill — applies one calendar definition. This alias keeps the name the
 * repositories already import.
 */
export function assertTxnDate(date: string): void {
  assertDateISO(date);
}

/** Guards the positive, integer-cents invariant at the repository boundary. */
function assertPositiveCents(amountCents: number): void {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new RangeError(
      `amountCents must be a positive integer number of cents, received ${amountCents}`
    );
  }
}

/**
 * The row's sign, derived from its direction. Expenses are negative and income
 * positive; adjustments keep the side of zero they already sit on, so an edit
 * changes the size of the movement, never its sense.
 */
function signedAmount(
  amountCents: number,
  direction: Direction,
  previousAmountCents: number
): number {
  if (direction === 'expense') return -amountCents;
  if (direction === 'income') return amountCents;
  return previousAmountCents < 0 ? -amountCents : amountCents;
}

const INSERT_TXN = `INSERT INTO txn
   (id, occurred_date, account_id, amount_cents, direction, category_id, note,
    slot_key, is_fixed_cost, transfer_group_id, deleted_at, created_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)`;

/**
 * One INSERT shared by every plain entry. Validation has already happened; this
 * helper only fills in the generated id, the direction and the creation
 * timestamp. Transfers use their own insert because they write two legs in one
 * transaction.
 */
async function insertTxn(
  db: Db,
  row: {
    date: string;
    accountId: string;
    amountCents: number;
    direction: 'expense' | 'income' | 'adjust';
    categoryId: string | null;
    note: string;
    slotKey: string | null;
  }
): Promise<string> {
  const id = newId();
  await db.run(INSERT_TXN, [
    id,
    row.date,
    row.accountId,
    row.amountCents,
    row.direction,
    row.categoryId,
    row.note,
    row.slotKey,
    new Date().toISOString(),
  ]);
  return id;
}

/**
 * Creates a spending row and returns its id.
 *
 * No transaction is opened: callers such as submitDay already run inside one,
 * and the driver's transactions are not re-entrant. Validation runs
 * before the INSERT, so a rejected amount or date writes nothing.
 */
export async function createExpense(db: Db, input: CreateExpenseInput): Promise<string> {
  assertTxnDate(input.date);
  assertPositiveCents(input.amountCents);
  return insertTxn(db, {
    date: input.date,
    accountId: input.accountId,
    amountCents: -input.amountCents,
    direction: 'expense',
    categoryId: input.categoryId,
    note: input.note ?? '',
    slotKey: input.slotKey ?? null,
  });
}

/** Creates an income row and returns its id. Same rules as createExpense. */
export async function createIncome(db: Db, input: CreateIncomeInput): Promise<string> {
  assertTxnDate(input.date);
  assertPositiveCents(input.amountCents);
  return insertTxn(db, {
    date: input.date,
    accountId: input.accountId,
    amountCents: input.amountCents,
    direction: 'income',
    categoryId: input.categoryId,
    note: input.note ?? '',
    slotKey: null,
  });
}

/** Everything recordAdjustment needs; deltaCents is already signed. */
export interface RecordAdjustmentInput {
  /** Calendar date as YYYY-MM-DD. Never coerced. */
  date: string;
  accountId: string;
  /**
   * Signed correction in integer cents: positive raises the balance, negative
   * lowers it. Unlike an expense or income this is not a magnitude, so zero is
   * the only forbidden value.
   */
  deltaCents: number;
  note?: string;
}

/**
 * Writes one reconciliation row and returns its id.
 *
 * An adjustment is a real row so the balance (a plain SUM) can be corrected
 * without editing history. It carries direction 'adjust', no category and no
 * slot, and the summary queries narrow to expense/income, so it never enters
 * spending, earning or a category share. The delta is signed here because a
 * correction has no "positive magnitude" reading; expenses and income still
 * receive a positive magnitude and let this module apply the sign.
 *
 * The account must exist and still be live: a correction on a hidden or
 * mistyped account is refused before anything is written, instead of relying
 * on the foreign key to fail halfway. No transaction is opened — this is one
 * INSERT.
 */
export async function recordAdjustment(
  db: Db,
  input: RecordAdjustmentInput
): Promise<string> {
  assertTxnDate(input.date);
  if (!Number.isSafeInteger(input.deltaCents) || input.deltaCents === 0) {
    throw new RangeError(
      `deltaCents must be a non-zero integer number of cents, received ${input.deltaCents}`
    );
  }

  const account = await db.get<{ archived_at: string | null }>(
    'SELECT archived_at FROM account WHERE id = ?',
    [input.accountId]
  );
  if (account === undefined) {
    throw new Error(`account not found: ${input.accountId}`);
  }
  if (account.archived_at !== null) {
    throw new Error(`cannot adjust an archived account: ${input.accountId}`);
  }

  return insertTxn(db, {
    date: input.date,
    accountId: input.accountId,
    amountCents: input.deltaCents,
    direction: 'adjust',
    categoryId: null,
    note: input.note ?? '',
    slotKey: null,
  });
}

/**
 * Edits amount, category, account and note of one live row.
 *
 * The direction (and therefore the sign) belongs to the row, not the caller:
 * an edited expense stays negative and an edited income stays positive. A
 * missing or soft-deleted id is an error rather than a silent no-op, because
 * the edit screen would otherwise report success while changing nothing.
 * A transfer leg is rejected: the two legs only add up to zero together, so
 * editing one would create or destroy money. No transaction is opened — this
 * is a single UPDATE plus a read.
 */
export async function updateTxn(db: Db, id: string, patch: UpdateTxnPatch): Promise<void> {
  // occurred_date is not part of the patch type, but a plain object from
  // JavaScript can still carry it; refuse instead of silently ignoring it.
  if ('date' in patch || 'occurredDate' in patch) {
    throw new Error('updateTxn cannot move a transaction between days');
  }
  if (patch.amountCents !== undefined) {
    assertPositiveCents(patch.amountCents);
  }

  const existing = await db.get<{ amount_cents: number; direction: Direction }>(
    'SELECT amount_cents, direction FROM txn WHERE id = ? AND deleted_at IS NULL',
    [id]
  );
  if (existing === undefined) {
    throw new Error(`transaction not found: ${id}`);
  }
  if (existing.direction === 'transfer') {
    throw new Error('updateTxn cannot edit a transfer leg: the two legs must stay a matched pair');
  }

  const sets: string[] = [];
  const params: DbParam[] = [];

  if (patch.amountCents !== undefined) {
    sets.push('amount_cents = ?');
    params.push(signedAmount(patch.amountCents, existing.direction, existing.amount_cents));
  }
  if (patch.categoryId !== undefined) {
    sets.push('category_id = ?');
    params.push(patch.categoryId);
  }
  if (patch.note !== undefined) {
    sets.push('note = ?');
    params.push(patch.note);
  }
  if (patch.accountId !== undefined) {
    sets.push('account_id = ?');
    params.push(patch.accountId);
  }
  if (sets.length === 0) return;

  params.push(id);
  await db.run(`UPDATE txn SET ${sets.join(', ')} WHERE id = ?`, params);
}

/**
 * Soft-deletes one row. The row is never physically removed, and the first
 * deletion timestamp is kept, so calling this twice is a no-op rather than a
 * rewrite. No transaction: it is one statement.
 *
 * A live transfer leg is rejected: deleting one side would move money out of
 * thin air, and a transfer must be removed through deleteTransfer so both
 * legs go together.
 */
export async function softDeleteTxn(db: Db, id: string): Promise<void> {
  const row = await db.get<{ direction: Direction }>(
    'SELECT direction FROM txn WHERE id = ? AND deleted_at IS NULL',
    [id]
  );
  if (row?.direction === 'transfer') {
    throw new Error('softDeleteTxn cannot delete a transfer leg; use deleteTransfer for the whole group');
  }

  await db.run('UPDATE txn SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?', [
    new Date().toISOString(),
    id,
  ]);
}

const TXN_COLUMNS = `t.id, t.occurred_date, t.account_id, a.name AS account_name,
       t.amount_cents, t.direction, t.category_id, c.name AS category_name,
       t.note, t.slot_key, t.is_fixed_cost, t.transfer_group_id, t.deleted_at,
       t.project_id, p.name AS project_name, p.status AS project_status`;

/**
 * The project join every row read shares.
 *
 * LEFT JOIN on purpose: a row with no project, or one whose project row is
 * missing from a legacy file, must still be listed. The screen decides not to
 * draw a name when project_name is null; the repository never invents one.
 */
const TXN_PROJECT_JOIN = 'LEFT JOIN project p ON p.id = t.project_id';

/**
 * Live rows of one month, newest day first. The month is an inclusive range
 * built by monthRange and compared as text, so the local date prefix decides
 * membership and no UTC conversion is involved. Uncategorised rows survive
 * the LEFT JOIN with null category fields instead of disappearing.
 */
const LIST_BY_MONTH = `SELECT ${TXN_COLUMNS}
 FROM txn t
 JOIN account a ON a.id = t.account_id
 LEFT JOIN category c ON c.id = t.category_id
 ${TXN_PROJECT_JOIN}
 WHERE t.deleted_at IS NULL AND t.occurred_date >= ? AND t.occurred_date <= ?
 ORDER BY t.occurred_date DESC, t.created_at DESC`;

function toTxnRow(row: RawTxnRow): TxnRow {
  return {
    id: row.id,
    occurredDate: row.occurred_date,
    accountId: row.account_id,
    accountName: row.account_name,
    amountCents: row.amount_cents,
    direction: row.direction,
    categoryId: row.category_id,
    categoryName: row.category_name,
    note: row.note,
    slotKey: row.slot_key,
    isFixedCost: row.is_fixed_cost === 1,
    transferGroupId: row.transfer_group_id,
    deletedAt: row.deleted_at,
    projectId: row.project_id,
    projectName: row.project_name,
    projectArchived: row.project_status === 'archived',
  };
}

export async function listTxnsByMonth(db: Db, monthKey: string): Promise<TxnRow[]> {
  const { start, end } = monthRange(monthKey);
  const rows = await db.all<RawTxnRow>(LIST_BY_MONTH, [start, end]);
  return rows.map(toTxnRow);
}

/**
 * The newest live rows of one project, newest day first.
 *
 * The project detail screen asks 最近几笔 and the list is bounded by its own
 * LIMIT, so the caller passes the limit it already validated. The row shape,
 * the joins and the deleted_at filter are the same as listTxnsByMonth: a
 * transaction must look identical wherever it is listed, and a soft-deleted
 * row is not a recent expense.
 */
const LIST_BY_PROJECT = `SELECT ${TXN_COLUMNS}
 FROM txn t
 JOIN account a ON a.id = t.account_id
 LEFT JOIN category c ON c.id = t.category_id
 ${TXN_PROJECT_JOIN}
 WHERE t.deleted_at IS NULL AND t.project_id = ?
 ORDER BY t.occurred_date DESC, t.created_at DESC, t.id DESC
 LIMIT ?`;

export async function listTxnsByProject(
  db: Db,
  projectId: string,
  limit: number
): Promise<TxnRow[]> {
  const rows = await db.all<RawTxnRow>(LIST_BY_PROJECT, [projectId, limit]);
  return rows.map(toTxnRow);
}

/**
 * One live row by id, with the same joins and columns as the month list.
 *
 * The edit screen addresses a row directly instead of finding it inside one
 * month's list: a row's month is a property of the row, not of the screen
 * navigation, and an old row must stay editable after the calendar moves on.
 */
const GET_TXN_BY_ID = `SELECT ${TXN_COLUMNS}
 FROM txn t
 JOIN account a ON a.id = t.account_id
 LEFT JOIN category c ON c.id = t.category_id
 ${TXN_PROJECT_JOIN}
 WHERE t.id = ? AND t.deleted_at IS NULL`;

export async function getTxnById(db: Db, id: string): Promise<TxnRow | null> {
  const row = await db.get<RawTxnRow>(GET_TXN_BY_ID, [id]);
  return row === undefined ? null : toTxnRow(row);
}

/** What quick entry prefills from the last row of one direction. */
export interface EntryDefaults {
  categoryId: string | null;
  accountId: string | null;
}

const LAST_ENTRY_DEFAULTS = `SELECT category_id, account_id
 FROM txn
 WHERE direction = ? AND deleted_at IS NULL
 ORDER BY occurred_date DESC, created_at DESC, id DESC
 LIMIT 1`;

/**
 * The category and account of the newest live row of one direction.
 *
 * Quick entry uses this so the common case only needs an amount and a submit.
 * The ids are returned exactly as stored, even when the category or account
 * has since been archived: this module has no idea what a picker may show, so
 * the caller validates them against its live lists. Nulls when the direction
 * has no history yet.
 */
export async function lastEntryDefaults(
  db: Db,
  direction: 'expense' | 'income'
): Promise<EntryDefaults> {
  const row = await db.get<{ category_id: string | null; account_id: string }>(
    LAST_ENTRY_DEFAULTS,
    [direction]
  );
  return { categoryId: row?.category_id ?? null, accountId: row?.account_id ?? null };
}

interface SummaryRow {
  expense_cents: number;
  income_cents: number;
}

/**
 * The month's spending and earning in positive cents, computed from exactly
 * the same rows, joins and date range as listTxnsByMonth. Only 'expense' rows
 * contribute to the first number and only 'income' rows to the second, so
 * transfers and adjustments are invisible here, and summing the listed rows
 * with the same rules always reproduces both numbers.
 */
const SUMMARY_BY_MONTH = `SELECT
   COALESCE(SUM(CASE WHEN t.direction = 'expense' THEN -t.amount_cents ELSE 0 END), 0) AS expense_cents,
   COALESCE(SUM(CASE WHEN t.direction = 'income' THEN t.amount_cents ELSE 0 END), 0) AS income_cents
 FROM txn t
 JOIN account a ON a.id = t.account_id
 WHERE t.deleted_at IS NULL AND t.occurred_date >= ? AND t.occurred_date <= ?`;

export async function monthSummary(
  db: Db,
  monthKey: string
): Promise<{ expenseCents: number; incomeCents: number }> {
  const { start, end } = monthRange(monthKey);
  const row = await db.get<SummaryRow>(SUMMARY_BY_MONTH, [start, end]);
  return {
    expenseCents: row?.expense_cents ?? 0,
    incomeCents: row?.income_cents ?? 0,
  };
}

/** One GROUP BY category row, before the two 未分类 buckets are merged. */
export interface CategoryShareRow {
  category_id: string | null;
  name: string | null;
  cents: number;
}

/**
 * Expense totals per category, largest first. Each null category collapses
 * into the single 未分类 bucket represented by an empty id, so the bucket is
 * stable across months. Summing the buckets equals monthSummary.expenseCents
 * because both queries take the same live expense rows and joins.
 */
const SHARES_BY_MONTH = `SELECT t.category_id AS category_id, c.name AS name,
        SUM(-t.amount_cents) AS cents
 FROM txn t
 JOIN account a ON a.id = t.account_id
 LEFT JOIN category c ON c.id = t.category_id
 WHERE t.deleted_at IS NULL AND t.direction = 'expense'
   AND t.occurred_date >= ? AND t.occurred_date <= ?
 GROUP BY t.category_id
 ORDER BY cents DESC`;

export interface CategoryShare {
  /** '' for 未分类: both a NULL category_id and the system row collapse here. */
  categoryId: string;
  name: string;
  cents: number;
}

/**
 * Merges grouped per-category sums into the shape every screen consumes.
 *
 * Two different values both mean "uncategorised": a NULL category_id (a row
 * written without a category) and the system row's id (a row reflowed there
 * when its category was deleted). They are one bucket to the owner, so merge
 * them here — the GROUP BY cannot, and two 未分类 bars would be a lie.
 *
 * categoryShares and a project's detail share this rule on purpose: a
 * project's 花在哪 must bucket exactly like a month's, or the same expense
 * would change category when it is attached to a trip.
 */
export function mergeCategoryShares(rows: readonly CategoryShareRow[]): CategoryShare[] {
  const merged = new Map<string, CategoryShare>();
  for (const row of rows) {
    const uncategorised = row.category_id === null || row.category_id === UNCATEGORIZED_CATEGORY_ID;
    // The null check lives in uncategorised, which TypeScript will not use to
    // narrow category_id; the fallback is unreachable and keeps the key a string.
    const key = uncategorised ? '' : (row.category_id ?? '');
    const name = uncategorised ? '未分类' : (row.name ?? '');
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { categoryId: key, name, cents: row.cents });
    } else {
      existing.cents += row.cents;
    }
  }

  return [...merged.values()].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
}

export async function categoryShares(db: Db, monthKey: string): Promise<CategoryShare[]> {
  const { start, end } = monthRange(monthKey);
  const rows = await db.all<CategoryShareRow>(SHARES_BY_MONTH, [start, end]);
  return mergeCategoryShares(rows);
}

/**
 * This month's spending per account, in positive integer cents.
 *
 * A pure aggregation over rows the caller already loaded — today that is
 * listTxnsByMonth, which is live-only and scoped to one month. Only
 * direction 'expense' rows count: income, transfers and adjustments move money
 * but are neither spending nor earning. Expense rows are stored negative, so
 * the sign is flipped here and the result stays positive.
 *
 * This is the single implementation of the "本月已用" rule. 统计's per-account
 * usage reads it, and any future budget meter should read the same function
 * rather than re-deriving the rule.
 */
export function sumExpensesByAccount(rows: readonly TxnRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.direction !== 'expense' || row.deletedAt !== null) continue;
    totals.set(row.accountId, (totals.get(row.accountId) ?? 0) - row.amountCents);
  }
  return totals;
}
