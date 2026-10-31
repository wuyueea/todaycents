import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import LedgerScreen, {
  barHeightPx,
  dailyExpenseBars,
  deleteTransferFromLedger,
  groupTxnsByDate,
  ledgerDayLabel,
  loadLedgerData,
} from '../../src/screens/LedgerScreen';
import type { LedgerData } from '../../src/screens/LedgerScreen';
import type { TxnRow } from '../../src/db/repos/txns';
import { recordAdjustment, softDeleteTxn } from '../../src/db/repos/txns';
import { createExpense, createIncome, listTxnsByMonth } from '../../src/db/repos/txns';
import { createTransfer, deleteTransfer } from '../../src/db/repos/transfers';
import { accountBalance, createAccount, listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';
import { monthKeyOf, todayLocalISO } from '../../src/domain/date';

/**
 * The screen is rendered with a fixed query result: SSR never runs effects, so
 * the real useQuery would only ever show its loading state. The data shape is
 * the one LedgerScreen's own query returns.
 */
const store = vi.hoisted(() => ({ data: null as LedgerData | null }));

vi.mock('../../src/store/useDb', () => ({
  useDb: () => ({ db: { fake: true }, revision: 0, bump: () => {}, error: null }),
  useQuery: () => ({ data: store.data, loading: store.data === null, error: null }),
}));

function txn(overrides: Partial<TxnRow> & Pick<TxnRow, 'id' | 'occurredDate'>): TxnRow {
  return {
    accountId: 'a-card',
    accountName: '饭卡',
    amountCents: -1230,
    direction: 'expense',
    categoryId: 'c-food',
    categoryName: '饮食',
    note: '',
    slotKey: null,
    isFixedCost: false,
    transferGroupId: null,
    deletedAt: null,
    projectId: null,
    projectName: null,
    projectArchived: false,
    ...overrides,
  };
}

function ledgerData(overrides: Partial<LedgerData> = {}): LedgerData {
  return {
    monthKey: monthKeyOf(todayLocalISO()),
    rows: [
      txn({ id: 'txn-a', occurredDate: '2026-10-20', note: '午饭' }),
      txn({
        id: 'txn-b',
        occurredDate: '2026-10-20',
        accountId: 'a-bank',
        accountName: '银行卡',
        amountCents: 30000,
        direction: 'income',
        categoryId: 'c-reimbursement',
        categoryName: '报销',
      }),
      txn({
        id: 'txn-c',
        occurredDate: '2026-10-19',
        accountId: 'a-wechat',
        accountName: '微信',
        amountCents: -500,
        categoryId: null,
        categoryName: null,
      }),
    ],
    expenseCents: 1730,
    incomeCents: 30000,
    ...overrides,
  };
}

function renderScreen(): string {
  return renderToString(
    <MemoryRouter>
      <LedgerScreen />
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

/** One serialized opening tag, selected by a data attribute. */
function openingTag(html: string, attribute: string): string {
  return html.match(new RegExp(`<[a-z]+[^>]*${attribute}[^>]*>`))?.[0] ?? '';
}

/** One rendered row, selected by its transaction id. */
function row(html: string, txnId: string): string {
  return html.match(new RegExp(`<a[^>]*data-txn-id="${txnId}"[\\s\\S]*?<\\/a>`))?.[0] ?? '';
}

/** The inside of one day card, selected by its date. */
function dayCard(html: string, date: string): string {
  return (
    html.match(
      new RegExp(`<section[^>]*data-date="${date}"[^>]*>([\\s\\S]*?)<\\/section>`)
    )?.[1] ?? ''
  );
}

describe('ledgerDayLabel', () => {
  it('marks today and yesterday, then falls back to the weekday', () => {
    expect(ledgerDayLabel('2026-10-21', '2026-10-21')).toBe('10月21日 今天');
    expect(ledgerDayLabel('2026-10-20', '2026-10-21')).toBe('10月20日 昨天');
    expect(ledgerDayLabel('2026-10-18', '2026-10-21')).toBe('10月18日 周日');
    expect(ledgerDayLabel('2026-10-01', '2026-10-21')).toBe('10月1日 周四');
  });

  it('treats yesterday across a month boundary as 昨天', () => {
    expect(ledgerDayLabel('2026-09-30', '2026-10-01')).toBe('9月30日 昨天');
    expect(ledgerDayLabel('2027-01-01', '2027-01-02')).toBe('1月1日 昨天');
  });
});

describe('groupTxnsByDate', () => {
  it('groups by day in the repository order, newest day first', () => {
    const groups = groupTxnsByDate([
      txn({ id: 'a', occurredDate: '2026-10-20' }),
      txn({ id: 'b', occurredDate: '2026-10-20' }),
      txn({ id: 'c', occurredDate: '2026-10-19' }),
    ]);

    expect(groups.map(group => group.date)).toEqual(['2026-10-20', '2026-10-19']);
    expect(groups[0]?.rows.map(row => row.id)).toEqual(['a', 'b']);
    expect(groups[1]?.rows.map(row => row.id)).toEqual(['c']);
  });

  it('sorts a hand-built list by day without reshuffling rows inside a day', () => {
    const groups = groupTxnsByDate([
      txn({ id: 'older', occurredDate: '2026-10-01' }),
      txn({ id: 'newer-1', occurredDate: '2026-10-20' }),
      txn({ id: 'newer-2', occurredDate: '2026-10-20' }),
    ]);

    expect(groups.map(group => group.date)).toEqual(['2026-10-20', '2026-10-01']);
    expect(groups[0]?.rows.map(row => row.id)).toEqual(['newer-1', 'newer-2']);
  });

  it('counts only that day’s expenses and income, never transfers or adjustments', () => {
    const groups = groupTxnsByDate([
      txn({ id: 'expense', occurredDate: '2026-10-20', amountCents: -1230 }),
      txn({
        id: 'income',
        occurredDate: '2026-10-20',
        amountCents: 30000,
        direction: 'income',
        categoryId: null,
        categoryName: null,
      }),
      txn({
        id: 'transfer',
        occurredDate: '2026-10-20',
        amountCents: -60000,
        direction: 'transfer',
        categoryId: null,
        categoryName: null,
        transferGroupId: 'g-1',
      }),
      txn({
        id: 'adjust',
        occurredDate: '2026-10-20',
        amountCents: 5000,
        direction: 'adjust',
        categoryId: null,
        categoryName: null,
      }),
      txn({ id: 'older', occurredDate: '2026-10-19', amountCents: -500 }),
    ]);

    expect(groups[0]).toMatchObject({
      date: '2026-10-20',
      expenseCents: 1230,
      incomeCents: 30000,
    });
    expect(groups[1]).toMatchObject({
      date: '2026-10-19',
      expenseCents: 500,
      incomeCents: 0,
    });
  });
});

describe('dailyExpenseBars', () => {
  it('covers every day, marks the future and today, and counts only expenses', () => {
    const bars = dailyExpenseBars(
      [
        txn({ id: 'expense', occurredDate: '2026-10-20', amountCents: -1230 }),
        txn({
          id: 'transfer',
          occurredDate: '2026-10-20',
          direction: 'transfer',
          amountCents: -60000,
          categoryId: null,
          categoryName: null,
          transferGroupId: 'g-1',
        }),
        txn({ id: 'income', occurredDate: '2026-10-19', amountCents: 500, direction: 'income' }),
        txn({
          id: 'adjust',
          occurredDate: '2026-10-19',
          direction: 'adjust',
          amountCents: 5000,
          categoryId: null,
          categoryName: null,
        }),
      ],
      '2026-10',
      '2026-10-30'
    );

    expect(bars).toHaveLength(31);
    expect(bars[19]).toMatchObject({
      date: '2026-10-20',
      expenseCents: 1230,
      hasRows: true,
      isFuture: false,
      isToday: false,
    });
    expect(bars[18]).toMatchObject({
      date: '2026-10-19',
      expenseCents: 0,
      hasRows: true,
    });
    expect(bars[29]).toMatchObject({ date: '2026-10-30', isToday: true });
    expect(bars[30]).toMatchObject({ date: '2026-10-31', isFuture: true, hasRows: false });
    expect(barHeightPx(0, 1230)).toBe(2);
    expect(barHeightPx(1230, 1230)).toBe(74);
  });
});

describe('loadLedgerData', () => {
  async function seeded() {
    const db = await createTestDb();
    await seedDefaults(db);
    await createAccount(db, { name: '饭卡', type: 'prepaid', monthlyBudgetCents: 75000 });
    const accounts = await listAccounts(db);
    const categories = await listCategories(db);
    return {
      db,
      card: accounts.find(account => account.name === '饭卡')!,
      bank: accounts.find(account => account.name === '银行卡')!,
      food: categories.find(category => category.name === '饮食')!,
      reimbursement: categories.find(category => category.name === '报销')!,
    };
  }

  it('drops a soft-deleted row from both the list and the month totals', async () => {
    const { db, card, food, reimbursement } = await seeded();
    const expenseId = await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
    });
    await createIncome(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 30000,
      categoryId: reimbursement.id,
    });

    const before = await loadLedgerData(db, '2026-10');
    expect(before.rows).toHaveLength(2);
    expect(before.expenseCents).toBe(1230);
    expect(before.incomeCents).toBe(30000);

    await softDeleteTxn(db, expenseId);

    const after = await loadLedgerData(db, '2026-10');
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.direction).toBe('income');
    expect(after.expenseCents).toBe(0);
    expect(after.incomeCents).toBe(30000);
  });

  it('reads a finished month through the same repository when the current month is empty', async () => {
    const { db, card, food } = await seeded();
    await createExpense(db, {
      date: '2026-09-15',
      accountId: card.id,
      amountCents: 880,
      categoryId: food.id,
    });

    const september = await loadLedgerData(db, '2026-09');
    expect(september.rows).toHaveLength(1);
    expect(september.rows[0]?.occurredDate).toBe('2026-09-15');
    expect(september.expenseCents).toBe(880);

    const october = await loadLedgerData(db, '2026-10');
    expect(october.rows).toEqual([]);
    expect(october.expenseCents).toBe(0);
  });

  it('reconciles every day card with monthSummary, excluding transfers and adjustments', async () => {
    const { db, card, bank, food, reimbursement } = await seeded();
    await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
    });
    await createIncome(db, {
      date: '2026-10-20',
      accountId: bank.id,
      amountCents: 30000,
      categoryId: reimbursement.id,
    });
    await createExpense(db, {
      date: '2026-10-19',
      accountId: card.id,
      amountCents: 500,
      categoryId: food.id,
    });
    await createTransfer(db, {
      date: '2026-10-20',
      fromAccountId: card.id,
      toAccountId: bank.id,
      amountCents: 60000,
      note: '转存',
    });
    await recordAdjustment(db, {
      date: '2026-10-18',
      accountId: card.id,
      deltaCents: -400,
      note: '对账',
    });

    const data = await loadLedgerData(db, '2026-10');
    const groups = groupTxnsByDate(data.rows);
    const dayExpense = groups.reduce((sum, group) => sum + group.expenseCents, 0);
    const dayIncome = groups.reduce((sum, group) => sum + group.incomeCents, 0);

    expect(dayExpense).toBe(data.expenseCents);
    expect(dayIncome).toBe(data.incomeCents);
    expect(data.expenseCents).toBe(1730);
    expect(data.incomeCents).toBe(30000);
  });

  it('lists both transfer legs while neither counts as spending or earning', async () => {
    const { db, card, bank } = await seeded();
    const groupId = await createTransfer(db, {
      date: '2026-10-20',
      fromAccountId: card.id,
      toAccountId: bank.id,
      amountCents: 60000,
      note: '转存',
    });

    const before = await loadLedgerData(db, '2026-10');
    expect(before.rows).toHaveLength(2);
    expect(before.rows.every(row => row.direction === 'transfer')).toBe(true);
    expect(before.expenseCents).toBe(0);
    expect(before.incomeCents).toBe(0);

    await deleteTransfer(db, groupId);
    const after = await loadLedgerData(db, '2026-10');
    expect(after.rows).toHaveLength(0);
    expect(after.expenseCents + after.incomeCents).toBe(0);
  });
});

