import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import { archiveAccount, createAccount } from '../../src/db/repos/accounts';
import { createCategory } from '../../src/db/repos/categories';
import {
  createExpense,
  createIncome,
  recordAdjustment,
} from '../../src/db/repos/txns';
import { createTransfer } from '../../src/db/repos/transfers';
import { UNCATEGORIZED_CATEGORY_ID } from '../../src/db/schema';
import type { Db, DbParam } from '../../src/db/driver';
import { monthReport, yearReport } from '../../src/db/repos/reports';
import type { MonthPoint } from '../../src/db/repos/reports';

/**
 * The twelve points a series must contain, with the months after `today`
 * flagged rather than zeroed. `futureFrom` is the first month that has not
 * happened yet (13 for a fully past year).
 */
function expectedSeries(
  year: number,
  centsByMonth: Partial<Record<number, number>>,
  futureFrom: number
): MonthPoint[] {
  return Array.from({ length: 12 }, (_, index) => {
    const monthNumber = index + 1;
    const month = year + '-' + String(monthNumber).padStart(2, '0');
    return {
      month,
      cents: centsByMonth[monthNumber] ?? 0,
      isFuture: monthNumber >= futureFrom,
    };
  });
}

async function fixture() {
  const db = await createTestDb();
  const card = await createAccount(db, {
    name: '饭卡',
    type: 'prepaid',
    monthlyBudgetCents: 30000,
  });
  const bank = await createAccount(db, { name: '银行卡', type: 'bank' });
  const food = await createCategory(db, { name: '饮食', kind: 'expense' });
  const daily = await createCategory(db, { name: '日用', kind: 'expense' });
  const transport = await createCategory(db, { name: '交通', kind: 'expense' });
  const subscription = await createCategory(db, { name: '订阅', kind: 'expense' });
  const salary = await createCategory(db, { name: '生活费', kind: 'income' });
  return { db, card, bank, food, daily, transport, subscription, salary };
}

