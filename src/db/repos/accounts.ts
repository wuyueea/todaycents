import type { Db, DbParam } from '../driver';
import { newId } from '../id';
import type { Account, AccountType } from '../../domain/types';
import { localDateISO, monthKeyOf, todayLocalISO } from '../../domain/date';
import { deleteAccountBudgetHistory, recordAccountBudget } from './accountBudgets';
import { recordAdjustment } from './txns';

/** Everything createAccount needs; money values are integer cents. */
export interface CreateAccountInput {
  name: string;
  type: AccountType;
  initialBalanceCents?: number;
  monthlyBudgetCents?: number | null;
  /** Explicit position; when omitted, appended as max(sort)+1. */
  sort?: number;
}

export type UpdateAccountPatch = Partial<
  Pick<Account, 'name' | 'type' | 'monthlyBudgetCents' | 'sort' | 'initialBalanceCents'>
>;

/** Raw account row; the only shape that knows about snake_case columns. */
interface AccountRow {
  id: string;
  name: string;
  type: AccountType;
  initial_balance_cents: number;
  monthly_budget_cents: number | null;
  sort: number;
  archived_at: string | null;
  created_at: string;
}

const ACCOUNT_COLUMNS =
  'id, name, type, initial_balance_cents, monthly_budget_cents, sort, archived_at, created_at';

export const EMPTY_ACCOUNTS_META_KEY = 'accounts-intentionally-empty';

const UPDATABLE_COLUMNS: Record<keyof UpdateAccountPatch, string> = {
  name: 'name',
  type: 'type',
  monthlyBudgetCents: 'monthly_budget_cents',
  sort: 'sort',
  initialBalanceCents: 'initial_balance_cents',
};

/** Guards the integer-cents invariant at the repository boundary. */
function assertIntegerCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be integer cents, received ${value}`);
  }
}

/** Single row-to-object mapping; nothing else touches raw column names. */
function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    initialBalanceCents: row.initial_balance_cents,
    monthlyBudgetCents: row.monthly_budget_cents,
    sort: row.sort,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  };
}

/** Next append position, considering archived accounts so they keep their slot. */
async function nextSort(db: Db): Promise<number> {
  const row = await db.get<{ next_sort: number }>(
    'SELECT COALESCE(MAX(sort), -1) + 1 AS next_sort FROM account'
  );
  return row?.next_sort ?? 0;
}

export async function createAccount(db: Db, input: CreateAccountInput): Promise<string> {
  const initialBalanceCents = input.initialBalanceCents ?? 0;
  assertIntegerCents(initialBalanceCents, 'initialBalanceCents');

  const monthlyBudgetCents = input.monthlyBudgetCents ?? null;
  if (monthlyBudgetCents !== null) {
    assertIntegerCents(monthlyBudgetCents, 'monthlyBudgetCents');
  }

  return db.transaction(async tx => {
    const sort = input.sort ?? (await nextSort(tx));
    const id = newId();
    const createdAt = new Date();

    await tx.run(
      `INSERT INTO account
         (id, name, type, initial_balance_cents, monthly_budget_cents, sort, archived_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      [id, input.name, input.type, initialBalanceCents, monthlyBudgetCents, sort, createdAt.toISOString()]
    );
    await recordAccountBudget(tx, id, monthKeyOf(localDateISO(createdAt)), monthlyBudgetCents);
    return id;
  });
}

