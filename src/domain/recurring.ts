/**
 * 固定支出 detection, as pure functions.
 *
 * The rule is fixed by docs/superpowers/plans/2026-10-24-E-固定支出.md and is
 * deliberately conservative — 宁可漏报，不误报. A stretch of bills counts as
 * recurring only when all three hold:
 *
 *   1. every gap between neighbouring bills is 25–35 days, inclusive;
 *   2. every amount is within 15% of that stretch's median;
 *   3. the stretch holds at least 3 bills.
 *
 * A stretch is a maximal run of neighbours that pass the gap test, so one
 * odd bill breaks the chain instead of being quietly skipped, and an amount
 * jump rejects the whole stretch rather than shrinking it to the part that
 * still looks tidy. When a group has several qualifying stretches the most
 * recent one wins.
 *
 * Nothing here reads a database, a clock or a time zone: the caller passes the
 * rows and gets back plain data, which is what makes the rule unit-testable
 * without SQLite.
 */
import {
  assertDateISO,
  daysBetweenISO,
  monthKeyOf,
  monthRange,
  shiftMonthKey,
} from './date';

/**
 * One live expense, already filtered by the caller: soft-deleted rows, income,
 * transfers and adjustments never reach this module.
 *
 * amountCents is the spending magnitude (positive integer cents), not the
 * signed column: txn stores expenses negative, and the sign has no meaning to
 * a detector that only compares bills with each other.
 */
export interface RecurringRow {
  id: string;
  /** Calendar day the bill happened, YYYY-MM-DD. */
  occurredDate: string;
  /** Positive integer cents, the amount the account lost. */
  amountCents: number;
  categoryId: string | null;
  payee: string | null;
}

/** The thresholds a caller may move; the defaults are the contract's numbers. */
export interface RecurringOptions {
  /** Inclusive lower bound of the day gap between two bills. Default 25. */
  minGapDays?: number;
  /** Inclusive upper bound. Default 35. */
  maxGapDays?: number;
  /** Allowed deviation from the run's median, in whole percent. Default 15. */
  tolerancePercent?: number;
  /** Fewest bills a run may hold. Default 3. */
  minOccurrences?: number;
  /** Category display names, so a run without a payee can still be named. */
  categoryNames?: Readonly<Record<string, string>>;
}

/** The contract's numbers, and the only copy of them. */
export const RECURRING_DEFAULTS = {
  minGapDays: 25,
  maxGapDays: 35,
  tolerancePercent: 15,
  minOccurrences: 3,
} as const;

/** One detected repeating bill, oldest bill first inside txnIds. */
export interface RecurringRun {
  categoryId: string | null;
  /** Trimmed payee, or null when the bills carry none. */
  payee: string | null;
  /** payee, else the category name, else '' when neither is known. */
  name: string;
  /** The rows of the run, oldest first — the rows a confirm would flag. */
  txnIds: string[];
  firstDate: string;
  lastDate: string;
  /** lastDate plus one month, clamped to the end of that month. */
  nextDate: string;
  occurrences: number;
  /** The last bill's amount: what the next month is expected to cost. */
  monthlyCents: number;
}

type ResolvedOptions = Required<Omit<RecurringOptions, 'categoryNames'>> &
  Pick<RecurringOptions, 'categoryNames'>;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The next expected bill date: one calendar month after `dateISO`, clamped to
 * the last day of that month so 1月31日 becomes 2月28日 (or 2月29日 in a leap
 * year) and never slides into March.
 *
 * Month arithmetic goes through the ledger's own helpers (shiftMonthKey and
 * monthRange) rather than a Date object, so the result is a local calendar
 * day on every device and a malformed input throws instead of rolling over.
 */
export function monthEndClampedPlusOneMonth(dateISO: string): string {
  assertDateISO(dateISO);
  const day = Number(dateISO.slice(8, 10));
  const nextMonth = shiftMonthKey(monthKeyOf(dateISO), 1);
  const lastDay = Number(monthRange(nextMonth).end.slice(8, 10));
  return `${nextMonth}-${pad2(Math.min(day, lastDay))}`;
}

/** A blank or whitespace-only payee is no payee: it cannot name an identity. */
function normalizePayee(payee: string | null): string | null {
  if (payee === null) return null;
  const trimmed = payee.trim();
  return trimmed === '' ? null : trimmed;
}