describe('deleteTransferFromLedger', () => {
  async function seeded() {
    const db = await createTestDb();
    await seedDefaults(db);
    await createAccount(db, { name: '饭卡', type: 'prepaid', monthlyBudgetCents: 75000 });
    const accounts = await listAccounts(db);
    return {
      db,
      card: accounts.find(account => account.name === '饭卡')!,
      bank: accounts.find(account => account.name === '银行卡')!,
    };
  }

  it('soft-deletes the whole group and puts both balances back', async () => {
    const { db, card, bank } = await seeded();
    const cardBefore = await accountBalance(db, card.id);
    const bankBefore = await accountBalance(db, bank.id);
    const groupId = await createTransfer(db, {
      date: '2026-10-20',
      fromAccountId: card.id,
      toAccountId: bank.id,
      amountCents: 60000,
    });

    const ledger = await loadLedgerData(db, '2026-10');
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows.every(row => row.transferGroupId === groupId)).toBe(true);

    const deleted = await deleteTransferFromLedger(db, ledger.rows[0]!);
    expect(deleted).toBe(true);

    const after = await loadLedgerData(db, '2026-10');
    expect(after.rows).toEqual([]);
    expect(after.expenseCents).toBe(0);
    expect(await accountBalance(db, card.id)).toBe(cardBefore);
    expect(await accountBalance(db, bank.id)).toBe(bankBefore);

    const rows = await db.all<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM txn WHERE transfer_group_id = ?',
      [groupId]
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does nothing for a normal row or a leg without a group id', async () => {
    const { db, card } = await seeded();
    const expenseId = await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: null,
    });
    const expense = (await loadLedgerData(db, '2026-10')).rows.find(
      row => row.id === expenseId
    )!;

    expect(await deleteTransferFromLedger(db, expense)).toBe(false);
    expect(
      await deleteTransferFromLedger(db, {
        ...expense,
        direction: 'transfer',
        transferGroupId: null,
      })
    ).toBe(false);
    expect(await listTxnsByMonth(db, '2026-10')).toHaveLength(1);
  });
});