export async function listAccounts(
  db: Db,
  opts: { includeArchived?: boolean } = {}
): Promise<Account[]> {
  const archivedFilter = opts.includeArchived ? '' : 'WHERE archived_at IS NULL';
  const rows = await db.all<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM account ${archivedFilter} ORDER BY sort, created_at`
  );
  return rows.map(toAccount);
}

/** Saves the visible order while keeping archived accounts in their existing slots. */
export async function reorderActiveAccounts(
  db: Db,
  ids: readonly string[],
  previousIds: readonly string[]
): Promise<void> {
  await db.transaction(async tx => {
    const all = await listAccounts(tx, { includeArchived: true });
    const activeIds = all.filter(account => account.archivedAt === null).map(account => account.id);
    if (activeIds.length !== previousIds.length || activeIds.some((id, index) => id !== previousIds[index])) {
      throw new Error('账户列表已变化，请重新排序。');
    }
    const requested = new Set(ids);
    if (ids.length !== activeIds.length || requested.size !== activeIds.length ||
        activeIds.some(id => !requested.has(id))) {
      throw new Error('账户顺序不完整，请重新排序。');
    }
    if (ids.every((id, index) => id === activeIds[index])) return;

    const byId = new Map(all.map(account => [account.id, account]));
    let nextActive = 0;
    for (const [sort, account] of all.entries()) {
      const id = account.archivedAt === null ? ids[nextActive++] : account.id;
      if (byId.get(id)?.sort !== sort) {
        await tx.run('UPDATE account SET sort = ? WHERE id = ?', [sort, id]);
      }
    }
  });
}

/**
 * Updates the editable columns of one account.
 *
 * The opening balance is only correctable while the account has no transaction
 * rows at all — deleted rows included. Once history exists, changing the
 * opening balance would silently rewrite every past month's closing figure;
 * the supported correction is a dated adjustment through
 * reconcileAccountBalance. The guard runs before the UPDATE, so a refused call
 * changes nothing.
 */
export async function updateAccount(
  db: Db,
  id: string,
  patch: UpdateAccountPatch
): Promise<void> {
  if (patch.monthlyBudgetCents !== undefined && patch.monthlyBudgetCents !== null) {
    assertIntegerCents(patch.monthlyBudgetCents, 'monthlyBudgetCents');
  }
  if (patch.initialBalanceCents !== undefined) {
    assertIntegerCents(patch.initialBalanceCents, 'initialBalanceCents');
  }

  const sets: string[] = [];
  const params: DbParam[] = [];
  for (const key of Object.keys(UPDATABLE_COLUMNS) as Array<keyof UpdateAccountPatch>) {
    const value = patch[key];
    if (value === undefined) continue;
    sets.push(`${UPDATABLE_COLUMNS[key]} = ?`);
    params.push(value);
  }
  if (sets.length === 0) return;

  await db.transaction(async tx => {
    if (patch.initialBalanceCents !== undefined) {
      const row = await tx.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM txn WHERE account_id = ?', [id]
      );
      if ((row?.n ?? 0) > 0) {
        throw new Error(
          `cannot change the opening balance of account ${id}: it already has transactions; use an adjustment instead`
        );
      }
    }
    const budget = patch.monthlyBudgetCents;
    const previous = budget === undefined ? undefined : await tx.get<{ monthly_budget_cents: number | null }>(
      'SELECT monthly_budget_cents FROM account WHERE id = ?', [id]
    );
    const effectiveMonth = monthKeyOf(todayLocalISO());

    await tx.run(`UPDATE account SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    if (budget !== undefined && previous !== undefined && previous.monthly_budget_cents !== budget) {
      await recordAccountBudget(tx, id, effectiveMonth, budget);
    }
  });
}

/** Soft-hides an account. The row and its transactions are never deleted. */
export async function archiveAccount(db: Db, id: string): Promise<void> {
  await db.run('UPDATE account SET archived_at = COALESCE(archived_at, ?) WHERE id = ?', [
    new Date().toISOString(),
    id,
  ]);
}

/**
 * Puts an archived account back into the live list.
 *
 * This is the undo for archiveAccount: archived_at returns to NULL, the row and
 * every transaction are untouched, and the derived balance is unchanged because
 * it never depended on archived_at. Idempotent on an account that is live.
 */
export async function unarchiveAccount(db: Db, id: string): Promise<void> {
  await db.run('UPDATE account SET archived_at = NULL WHERE id = ?', [id]);
}

/** Account defaults are retained in legacy templates and in backups. */
export async function accountIdsInLegacyTemplates(db: Db): Promise<Set<string>> {
  const rows = await db.all<{ account_id: string }>(
    `SELECT DISTINCT default_account_id AS account_id FROM template
      WHERE default_account_id IS NOT NULL`
  );
  return new Set(rows.map(row => row.account_id));
}