/** Reads the options once, refusing values that would make the rule nonsense. */
function resolveOptions(opts: RecurringOptions): ResolvedOptions {
  const minGapDays = opts.minGapDays ?? RECURRING_DEFAULTS.minGapDays;
  const maxGapDays = opts.maxGapDays ?? RECURRING_DEFAULTS.maxGapDays;
  const tolerancePercent = opts.tolerancePercent ?? RECURRING_DEFAULTS.tolerancePercent;
  const minOccurrences = opts.minOccurrences ?? RECURRING_DEFAULTS.minOccurrences;

  for (const [name, value] of [
    ['minGapDays', minGapDays],
    ['maxGapDays', maxGapDays],
    ['tolerancePercent', tolerancePercent],
    ['minOccurrences', minOccurrences],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer, received ${value}`);
    }
  }
  if (minGapDays > maxGapDays) {
    throw new RangeError(
      `minGapDays must not exceed maxGapDays, received ${minGapDays} and ${maxGapDays}`
    );
  }
  if (minOccurrences < 1) {
    throw new RangeError(`minOccurrences must be at least 1, received ${minOccurrences}`);
  }

  return { minGapDays, maxGapDays, tolerancePercent, minOccurrences, categoryNames: opts.categoryNames };
}

/**
 * Twice the median amount, which is an integer even for an even-sized run.
 *
 * Keeping the median doubled is what makes the 15% test exact: comparing cents
 * with 1.15 or 0.85 in floating point would put the boundary at the mercy of
 * rounding, and 15% versus 16% has to be a hard line.
 */
function doubledMedian(amounts: readonly number[]): number {
  const sorted = [...amounts].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] * 2 : sorted[middle - 1] + sorted[middle];
}

/** True when every amount is within `tolerancePercent` of the median. */
function withinTolerance(amounts: readonly number[], tolerancePercent: number): boolean {
  const median2 = doubledMedian(amounts);
  return amounts.every(
    amount => Math.abs(amount * 2 - median2) * 100 <= median2 * tolerancePercent
  );
}

interface Group {
  categoryId: string | null;
  payee: string | null;
  rows: RecurringRow[];
}

/** One identity per (category, payee): the unit a prompt and a decision share. */
function groupKey(categoryId: string | null, payee: string | null): string {
  return JSON.stringify([categoryId, payee]);
}

/**
 * Splits one identity's bills into maximal gap-chains.
 *
 * A chain ends wherever a gap leaves 25–35 days, and a new one starts with the
 * next bill — including a bill dated the same day as the previous one, whose
 * gap of zero is just as disqualifying as a 90-day hole.
 */
function splitChains(rows: readonly RecurringRow[], options: ResolvedOptions): RecurringRow[][] {
  const chains: RecurringRow[][] = [];
  let chain: RecurringRow[] = [];

  for (const row of rows) {
    const previous = chain.at(-1);
    if (previous !== undefined) {
      const gap = daysBetweenISO(previous.occurredDate, row.occurredDate);
      if (gap < options.minGapDays || gap > options.maxGapDays) {
        chains.push(chain);
        chain = [];
      }
    }
    chain.push(row);
  }
  if (chain.length > 0) chains.push(chain);

  return chains;
}

function toRun(
  group: Group,
  chain: readonly RecurringRow[],
  options: ResolvedOptions
): RecurringRun {
  const last = chain[chain.length - 1];
  const categoryName =
    group.categoryId === null ? null : (options.categoryNames?.[group.categoryId] ?? null);

  return {
    categoryId: group.categoryId,
    payee: group.payee,
    name: group.payee ?? categoryName ?? '',
    txnIds: chain.map(row => row.id),
    firstDate: chain[0].occurredDate,
    lastDate: last.occurredDate,
    nextDate: monthEndClampedPlusOneMonth(last.occurredDate),
    occurrences: chain.length,
    monthlyCents: last.amountCents,
  };
}

/**
 * Every identity that looks like a repeating bill, one run each.
 *
 * Rows are grouped by category and then by payee, because two different bills
 * can share a category (校园网 and 话费 both land in 通讯) while a payee names
 * one bill exactly. Within a group the most recent qualifying chain wins;
 * older stretches are history, not another candidate.
 *
 * Returns the runs ordered newest bill first, then by identity, so the list a
 * screen shows never depends on object insertion order.
 */
export function findRecurringRuns(
  rows: readonly RecurringRow[],
  opts: RecurringOptions = {}
): RecurringRun[] {
  const options = resolveOptions(opts);

  for (const row of rows) {
    assertDateISO(row.occurredDate);
    if (!Number.isSafeInteger(row.amountCents) || row.amountCents < 0) {
      throw new RangeError(
        `amountCents must be a non-negative integer number of cents, received ${row.amountCents}`
      );
    }
  }

  const groups = new Map<string, Group>();
  for (const row of rows) {
    const payee = normalizePayee(row.payee);
    const key = groupKey(row.categoryId, payee);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { categoryId: row.categoryId, payee, rows: [row] });
    } else {
      group.rows.push(row);
    }
  }

  const runs: RecurringRun[] = [];
  for (const group of groups.values()) {
    // Oldest first, id as the tiebreak so the same ledger always yields the
    // same run and the same preview names.
    const ordered = [...group.rows].sort(
      (left, right) =>
        left.occurredDate.localeCompare(right.occurredDate) || left.id.localeCompare(right.id)
    );

    let qualifying: RecurringRow[] | null = null;
    for (const chain of splitChains(ordered, options)) {
      if (chain.length < options.minOccurrences) continue;
      if (!withinTolerance(chain.map(row => row.amountCents), options.tolerancePercent)) continue;
      // Chains arrive in date order, so the last one that qualifies is the
      // most recent stretch — the candidate the contract asks for.
      qualifying = chain;
    }
    if (qualifying !== null) runs.push(toRun(group, qualifying, options));
  }

  return runs.sort(
    (left, right) =>
      right.lastDate.localeCompare(left.lastDate) ||
      (left.categoryId ?? '').localeCompare(right.categoryId ?? '') ||
      (left.payee ?? '').localeCompare(right.payee ?? '')
  );
}
