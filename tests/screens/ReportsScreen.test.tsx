import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ReportsScreen, {
  ReportsView,
  loadReportsData,
} from '../../src/screens/ReportsScreen';
import type { ReportsData } from '../../src/screens/ReportsScreen';
import type {
  BudgetActual,
  MonthPoint,
  MonthReport,
  ReportCategory,
  YearReport,
} from '../../src/db/repos/reports';
import { monthKeyOf, todayLocalISO } from '../../src/domain/date';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';
import { listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import { createExpense } from '../../src/db/repos/txns';

/**
 * SSR never runs effects, so the real useQuery would only ever show its loading
 * state. The screen is rendered with the exact ReportsData its query returns,
 * the way StatsScreen.test.tsx renders 统计.
 */
const store = vi.hoisted(() => ({
  data: null as ReportsData | null,
  error: null as Error | null,
}));

vi.mock('../../src/store/useDb', () => ({
  useDb: () => ({ db: { fake: true }, revision: 0, bump: () => {}, error: null }),
  useQuery: () => ({ data: store.data, loading: store.data === null, error: store.error }),
}));

const TODAY = todayLocalISO();
const CURRENT_MONTH = monthKeyOf(TODAY);
const YEAR = Number(CURRENT_MONTH.slice(0, 4));

const CATEGORIES: ReportCategory[] = [
  { categoryId: 'c-food', name: '饮食', cents: 48620, percent: 40 },
  { categoryId: 'c-transport', name: '交通', cents: 24400, percent: 20 },
  { categoryId: 'c-daily', name: '日用', cents: 17810, percent: 15 },
  { categoryId: 'c-comm', name: '通讯', cents: 8988, percent: 7 },
  { categoryId: 'c-sub', name: '订阅', cents: 6000, percent: 5 },
  { categoryId: 'c-med', name: '医疗', cents: 15812, percent: 13 },
];
const EXPENSE = 121630;

const SERIES: MonthPoint[] = Array.from({ length: 12 }, (_, index) => {
  const month = `${YEAR}-${String(index + 1).padStart(2, '0')}`;
  return { month, cents: [6900, 7900, 9400, 7100, 8800, 8300, 10000, 8000, 9000, 12163, 0, 0][index], isFuture: month > CURRENT_MONTH };
});

const CARD: BudgetActual = {
  accountId: 'a-card',
  name: '饭卡',
  budgetCents: 75000,
  spentCents: 71155,
  over: false,
};
const OVER: BudgetActual = {
  accountId: 'a-wechat',
  name: '微信',
  budgetCents: 30000,
  spentCents: 32000,
  over: true,
};

const MONTH_REPORT: MonthReport = {
  expenseCents: EXPENSE,
  incomeCents: 150000,
  categories: CATEGORIES,
  top3: CATEGORIES.slice(0, 3),
  restNames: '通讯 订阅 医疗',
  monthlySeries: SERIES,
  budgets: [CARD, OVER],
};

const YEAR_REPORT: YearReport = {
  expenseCents: EXPENSE,
  incomeCents: 150000,
  categories: CATEGORIES,
  monthlySeries: SERIES,
  busiestMonth: { month: `${YEAR}-07`, cents: 142000 },
  quietestMonth: { month: `${YEAR}-01`, cents: 98000 },
};

function monthData(report: Partial<MonthReport> = {}): ReportsData {
  return { kind: 'month', key: CURRENT_MONTH, report: { ...MONTH_REPORT, ...report } };
}

function yearData(report: Partial<YearReport> = {}): ReportsData {
  return { kind: 'year', key: String(YEAR), report: { ...YEAR_REPORT, ...report } };
}

function renderScreen(): string {
  return renderToString(
    <MemoryRouter initialEntries={['/settings/reports']}>
      <ReportsScreen />
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

function renderYear(data: ReportsData | null = yearData()): string {
  return renderToString(
    <MemoryRouter initialEntries={['/settings/reports']}>
      <ReportsView
        mode="year"
        monthKey={CURRENT_MONTH}
        year={YEAR}
        currentMonthKey={CURRENT_MONTH}
        currentYear={YEAR}
        data={data}
        error={null}
        onExport={() => {}}
        onModeChange={() => {}}
        onMonthChange={() => {}}
        onYearChange={() => {}}
      />
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

describe('loadReportsData', () => {
  it('asks the month repository for a month and the year repository for a year', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    const card = (await listAccounts(db))[0];
    const food = (await listCategories(db)).find(category => category.name === '饮食')!;

    await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
    });

    const month = await loadReportsData(db, 'month', '2026-10', 2026);
    expect(month.kind).toBe('month');
    expect(month.key).toBe('2026-10');
    if (month.kind !== 'month') throw new Error('expected a month snapshot');
    expect(month.report.expenseCents).toBe(1230);
    expect(month.report.top3.map(row => row.name)).toEqual(['饮食']);

    const year = await loadReportsData(db, 'year', '2026-10', 2026);
    expect(year.kind).toBe('year');
    expect(year.key).toBe('2026');
    if (year.kind !== 'year') throw new Error('expected a year snapshot');
    expect(year.report.expenseCents).toBe(1230);
    expect(year.report.busiestMonth).toEqual({ month: '2026-10', cents: 1230 });
  });
});

describe('报表 · 月', () => {
  it('opens on 月 with the report header, the switch and the month picker', () => {
    store.data = monthData();
    store.error = null;
    const html = renderScreen();

    expect(html).toContain('<h1>报表</h1>');
    // 报表 is a tab now: no way back into 设置 from here.
    expect(html).not.toContain('class="add-back"');
    // A plain two-word control: 月 underlined now, 年 one tap away.
    expect(html).toContain('aria-label="月或年"');
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>月<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>年<\/button>/);
    expect(html).toContain('class="reports-period__label num">2026年10月<');
    expect(html).toContain('aria-label="上个月"');
    expect(html).toContain('aria-label="下个月"');
    expect(html).not.toContain('type="month"');
  });

  it('keeps the next-month arrow disabled at the current month and redraws the period label', () => {
    store.data = monthData();
    const html = renderScreen();
    const next = html.match(/<button[^>]*aria-label="下个月"[^>]*>/)?.[0] ?? '';
    expect(next).toContain('disabled');
    expect(html).toContain('class="reports-period__label num">2026年10月<');
  });

  it('answers 钱去哪了 with the total, a six-label pie and the ranking', () => {
    store.data = monthData();
    const html = renderScreen();

    expect(html).toContain('支出合计');
    expect(html).toContain('1,216.30');
    expect(html).toContain('收入');
    expect(html).toContain('1,500.00');
    expect(html).toContain('结余');
    expect(html).toContain('283.70');

    expect(html).toContain('钱去哪了');
    expect(html.match(/data-slice="/g)).toHaveLength(6);
    expect(html.match(/<polyline/g)).toHaveLength(6);
    expect(html).toContain('饮食');
    expect(html).toContain('40%');
    expect(html).toContain('486.20');
    expect(html).toContain('交通');
    expect(html).toContain('244.00');
    expect(html).toContain('日用');
    expect(html).toContain('178.10');
    expect(html).toContain('医疗');
    expect(html).toContain('158.12');
    expect(html).toContain('13%');
  });

  it('lists every category under the pie instead of hiding the tail', () => {
    store.data = monthData();
    const html = renderScreen();

    expect(html).toContain('通讯');
    expect(html).toContain('89.88');
    expect(html).toContain('订阅');
    expect(html).toContain('60.00');
    expect(html).toContain('医疗');
    expect(html).toContain('158.12');
  });

  it('ranks every category with a square swatch, an amount and a percent column', () => {
    store.data = monthData();
    const html = renderScreen();
    expect(html.match(/reports-rank__swatch--/g)).toHaveLength(6);
    expect(html).toContain('reports-rank__percent');
    expect(html).toContain('饮食');
    expect(html).toContain('158.12');
    expect(html).toContain('13%');
    expect(html).toContain('486.20');
  });

  it('does not repeat the yearly bar chart in the month view', () => {
    store.data = monthData();
    const html = renderScreen();

    expect(html).not.toContain('按月的支出');
    expect(html).not.toContain('data-bar=');
  });

  it('puts the budget next to what was actually spent without turning it into an alarm', () => {
    store.data = monthData();
    const html = renderScreen();

    expect(html).toContain('预算对实际');
    expect(html).toContain('饭卡');
    expect(html).toContain('711.55');
    expect(html).toContain('750.00');
    expect(html).toContain('微信');
    expect(html).toContain('320.00');

    expect(html.match(/reports-budget__fill--over/g)).toHaveLength(1);
    const over = html.match(/<div[^>]*reports-budget__fill reports-budget__fill--over[^>]*>/)?.[0] ?? '';
    expect(over).toContain('width:100%');
    // 300 budget against 320 spent is the one bar that is over.
    expect(html).toMatch(/reports-budget__fill(?![^>]*--over)/);
  });

  it('says there is no budget yet instead of drawing an empty axis', () => {
    store.data = monthData({ budgets: [] });
    const html = renderScreen();

    expect(html).toContain('预算对实际');
    expect(html).toContain('还没有设过额度');
    expect(html).not.toContain('reports-budget__track');
  });

  it('offers the month as a real .xlsx download instead of a dead button', () => {
    store.data = monthData();
    const html = renderScreen();
    const button = html.match(/<button[^>]*reports-export[^>]*>.*?<\/button>/s)?.[0] ?? '';

    expect(button).toContain('导出这个月为表格（.xlsx）');
    expect(button).not.toContain('disabled');
  });
});

describe('报表 · 空', () => {
  it('says plainly that there was no spending and draws no pie', () => {
    store.data = monthData({
      expenseCents: 0,
      incomeCents: 0,
      categories: [],
      top3: [],
      restNames: '',
      budgets: [],
    });
    const html = renderScreen();

    expect(html).toContain('本月没有支出');
    expect(html).not.toContain('reports-pie');
    expect(html).not.toContain('data-slice=');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
    // The month view no longer repeats the year's bar chart.
    expect(html).not.toContain('按月的支出');
    expect(html).not.toContain('data-bar=');
  });

  it('renders the frame and says so when the database is missing', () => {
    store.data = null;
    store.error = new Error('数据层未就绪');
    const html = renderScreen();

    expect(html).toContain('<h1>报表</h1>');
    expect(html).toContain('月');
    expect(html).toContain('年');
    expect(html).toContain('报表暂时打不开');
    expect(html).not.toContain('data-slice=');
  });

  it('never paints a year snapshot under the month heading', () => {
    store.data = yearData();
    store.error = null;
    const html = renderScreen();

    expect(html).toContain('正在读取报表');
    expect(html).not.toContain('年支出');
    expect(html).not.toContain('data-slice=');
  });
});

describe('报表 · 年', () => {
  it('switches the same screen to the year: stepper, year pie, monthly bars, two ends', () => {
    const html = renderYear();

    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>月<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>年<\/button>/);
    expect(html).toContain(`${YEAR} 年`);
    expect(html).toContain('aria-label="上一年"');
    expect(html).toContain('aria-label="下一年"');

    expect(html).toContain(`${YEAR} 年`);
    expect(html).toContain('支出合计');
    expect(html).toContain('1,216.30');
    expect(html).toContain('钱去哪了');
    expect(html.match(/data-slice="/g)).toHaveLength(6);
    expect(html).toContain('按月的支出');
    expect(html.match(/data-bar="/g)).toHaveLength(12);

    expect(html).toContain('两头');
    expect(html).toContain('最贵的一个月');
    expect(html).toContain('7 月');
    expect(html).toContain('1,420.00');
    expect(html).toContain('最省的一个月');
    expect(html).toContain('980.00');
    // 预算 is a month question; the year view does not repeat it.
    expect(html).not.toContain('预算对实际');
  });

  it('keeps the year bars: the current month solid, future months blank', () => {
    const html = renderYear();

    expect(html).toContain('按月的支出');
    expect(html.match(/data-bar="/g)).toHaveLength(12);

    const current = html.match(new RegExp(`<span[^>]*data-bar="${CURRENT_MONTH}"[^>]*>`))?.[0] ?? '';
    expect(current).toContain('reports-bars__col--current');

    const nextMonth = new Date(YEAR, Number(CURRENT_MONTH.slice(5, 7)), 1);
    const futureKey = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`;
    if (futureKey.startsWith(String(YEAR))) {
      const future = html.match(new RegExp(`<span[^>]*data-bar="${futureKey}"[^>]*>`))?.[0] ?? '';
      expect(future).toContain('reports-bars__col--future');
      // 不画 0：a month that has not happened has no height at all.
      expect(future).not.toContain('style=');
    }
  });

  it('offers the year as an .xlsx download too', () => {
    const html = renderYear();
    const button = html.match(/<button[^>]*reports-export[^>]*>.*?<\/button>/s)?.[0] ?? '';

    expect(button).toContain('导出全年为表格（.xlsx）');
    expect(button).not.toContain('disabled');
  });

  it('draws no pie and no ends for a year without spending', () => {
    const html = renderYear(
      yearData({
        expenseCents: 0,
        incomeCents: 0,
        categories: [],
        busiestMonth: null,
        quietestMonth: null,
      })
    );

    expect(html).toContain('这一年没有支出');
    expect(html).not.toContain('data-slice=');
    expect(html).not.toContain('两头');
    expect(html).not.toContain('NaN');
  });

  it('disables 下一年 at the current year', () => {
    const html = renderYear();
    const next = html.match(/<button[^>]*aria-label="下一年"[^>]*>/)?.[0] ?? '';
    expect(next).toContain('disabled');
  });
});