/** Removes an unreferenced account and its settings as a single write. */
export async function deleteAccount(db: Db, id: string): Promise<void> {
  await db.transaction(async tx => {
    const account = await tx.get<{ name: string; has_txn: number; has_template: number }>(
      `SELECT a.name,
          EXISTS (SELECT 1 FROM txn WHERE account_id = a.id) AS has_txn,
          EXISTS (SELECT 1 FROM template WHERE default_account_id = a.id) AS has_template
        FROM account a WHERE a.id = ?`,
      [id]
    );
    if (account === undefined) throw new Error('这个账户已不存在。');
    if (account.has_txn) throw new Error(`账户「${account.name}」有流水历史，请使用归档。`);
    if (account.has_template) throw new Error(`账户「${account.name}」仍被旧模板引用，请使用归档。`);

    await tx.run('DELETE FROM account WHERE id = ?', [id]);
    await deleteAccountBudgetHistory(tx, id);
    await tx.run(
      `INSERT OR IGNORE INTO app_meta (key, value)
       SELECT ?, '1' WHERE NOT EXISTS (SELECT 1 FROM account)`,
      [EMPTY_ACCOUNTS_META_KEY]
    );
  });
}

/**
 * How many transaction rows each account has, deleted rows included.
 *
 * The accounts screen uses this to decide whether the opening balance may still
 * be edited. It is one aggregate query rather than one query per row, and it
 * deliberately does not filter deleted_at: a soft-deleted row is still history
 * and still freezes the opening balance.
 */
export async function txnCountByAccount(db: Db): Promise<Record<string, number>> {
  const rows = await db.all<{ account_id: string; n: number }>(
    'SELECT account_id, COUNT(*) AS n FROM txn GROUP BY account_id'
  );
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.account_id] = row.n;
  return counts;
}

/** What a reconciliation did: the delta and the adjustment row, if one was written. */
export interface ReconcileAccountResult {
  /** actualBalanceCents - accountBalance, in signed integer cents. */
  deltaCents: number;
  /** Id of the adjustment row; null when the balances already matched. */
  adjustmentId: string | null;
}

/**
 * Corrects one account to the balance the user sees in real life.
 *
 * The current balance is read from accountBalance, the same SUM every screen
 * displays, and the delta is computed here rather than in a component. A zero
 * delta writes nothing and is reported so the screen can say the balance
 * already matches. Anything else becomes one dated 'adjust' row with the
 * standard 对账差额 note. Read and write share a transaction so SerialDb
 * orders the whole calculation against other saves and reconciliations.
 */
export async function reconcileAccountBalance(
  db: Db,
  input: {
    date: string;
    accountId: string;
    /** The real-world balance in integer cents; 0 is allowed. */
    actualBalanceCents: number;
    note?: string;
  }
): Promise<ReconcileAccountResult> {
  if (!Number.isSafeInteger(input.actualBalanceCents) || input.actualBalanceCents < 0) {
    throw new RangeError(
      `actualBalanceCents must be a non-negative integer number of cents, received ${input.actualBalanceCents}`
    );
  }

  return db.transaction(async (tx) => {
    const currentCents = await accountBalance(tx, input.accountId);
    const deltaCents = input.actualBalanceCents - currentCents;
    if (deltaCents === 0) return { deltaCents: 0, adjustmentId: null };

    const adjustmentId = await recordAdjustment(tx, {
      date: input.date,
      accountId: input.accountId,
      deltaCents,
      note: input.note ?? '对账差额',
    });
    return { deltaCents, adjustmentId };
  });
}

export async function accountBalance(db: Db, accountId: string): Promise<number> {
  const row = await db.get<{ bal: number }>(
    `SELECT a.initial_balance_cents + COALESCE(SUM(t.amount_cents), 0) AS bal
     FROM account a
     LEFT JOIN txn t ON t.account_id = a.id AND t.deleted_at IS NULL
     WHERE a.id = ?
     GROUP BY a.id`,
    [accountId]
  );
  if (row === undefined) {
    throw new Error(`account not found: ${accountId}`);
  }
  return row.bal;
}

export async function allBalances(db: Db): Promise<Record<string, number>> {
  const rows = await db.all<{ id: string; bal: number }>(
    `SELECT a.id AS id,
            a.initial_balance_cents + COALESCE(SUM(t.amount_cents), 0) AS bal
     FROM account a
     LEFT JOIN txn t ON t.account_id = a.id AND t.deleted_at IS NULL
     GROUP BY a.id`
  );
  const balances: Record<string, number> = {};
  for (const row of rows) balances[row.id] = row.bal;
  return balances;
}
