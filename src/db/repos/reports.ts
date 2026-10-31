/**
 * Reports: the read-only answer to "where did the money go" and "did I stay
 * inside the budget" for one month or one year.
 *
 * Every number here is derived from live txn rows by the same rules the rest of
 * the app already uses: transfers and adjustments never count as spending or
 * earning, 未分类 merges its two storage forms into one bucket, and budget usage
 * is this month's expense spending per account. Nothing in this module writes.
 *
 * Money stays integer cents end to end. The only divisions produce the integer
 * percentages and the pie angles, both of which are display values from
 * domain/report.
 */
import type { Db } from '../driver';
import { assertDateISO, isMonthKey, monthKeyOf, todayLocalISO } from '../../domain/date';
import { compareByCentsThenName, integerPercents, top3WithRest } from '../../domain/report';
import { listAccounts } from './accounts';
import {
  categoryShares,
  listTxnsByMonth,
  mergeCategoryShares,
  monthSummary,
  sumExpensesByAccount,
} from './txns';
import type { CategoryShare, CategoryShareRow } from './txns';

/** One category's share of a period, with its integer percentage. */
export interface ReportCategory {
  /** '' for 未分类, exactly as categoryShares returns it. */
  categoryId: string;
  name: string;
  /** Positive integer cents. */
  cents: number;
  /** Integer share of the period's spending; all rows add up to 100. */
  percent: number;
}

/**
 * One bar of the twelve-month series.
 *
 * A future month is flagged instead of being flattened to zero: the screen
 * leaves it blank because it has not happened, while a past month with no
 * spending is a real zero and is drawn as one.
 */
export interface MonthPoint {
  /** The YYYY-MM bucket. */
  month: string;
  /** Integer cents spent in that month, 0 when nothing was spent. */
  cents: number;
  /** True for every month after today's month. */
  isFuture: boolean;
}

/** One account's budget for the month, against what was actually spent. */
export interface BudgetActual {
  accountId: string;
  name: string;
  /** account.monthly_budget_cents; never null in this list. */
  budgetCents: number;
  /** Expense spending on that account in this month, via sumExpensesByAccount. */
  spentCents: number;
  /** Strictly above the budget: spending exactly the budget is not over. */
  over: boolean;
}

/** One month chosen as the most or least expensive of a year. */
export interface MonthExtreme {
  month: string;
  cents: number;
}

/** What the month report screen reads in one call. */
export interface MonthReport {
  expenseCents: number;
  incomeCents: number;
  /** Every category, largest first, percentages summing to 100. */
  categories: ReportCategory[];
  /** The three the pie labels, in the same order as categories. */
  top3: ReportCategory[];
  /** The remaining names joined for the 其他 X 通讯 Y 订阅 line; '' when none. */
  restNames: string;
  /** January to December of the month's year. */
  monthlySeries: MonthPoint[];
  /** Live accounts that have a monthly budget, in account order. */
  budgets: BudgetActual[];
}

/** What the year report screen reads in one call. */
export interface YearReport {
  expenseCents: number;
  incomeCents: number;
  categories: ReportCategory[];
  monthlySeries: MonthPoint[];
  /** Null when the year has no spending (or has not started yet). */
  busiestMonth: MonthExtreme | null;
  quietestMonth: MonthExtreme | null;
}

/**
 * The report's calendar reference: the day it considers "today", which decides
 * where the future months start. Production callers omit it and get
 * todayLocalISO, exactly as every screen does; tests pin it.
 */
export interface ReportOptions {
  /** A real YYYY-MM-DD day; defaults to today on the local calendar. */
  today?: string;
}

/** SQL mirrors of the txn repository's summaries, widened to a year. */
const YEAR_SUMMARY = `SELECT
   COALESCE(SUM(CASE WHEN t.direction = 'expense' THEN -t.amount_cents ELSE 0 END), 0) AS expense_cents,
   COALESCE(SUM(CASE WHEN t.direction = 'income' THEN t.amount_cents ELSE 0 END), 0) AS income_cents
 FROM txn t
 JOIN account a ON a.id = t.account_id
 WHERE t.deleted_at IS NULL AND t.occurred_date >= ? AND t.occurred_date <= ?`;