describe('monthReport', () => {
  it('answers where the money went for one month', async () => {
    const { db, card, bank, food, daily, transport, subscription, salary } =
      await fixture();

    await createExpense(db, { date: '2026-10-01', accountId: card, amountCents: 1230, categoryId: food });
    await createExpense(db, { date: '2026-10-02', accountId: card, amountCents: 1060, categoryId: food });
    await createExpense(db, { date: '2026-10-03', accountId: card, amountCents: 2675, categoryId: transport });
    await createExpense(db, { date: '2026-10-04', accountId: card, amountCents: 1000, categoryId: subscription });
    await createExpense(db, { date: '2026-10-05', accountId: card, amountCents: 350, categoryId: daily });
    await createIncome(db, { date: '2026-10-06', accountId: card, amountCents: 100000, categoryId: salary });
    await createTransfer(db, {
      date: '2026-10-07',
      fromAccountId: card,
      toAccountId: bank,
      amountCents: 5000,
    });
    await recordAdjustment(db, {
      date: '2026-10-08',
      accountId: card,
      deltaCents: -700,
      note: '对账差额',
    });
    // Neighbours: one row in the month before, one in the year before, one
    // dated in a month that has not happened yet.
    await createExpense(db, { date: '2026-09-30', accountId: card, amountCents: 111, categoryId: food });
    await createExpense(db, { date: '2025-12-31', accountId: card, amountCents: 999, categoryId: food });
    await createExpense(db, { date: '2026-11-01', accountId: card, amountCents: 500, categoryId: food });

    const report = await monthReport(db, '2026-10', { today: '2026-10-20' });

    expect(report.expenseCents).toBe(6315);
    expect(report.incomeCents).toBe(100000);
    // Only expense rows: transfers, adjustments and income never reach a pie.
    expect(report.categories).toEqual([
      { categoryId: transport, name: '交通', cents: 2675, percent: 42 },
      { categoryId: food, name: '饮食', cents: 2290, percent: 36 },
      { categoryId: subscription, name: '订阅', cents: 1000, percent: 16 },
      { categoryId: daily, name: '日用', cents: 350, percent: 6 },
    ]);
    expect(report.categories.reduce((sum, row) => sum + row.percent, 0)).toBe(100);
    expect(report.categories.reduce((sum, row) => sum + row.cents, 0)).toBe(report.expenseCents);
    expect(report.top3.map(row => row.name)).toEqual(['交通', '饮食', '订阅']);
    expect(report.top3.map(row => row.percent)).toEqual([42, 36, 16]);
    expect(report.restNames).toBe('日用');

    // The series belongs to the year of the month: October is this month, the
    // one expense dated in November is flagged future rather than wiped, and
    // the previous month carries its own real total.
    expect(report.monthlySeries).toEqual(
      expectedSeries(2026, { 9: 111, 10: 6315, 11: 500 }, 11)
    );

    // Budget spending follows sumExpensesByAccount: only this month's expense
    // rows on that account (transfer legs and adjustments do not spend).
    expect(report.budgets).toEqual([
      { accountId: card, name: '饭卡', budgetCents: 30000, spentCents: 6315, over: false },
    ]);
  });

  it('flags future months without inventing or erasing their cents', async () => {
    const { db, card, food } = await fixture();
    await createExpense(db, { date: '2026-10-01', accountId: card, amountCents: 100, categoryId: food });
    await createExpense(db, { date: '2026-12-01', accountId: card, amountCents: 700, categoryId: food });

    const report = await monthReport(db, '2026-10', { today: '2026-10-20' });

    expect(report.monthlySeries[9]).toEqual({ month: '2026-10', cents: 100, isFuture: false });
    expect(report.monthlySeries[10]).toEqual({ month: '2026-11', cents: 0, isFuture: true });
    expect(report.monthlySeries[11]).toEqual({ month: '2026-12', cents: 700, isFuture: true });
    // A past month with no rows is a real zero, not a blank.
    expect(report.monthlySeries[0]).toEqual({ month: '2026-01', cents: 0, isFuture: false });
  });

  it('marks every month in the future when the whole year is still ahead', async () => {
    const { db } = await fixture();
    const report = await monthReport(db, '2027-03', { today: '2026-10-20' });
    expect(report.monthlySeries).toEqual(expectedSeries(2027, {}, 1));
  });

  it('compares budget with actual spending, over only when strictly above it', async () => {
    const db = await createTestDb();
    const card = await createAccount(db, { name: '饭卡', type: 'prepaid', monthlyBudgetCents: 30000 });
    const wallet = await createAccount(db, { name: '微信', type: 'ewallet', monthlyBudgetCents: 5000 });
    const bank = await createAccount(db, { name: '银行卡', type: 'bank' });
    const old = await createAccount(db, { name: '旧卡', type: 'bank', monthlyBudgetCents: 10000 });
    const food = await createCategory(db, { name: '饮食', kind: 'expense' });

    await createExpense(db, { date: '2026-10-01', accountId: card, amountCents: 32000, categoryId: food });
    await createExpense(db, { date: '2026-09-15', accountId: card, amountCents: 10000, categoryId: food });
    await createExpense(db, { date: '2026-10-02', accountId: wallet, amountCents: 5000, categoryId: food });
    await createExpense(db, { date: '2026-10-03', accountId: bank, amountCents: 999, categoryId: food });
    await createExpense(db, { date: '2026-10-04', accountId: old, amountCents: 500, categoryId: food });
    await archiveAccount(db, old);

    const report = await monthReport(db, '2026-10', { today: '2026-10-20' });
    expect(report.budgets).toEqual([
      { accountId: card, name: '饭卡', budgetCents: 30000, spentCents: 32000, over: true },
      { accountId: wallet, name: '微信', budgetCents: 5000, spentCents: 5000, over: false },
    ]);
    // Retiring the old account hides its budget, never its spending.
    expect(report.expenseCents).toBe(38499);
    expect(report.categories).toEqual([
      { categoryId: food, name: '饮食', cents: 38499, percent: 100 },
    ]);

    // A past month reads that month's spending, not October's.
    const september = await monthReport(db, '2026-09', { today: '2026-10-20' });
    expect(september.budgets).toEqual([
      { accountId: card, name: '饭卡', budgetCents: 30000, spentCents: 10000, over: false },
      { accountId: wallet, name: '微信', budgetCents: 5000, spentCents: 0, over: false },
    ]);
  });

  it('keeps the month shape on an empty month', async () => {
    const { db, card } = await fixture();
    const report = await monthReport(db, '2026-01', { today: '2026-10-20' });
    expect(report).toEqual({
      expenseCents: 0,
      incomeCents: 0,
      categories: [],
      top3: [],
      restNames: '',
      monthlySeries: expectedSeries(2026, {}, 11),
      budgets: [
        { accountId: card, name: '饭卡', budgetCents: 30000, spentCents: 0, over: false },
      ],
    });
  });

  it('has no budget rows when no live account carries a budget', async () => {
    const db = await createTestDb();
    const cash = await createAccount(db, { name: '现金', type: 'cash' });
    const food = await createCategory(db, { name: '饮食', kind: 'expense' });
    await createExpense(db, { date: '2026-10-01', accountId: cash, amountCents: 100, categoryId: food });

    const report = await monthReport(db, '2026-10', { today: '2026-10-20' });
    expect(report.budgets).toEqual([]);
    expect(report.expenseCents).toBe(100);
  });

  it('merges a null category and the system category into one 未分类 bucket', async () => {
    const { db, card } = await fixture();
    await createExpense(db, { date: '2026-10-01', accountId: card, amountCents: 700, categoryId: null });
    await createExpense(db, {
      date: '2026-10-02',
      accountId: card,
      amountCents: 300,
      categoryId: UNCATEGORIZED_CATEGORY_ID,
    });

    const report = await monthReport(db, '2026-10', { today: '2026-10-20' });
    expect(report.categories).toEqual([
      { categoryId: '', name: '未分类', cents: 1000, percent: 100 },
    ]);
    expect(report.top3.map(row => row.name)).toEqual(['未分类']);
    expect(report.restNames).toBe('');
  });

  it('orders equal cents by name and gives the leftover point to the first', async () => {
    const { db, card } = await fixture();
    const a = await createCategory(db, { name: 'a', kind: 'expense' });
    const b = await createCategory(db, { name: 'b', kind: 'expense' });
    const c = await createCategory(db, { name: 'c', kind: 'expense' });
    await createExpense(db, { date: '2026-10-01', accountId: card, amountCents: 1, categoryId: c });
    await createExpense(db, { date: '2026-10-02', accountId: card, amountCents: 1, categoryId: a });
    await createExpense(db, { date: '2026-10-03', accountId: card, amountCents: 1, categoryId: b });

    const report = await monthReport(db, '2026-10', { today: '2026-10-20' });
    expect(report.categories.map(row => row.name)).toEqual(['a', 'b', 'c']);
    expect(report.categories.map(row => row.percent)).toEqual([34, 33, 33]);
  });

  it('rejects a month key that is not YYYY-MM and a today that is not a real day', async () => {
    const { db } = await fixture();
    for (const monthKey of ['2026-13', '2026-1', '202610', '']) {
      await expect(monthReport(db, monthKey)).rejects.toThrow(RangeError);
    }
    await expect(monthReport(db, '2026-10', { today: '2026-02-30' })).rejects.toThrow(RangeError);
  });

  it('reads only: a database that refuses writes still produces both reports', async () => {
    const { db, card, food } = await fixture();
    await createExpense(db, { date: '2026-10-01', accountId: card, amountCents: 1230, categoryId: food });
    await createExpense(db, { date: '2026-03-01', accountId: card, amountCents: 500, categoryId: food });

    const month = await monthReport(readOnly(db), '2026-10', { today: '2026-10-20' });
    expect(month.expenseCents).toBe(1230);
    expect(month.budgets[0].spentCents).toBe(1230);

    const year = await yearReport(readOnly(db), 2026, { today: '2026-10-20' });
    expect(year.expenseCents).toBe(1730);
    expect(year.busiestMonth).toEqual({ month: '2026-10', cents: 1230 });
  });
});

