import { isMonthKey, monthKeyOf, todayLocalISO } from '../../domain/date';
import type { Db } from '../driver';

type BudgetChange = [month: string, cents: number | null];

// One timeline per account, carried by the existing portable backup table.
const KEY_PREFIX = 'account-budget-months:';

function isBudgetChange(value: unknown): value is BudgetChange {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [month, cents] = value;
  return typeof month === 'string' && isMonthKey(month) &&
    (cents === null || Number.isSafeInteger(cents));
}

function readChanges(raw: string | null | undefined): BudgetChange[] {
  if (raw == null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter(isBudgetChange).sort(([left], [right]) => left.localeCompare(right))
      : [];
  } catch {
    return [];
  }
}

/** undefined means the month predates any record; null means explicitly unset. */
export function budgetForMonth(
  changes: readonly BudgetChange[],
  month: string
): number | null | undefined {
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    if (changes[index][0] <= month) return changes[index][1];
  }
  return undefined;
}

export async function readAccountBudgetHistories(db: Db): Promise<Map<string, BudgetChange[]>> {
  const rows = await db.all<{ key: string; value: string }>(
    'SELECT key, value FROM app_meta WHERE key GLOB ?', [KEY_PREFIX + '*']
  );
  return new Map(rows.map(row => [row.key.slice(KEY_PREFIX.length), readChanges(row.value)]));
}

async function writeBudgetChange(
  db: Db,
  accountId: string,
  history: BudgetChange[],
  month: string,
  cents: number | null
): Promise<void> {
  const changes = history.filter(([effective]) => effective < month);
  changes.push([month, cents]);
  await db.run(
    'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [KEY_PREFIX + accountId, JSON.stringify(changes)]
  );
}

/** Persist alongside the current account value, using the caller's transaction. */
export async function recordAccountBudget(
  db: Db,
  accountId: string,
  month: string,
  cents: number | null
): Promise<void> {
  const row = await db.get<{ value: string }>(
    'SELECT value FROM app_meta WHERE key = ?', [KEY_PREFIX + accountId]
  );
  await writeBudgetChange(db, accountId, readChanges(row?.value), month, cents);
}

export async function deleteAccountBudgetHistory(db: Db, accountId: string): Promise<void> {
  await db.run('DELETE FROM app_meta WHERE key = ?', [KEY_PREFIX + accountId]);
}

/** A legacy ledger exposes only its latest values. Start recording in this month. */
export async function initializeAccountBudgetHistory(
  db: Db,
  month = monthKeyOf(todayLocalISO())
): Promise<void> {
  await db.transaction(async tx => {
    const rows = await tx.all<{ id: string; monthly_budget_cents: number | null; value: string | null }>(
      `SELECT a.id, a.monthly_budget_cents, m.value FROM account a
       LEFT JOIN app_meta m ON m.key = ? || a.id`,
      [KEY_PREFIX]
    );
    for (const row of rows) {
      const changes = readChanges(row.value);
      // A compatible older app might have edited the current value after restore.
      if (changes.at(-1)?.[1] === row.monthly_budget_cents) continue;
      await writeBudgetChange(tx, row.id, changes, month, row.monthly_budget_cents);
    }
  });
}