const MONTHLY_EXPENSE = `SELECT substr(t.occurred_date, 1, 7) AS month,
        SUM(-t.amount_cents) AS cents
 FROM txn t
 JOIN account a ON a.id = t.account_id
 WHERE t.deleted_at IS NULL AND t.direction = 'expense'
   AND t.occurred_date >= ? AND t.occurred_date <= ?
 GROUP BY month`;

/**
 * The year's category totals.
 *
 * The WHERE clause is SHARES_BY_MONTH's, only wider, and the rows go through
 * mergeCategoryShares so a null category and the system 未分类 row still collapse
 * into one bucket. One GROUP BY for the whole year is the difference; the
 * grouping key and the bucket rule are shared with the month report.
 */
const YEAR_SHARES = `SELECT t.category_id AS category_id, c.name AS name,
        SUM(-t.amount_cents) AS cents
 FROM txn t
 JOIN account a ON a.id = t.account_id
 LEFT JOIN category c ON c.id = t.category_id
 WHERE t.deleted_at IS NULL AND t.direction = 'expense'
   AND t.occurred_date >= ? AND t.occurred_date <= ?
 GROUP BY t.category_id`;

interface YearSummaryRow {
  expense_cents: number;
  income_cents: number;
}

interface MonthExpenseRow {
  month: string;
  cents: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** A calendar year that can be written as the first four characters of a key. */
function assertYear(year: number): void {
  if (!Number.isSafeInteger(year) || year < 1000 || year > 9999) {
    throw new RangeError(`year must be a four-digit calendar year, received ${year}`);
  }
}

function assertMonthKey(monthKey: string): void {
  if (!isMonthKey(monthKey)) {
    throw new RangeError(`monthKey must be YYYY-MM, received ${monthKey}`);
  }
  assertYear(Number(monthKey.slice(0, 4)));
}

/** Today's month, read from the local calendar unless a test passed a day. */
function currentMonthOf(options: ReportOptions): string {
  const today = options.today ?? todayLocalISO();
  assertDateISO(today);
  return monthKeyOf(today);
}

/** Inclusive first and last day of a year, compared as text like every range. */
function yearRange(yearKey: string): { start: string; end: string } {
  return { start: `${yearKey}-01-01`, end: `${yearKey}-12-31` };
}

/**
 * Turns grouped shares into the report's category rows.
 *
 * The repository's own order (cents descending, then localeCompare) is not
 * reused: percentages are handed out by position, so the tie-break must be the
 * locale-independent one from domain/report or the same month could split
 * differently on two devices. integerPercents also verifies that the shares
 * partition the period total, turning a drifting WHERE clause into a loud
 * error instead of a pie that does not close.
 */
function toReportCategories(
  shares: readonly CategoryShare[],
  totalCents: number
): ReportCategory[] {
  const sorted = [...shares].sort(compareByCentsThenName);
  const percents = integerPercents(
    sorted.map(share => share.cents),
    totalCents
  );
  return sorted.map((share, index) => ({
    categoryId: share.categoryId,
    name: share.name,
    cents: share.cents,
    percent: percents[index],
  }));
}

/**
 * The twelve monthly expense totals of a year.
 *
 * Months that have not happened yet are flagged rather than dropped or zeroed,
 * because a zero and a blank mean different things to the owner. A month is
 * future when its key sorts after today's YYYY-MM key; with four-digit years the
 * plain string comparison is the calendar comparison.
 */
async function monthlySeries(
  db: Db,
  yearKey: string,
  currentMonth: string
): Promise<MonthPoint[]> {
  const { start, end } = yearRange(yearKey);
  const rows = await db.all<MonthExpenseRow>(MONTHLY_EXPENSE, [start, end]);
  const centsByMonth = new Map(rows.map(row => [row.month, row.cents]));
  return Array.from({ length: 12 }, (_, index) => {
    const month = `${yearKey}-${pad2(index + 1)}`;
    return {
      month,
      cents: centsByMonth.get(month) ?? 0,
      isFuture: month > currentMonth,
    };
  });
}

/**
 * This month's budget per live account.
 *
 * The spent side is sumExpensesByAccount over listTxnsByMonth — the one 本月已用
 * rule 统计 already uses — so a transfer leg or an adjustment can never eat a
 * budget. An archived account keeps its history in the totals above but loses
 * its budget row, because the budget is a present intention and the screen only
 * offers live accounts.
 */
async function budgetsForMonth(db: Db, monthKey: string): Promise<BudgetActual[]> {
  const accounts = await listAccounts(db);
  const spentByAccount = sumExpensesByAccount(await listTxnsByMonth(db, monthKey));
  return accounts.flatMap(account => {
    const budgetCents = account.monthlyBudgetCents;
    if (budgetCents === null) return [];
    const spentCents = spentByAccount.get(account.id) ?? 0;
    return [
      {
        accountId: account.id,
        name: account.name,
        budgetCents,
        spentCents,
        over: spentCents > budgetCents,
      },
    ];
  });
}

/**
 * The most and least expensive months that have already happened.
 *
 * Future months are not candidates: every one of them would otherwise be a
 * zero and win 最省 before it even arrives. Real zeros among past months do
 * count, because a month without spending is a fact. Ties go to the earlier
 * month, and a year with no spending at all has no two ends to report.
 */
function extremesOf(series: readonly MonthPoint[]): {
  busiestMonth: MonthExtreme | null;
  quietestMonth: MonthExtreme | null;
} {
  const happened = series.filter(point => !point.isFuture);
  if (!happened.some(point => point.cents > 0)) {
    return { busiestMonth: null, quietestMonth: null };
  }

  let busiest = happened[0];
  let quietest = happened[0];
  for (const point of happened) {
    if (point.cents > busiest.cents) busiest = point;
    if (point.cents < quietest.cents) quietest = point;
  }
  return {
    busiestMonth: { month: busiest.month, cents: busiest.cents },
    quietestMonth: { month: quietest.month, cents: quietest.cents },
  };
}

/**
 * Everything the month view draws, in one read-only pass.
 *
 * Categories and totals come from categoryShares and monthSummary, the same
 * pair 统计 uses, so the report and the stats screen can never disagree about a
 * month. The series is that month's whole year, and the budgets only ever look
 * at this month's expense rows.
 */
export async function monthReport(
  db: Db,
  monthKey: string,
  options: ReportOptions = {}
): Promise<MonthReport> {
  assertMonthKey(monthKey);
  const currentMonth = currentMonthOf(options);

  const summary = await monthSummary(db, monthKey);
  const categories = toReportCategories(
    await categoryShares(db, monthKey),
    summary.expenseCents
  );
  const top = top3WithRest(categories);

  return {
    expenseCents: summary.expenseCents,
    incomeCents: summary.incomeCents,
    categories,
    top3: top.top,
    restNames: top.restNames,
    monthlySeries: await monthlySeries(db, monthKey.slice(0, 4), currentMonth),
    budgets: await budgetsForMonth(db, monthKey),
  };
}

/**
 * Everything the year view draws: the year's pie, its twelve bars and the two
 * months at the ends.
 *
 * The pie reuses SHARES_BY_MONTH's filters through YEAR_SHARES and the same
 * mergeCategoryShares rule; the totals reuse SUMMARY_BY_MONTH's direction
 * narrowing. A future month still contributes to the year total if a row was
 * dated there — the money is recorded — but it is excluded from 最贵/最省, and
 * the screen leaves its bar blank like the month view does.
 */
export async function yearReport(
  db: Db,
  year: number,
  options: ReportOptions = {}
): Promise<YearReport> {
  assertYear(year);
  const currentMonth = currentMonthOf(options);
  const yearKey = String(year);
  const { start, end } = yearRange(yearKey);

  const summary = await db.get<YearSummaryRow>(YEAR_SUMMARY, [start, end]);
  const expenseCents = summary?.expense_cents ?? 0;
  const incomeCents = summary?.income_cents ?? 0;

  const shareRows = await db.all<CategoryShareRow>(YEAR_SHARES, [start, end]);
  const categories = toReportCategories(mergeCategoryShares(shareRows), expenseCents);
  const monthlySeriesPoints = await monthlySeries(db, yearKey, currentMonth);
  const { busiestMonth, quietestMonth } = extremesOf(monthlySeriesPoints);

  return {
    expenseCents,
    incomeCents,
    categories,
    monthlySeries: monthlySeriesPoints,
    busiestMonth,
    quietestMonth,
  };
}