describe('yearReport', () => {
  it('answers where the money went across a year, and finds the two ends', async () => {
    const { db, card, bank, food, daily, salary } = await fixture();
    await createExpense(db, { date: '2026-01-10', accountId: card, amountCents: 1000, categoryId: food });
    await createExpense(db, { date: '2026-03-10', accountId: card, amountCents: 3000, categoryId: daily });
    await createExpense(db, { date: '2026-07-10', accountId: card, amountCents: 5000, categoryId: food });
    await createExpense(db, { date: '2026-10-05', accountId: card, amountCents: 2000, categoryId: food });
    await createExpense(db, { date: '2026-11-05', accountId: card, amountCents: 9000, categoryId: food });
    await createIncome(db, { date: '2026-02-01', accountId: card, amountCents: 50000, categoryId: salary });
    await createExpense(db, { date: '2025-12-31', accountId: card, amountCents: 1, categoryId: food });
    // Moving money between accounts and correcting a balance are not spending:
    // April must stay a zero bar in the series.
    await createTransfer(db, {
      date: '2026-04-01',
      fromAccountId: card,
      toAccountId: bank,
      amountCents: 7777,
    });
    await recordAdjustment(db, {
      date: '2026-04-02',
      accountId: card,
      deltaCents: -4321,
      note: '对账差额',
    });

    const report = await yearReport(db, 2026, { today: '2026-10-20' });

    expect(report.expenseCents).toBe(20000);
    expect(report.incomeCents).toBe(50000);
    expect(report.categories).toEqual([
      { categoryId: food, name: '饮食', cents: 17000, percent: 85 },
      { categoryId: daily, name: '日用', cents: 3000, percent: 15 },
    ]);
    expect(report.categories.reduce((sum, row) => sum + row.percent, 0)).toBe(100);
    expect(report.monthlySeries).toEqual(
      expectedSeries(2026, { 1: 1000, 3: 3000, 7: 5000, 10: 2000, 11: 9000 }, 11)
    );
    expect(report.monthlySeries.reduce((sum, point) => sum + point.cents, 0)).toBe(report.expenseCents);
    // November is still ahead, so it can be neither the most nor the least
    // expensive month: July wins, and the earliest real zero (February) is
    // the quietest.
    expect(report.busiestMonth).toEqual({ month: '2026-07', cents: 5000 });
    expect(report.quietestMonth).toEqual({ month: '2026-02', cents: 0 });
  });

  it('covers a fully past year and an entirely future one', async () => {
    const { db, card, food } = await fixture();
    await createExpense(db, { date: '2025-12-31', accountId: card, amountCents: 1, categoryId: food });

    const past = await yearReport(db, 2025, { today: '2026-10-20' });
    expect(past.monthlySeries).toEqual(expectedSeries(2025, { 12: 1 }, 13));
    expect(past.busiestMonth).toEqual({ month: '2025-12', cents: 1 });
    expect(past.quietestMonth).toEqual({ month: '2025-01', cents: 0 });

    const future = await yearReport(db, 2027, { today: '2026-10-20' });
    expect(future.expenseCents).toBe(0);
    expect(future.categories).toEqual([]);
    expect(future.monthlySeries).toEqual(expectedSeries(2027, {}, 1));
    expect(future.busiestMonth).toBeNull();
    expect(future.quietestMonth).toBeNull();
  });

  it('breaks an extreme tie toward the earlier month', async () => {
    const { db, card, food } = await fixture();
    const amounts = [100, 100, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200];
    for (let index = 0; index < amounts.length; index++) {
      const day = '2025-' + String(index + 1).padStart(2, '0') + '-05';
      await createExpense(db, { date: day, accountId: card, amountCents: amounts[index], categoryId: food });
    }

    const report = await yearReport(db, 2025, { today: '2026-10-20' });
    expect(report.busiestMonth).toEqual({ month: '2025-03', cents: 200 });
    expect(report.quietestMonth).toEqual({ month: '2025-01', cents: 100 });
  });

  it('says nothing about the two ends when the year has no spending', async () => {
    const { db } = await fixture();
    const report = await yearReport(db, 2025, { today: '2026-10-20' });
    expect(report.expenseCents).toBe(0);
    expect(report.categories).toEqual([]);
    expect(report.busiestMonth).toBeNull();
    expect(report.quietestMonth).toBeNull();
  });

  it('merges uncategorized rows across the whole year', async () => {
    const { db, card } = await fixture();
    await createExpense(db, { date: '2026-01-01', accountId: card, amountCents: 700, categoryId: null });
    await createExpense(db, {
      date: '2026-02-01',
      accountId: card,
      amountCents: 300,
      categoryId: UNCATEGORIZED_CATEGORY_ID,
    });

    const report = await yearReport(db, 2026, { today: '2026-10-20' });
    expect(report.categories).toEqual([
      { categoryId: '', name: '未分类', cents: 1000, percent: 100 },
    ]);
  });

  it('rejects a year that cannot fit a YYYY-MM key', async () => {
    const { db } = await fixture();
    for (const year of [2026.5, 99, 10000, Number.NaN]) {
      await expect(yearReport(db, year)).rejects.toThrow(RangeError);
    }
  });
});

/**
 * A Db that can read but refuses every write. Reports are the one screen the
 * owner reads long after the fact; proving they never write keeps the iron rule
 * (报表不改任何数据) executable rather than a comment.
 */
function readOnly(db: Db): Db {
  const forbidden = (): never => {
    throw new Error('reports must never write');
  };
  return {
    async exec(): Promise<void> {
      forbidden();
    },
    async run(): Promise<void> {
      forbidden();
    },
    all: <T>(sql: string, params?: readonly DbParam[]): Promise<T[]> => db.all<T>(sql, params),
    get: <T>(sql: string, params?: readonly DbParam[]): Promise<T | undefined> =>
      db.get<T>(sql, params),
    async transaction<T>(): Promise<T> {
      return forbidden();
    },
  };
}