describe('LedgerScreen', () => {
  it('renders the month totals in the hero and one card per day', () => {
    store.data = ledgerData();
    const html = renderScreen();

    // The ink bar carries no page title — the tab bar already says 流水.
    expect(html).not.toContain('<h1>流水</h1>');
    // Totals read 出 / 入 with a bare number, as in the prototype.
    expect(html).toContain('aria-label="本月合计"');
    expect(html).toContain('ledger-hero__label">出<');
    expect(html).toContain('ledger-hero__label">入<');
    // Both numbers are monthSummary's, not a sum computed in the screen.
    expect(html).toContain('17.30');
    expect(html).toContain('300.00');
    expect(html).not.toContain('本月支出');

    // Newest day first, one card per day, each carrying its own 出/入.
    expect(html.match(/<section class="ledger-day" data-date=/g)).toHaveLength(2);
    expect(html.indexOf('data-date="2026-10-20"')).toBeLessThan(
      html.indexOf('data-date="2026-10-19"')
    );

    const day20 = dayCard(html, '2026-10-20');
    const day19 = dayCard(html, '2026-10-19');
    expect(day20).toContain(ledgerDayLabel('2026-10-20', todayLocalISO()));
    expect(day19).toContain(ledgerDayLabel('2026-10-19', todayLocalISO()));
    expect(day20).toContain('出 12.30');
    expect(day20).toContain('入 300.00');
    expect(day19).toContain('出 5.00');
    expect(day19).toContain('入 0.00');
    expect((day20.match(/data-txn-id=/g) ?? []).length).toBe(2);
    expect((day19.match(/data-txn-id=/g) ?? []).length).toBe(1);

    expect(day20).toContain('饮食');
    expect(day20).toContain('报销');
    expect(day20).toContain('午饭');
    expect(day20).toContain('饭卡');
    expect(day20).toContain('银行卡');
    expect(day19).toContain('未分类');
    expect(day19).toContain('微信');

    // Signed amounts in the rows, not magnitudes; the display uses U+2212.
    expect(day20).toContain('−12.30');
    expect(day19).toContain('−5.00');

    expect(openingTag(html, 'data-txn-id="txn-a"')).toContain('href="/txn/txn-a"');
    expect(openingTag(html, 'data-txn-id="txn-c"')).toContain('href="/txn/txn-c"');
  });

  it('offers previous/next month capsules above the dock, with next disabled now', () => {
    store.data = ledgerData();
    const html = renderScreen();

    expect(html).toContain('aria-label="上个月"');
    expect(html).toContain('aria-label="下个月"');
    expect(html).toContain('class="ledger-switch"');
    const nextButton = html.match(/<button[^>]*aria-label="下个月"[^>]*>/)?.[0] ?? '';
    expect(nextButton).toContain('disabled');
    expect(html).toContain('已是本月');
    // The month title is real text, not a native month input.
    expect(html).toContain('2026年10月');
    expect(html).not.toContain('type="month"');
  });

  it('draws one bar per calendar day and keeps future/no-row days unclickable', () => {
    store.data = ledgerData();
    const html = renderScreen();

    expect(html.match(/data-bar-date=/g)).toHaveLength(31);
    const todayBar = openingTag(html, `data-bar-date="${todayLocalISO()}"`);
    expect(todayBar).toContain('is-today');
    const spent = openingTag(html, 'data-bar-date="2026-10-20"');
    expect(spent).toContain('is-spent');
    expect(spent).not.toContain('disabled');
    // The button is a full-height hit target; the 2–74px bar is drawn inside.
    const spentBody = html.match(/<button[^>]*data-bar-date="2026-10-20"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? '';
    expect(spentBody).toContain('ledger-bars__fill');
    expect(spentBody).toContain('style="height:');
    const empty = openingTag(html, 'data-bar-date="2026-10-10"');
    expect(empty).toContain('disabled');
  });

  it('never paints another month’s snapshot under this month’s heading', () => {
    store.data = ledgerData({ monthKey: '2026-09' });
    const html = renderScreen();

    expect(html).toContain('正在加载流水');
    expect(html).not.toContain('17.30');
    // The hero keeps its month switcher but never shows another month's totals.
    expect(html).not.toContain('本月合计');
  });

  it('renders a transfer leg read-only with a 转账 label and no edit link', () => {
    store.data = ledgerData({
      rows: [
        txn({
          id: 't-out',
          occurredDate: '2026-10-20',
          direction: 'transfer',
          categoryId: null,
          categoryName: null,
          amountCents: -60000,
          note: '还信用卡',
          accountId: 'a-wechat',
          accountName: '微信',
          transferGroupId: 'g-1',
        }),
      ],
      expenseCents: 0,
      incomeCents: 0,
    });
    const html = renderScreen();

    expect(html).toContain('转账');
    expect(html).toContain('−600.00');
    const rowTag = openingTag(html, 'data-txn-id="t-out"');
    expect(rowTag.startsWith('<a ')).toBe(false);
    expect(rowTag).toContain('data-direction="transfer"');
    // No path from the list to updateTxn / softDeleteTxn on a transfer leg;
    // the only action is deleting the whole group.
    expect(html).not.toContain('/txn/t-out');
    const transferRow =
      html.match(/<div class="ledger-row ledger-row--readonly"[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(transferRow).toContain('删除这笔转账');
    expect(transferRow).not.toContain('编辑');
    // A transfer is neither spending nor earning on the day card either.
    expect(dayCard(html, '2026-10-20')).toContain('出 0.00');
    expect(dayCard(html, '2026-10-20')).toContain('入 0.00');
  });

  it('does not offer the group-delete action on a transfer leg with no group id', () => {
    store.data = ledgerData({
      rows: [
        txn({
          id: 't-legacy',
          occurredDate: '2026-10-20',
          direction: 'transfer',
          amountCents: -60000,
          categoryId: null,
          categoryName: null,
          transferGroupId: null,
        }),
      ],
      expenseCents: 0,
      incomeCents: 0,
    });
    const html = renderScreen();

    expect(html).not.toContain('删除这笔转账');
  });

  it('labels an adjustment as 调整 rather than as an uncategorised expense', () => {
    store.data = ledgerData({
      rows: [
        txn({
          id: 'txn-adjust',
          occurredDate: '2026-10-20',
          direction: 'adjust',
          amountCents: 5000,
          categoryId: null,
          categoryName: null,
        }),
      ],
      expenseCents: 0,
      incomeCents: 0,
    });
    const html = renderScreen();

    expect(html).toContain('调整');
    expect(html).not.toContain('未分类');
    expect(html).toContain('50.00');
    expect(dayCard(html, '2026-10-20')).toContain('出 0.00');
    expect(dayCard(html, '2026-10-20')).toContain('入 0.00');
  });

  it('appends the project name to the sub-line, grey once that project is archived', () => {
    store.data = ledgerData({
      rows: [
        txn({
          id: 'txn-project',
          occurredDate: '2026-10-20',
          note: '高铁回程',
          projectId: 'p-trip',
          projectName: '国庆去成都',
        }),
        txn({
          id: 'txn-dead',
          occurredDate: '2026-10-19',
          accountId: 'a-wechat',
          accountName: '微信',
          amountCents: -4500,
          projectId: 'p-old',
          projectName: '换手机',
          projectArchived: true,
        }),
      ],
      expenseCents: 3080,
      incomeCents: 0,
    });
    const html = renderScreen();

    // 分类(标题) → 备注 · 账户 → · 项目名: the project is last, never earlier.
    const projectRow = row(html, 'txn-project');
    expect(projectRow).toContain('· 国庆去成都');
    expect(projectRow.indexOf('饭卡')).toBeLessThan(projectRow.indexOf('国庆去成都'));

    // An archived project keeps its name in history; only its colour changes.
    expect(row(html, 'txn-dead')).toContain('· 换手机');
    expect(openingTag(html, 'data-project-id="p-old"')).toContain(
      'project-mark--archived'
    );
    expect(openingTag(html, 'data-project-id="p-trip"')).not.toContain(
      'project-mark--archived'
    );
  });

  it('underlines 未分类 because the row still needs re-filing', () => {
    store.data = ledgerData({
      rows: [
        txn({
          id: 'txn-uncat',
          occurredDate: '2026-10-20',
          categoryId: null,
          categoryName: null,
          amountCents: -4500,
        }),
        txn({
          id: 'txn-system',
          occurredDate: '2026-10-20',
          categoryId: 'uncategorized',
          categoryName: '未分类',
          amountCents: -500,
        }),
        txn({ id: 'txn-food', occurredDate: '2026-10-20' }),
        txn({
          id: 'txn-adjust',
          occurredDate: '2026-10-20',
          direction: 'adjust',
          categoryId: null,
          categoryName: null,
          amountCents: 5000,
        }),
      ],
      expenseCents: 5000,
      incomeCents: 0,
    });
    const html = renderScreen();

    // A row with no category and a row reflowed to the system 未分类 are the
    // same problem to the owner, so both carry the dotted underline.
    expect(row(html, 'txn-uncat')).toContain('class="uncat"');
    expect(row(html, 'txn-system')).toContain('class="uncat"');
    // A named category and an adjustment are not marks of missing data.
    expect(row(html, 'txn-food')).not.toContain('class="uncat"');
    expect(row(html, 'txn-adjust')).not.toContain('class="uncat"');
    expect(row(html, 'txn-adjust')).toContain('调整');
  });

  it('says the month is empty when there is nothing to review', () => {
    store.data = ledgerData({ rows: [], expenseCents: 0, incomeCents: 0 });
    const html = renderScreen();

    expect(html).toContain('本月还没有流水');
    // The bar reads 出 0.00 / 入 0.00 — no currency sign, as in the prototype.
    expect(html.match(/ledger-hero__label">[出入]</g)).toHaveLength(2);
    expect(html.match(/>0\.00</g)).toHaveLength(2);
  });
});