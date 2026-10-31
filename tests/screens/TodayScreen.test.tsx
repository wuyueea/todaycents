import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import TodayScreen, { loadTodayData, orderTransferLegs, todayRows } from '../../src/screens/TodayScreen';
import type { TodayData } from '../../src/screens/TodayScreen';
import type { TxnRow } from '../../src/db/repos/txns';
import {
  createExpense,
  createIncome,
  recordAdjustment,
  softDeleteTxn,
} from '../../src/db/repos/txns';
import { createTransfer } from '../../src/db/repos/transfers';
import { createAccount, listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';
import { formatMonthDay, todayLocalISO } from '../../src/domain/date';

/**
 * The screen is rendered with a fixed query result: SSR never runs effects, so
 * the real useQuery would only ever show its loading state. The data shape is
 * the one TodayScreen's own query returns.
 */
const store = vi.hoisted(() => ({ data: null as TodayData | null }));

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

function todayData(rows: TxnRow[]): TodayData {
  return { date: todayLocalISO(), rows };
}

function renderScreen(): string {
  return renderToString(
    <MemoryRouter>
      <TodayScreen />
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

/** One serialized opening tag, selected by a data attribute. */
function openingTag(html: string, attribute: string): string {
  return html.match(new RegExp(`<[a-z]+[^>]*${attribute}[^>]*>`))?.[0] ?? '';
}

/** One card, selected by the row it renders. */
function card(html: string, txnId: string): string {
  return (
    html.match(
      new RegExp(`<(?:a|div)[^>]*data-txn-id="${txnId}"[\\s\\S]*?<\\/(?:a|div)>`)
    )?.[0] ?? ''
  );
}

describe('todayRows', () => {
  it('keeps only live rows of the named day, in the order it was given', () => {
    const rows = [
      txn({ id: 'today-new', occurredDate: '2026-10-21' }),
      txn({ id: 'yesterday', occurredDate: '2026-10-20' }),
      txn({
        id: 'today-deleted',
        occurredDate: '2026-10-21',
        deletedAt: '2026-10-21T08:00:00.000Z',
      }),
      txn({ id: 'today-older', occurredDate: '2026-10-21', amountCents: -500 }),
    ];

    expect(todayRows(rows, '2026-10-21').map(row => row.id)).toEqual([
      'today-new',
      'today-older',
    ]);
  });
});

describe('orderTransferLegs', () => {
  it('keeps a transfer pair together and puts the out leg before the in leg', () => {
    const rows = [
      txn({ id: 'xfer-in', occurredDate: '2026-10-21', direction: 'transfer', amountCents: 10000, transferGroupId: 'g-1' }),
      txn({ id: 'food', occurredDate: '2026-10-21', amountCents: -500 }),
      txn({ id: 'xfer-out', occurredDate: '2026-10-21', direction: 'transfer', amountCents: -10000, transferGroupId: 'g-1' }),
    ];

    expect(orderTransferLegs(rows).map(row => row.id)).toEqual(['xfer-out', 'xfer-in', 'food']);
  });
});

describe('loadTodayData', () => {
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

  it('loads every live movement of today, including both transfer legs, newest first', async () => {
    const { db, card, bank, food, reimbursement } = await seeded();
    const today = todayLocalISO();
    const yesterday = '2000-01-01'; // never today, even on New Year's Day

    const older = await createExpense(db, {
      date: today,
      accountId: card.id,
      amountCents: 350,
      categoryId: food.id,
      note: '午饭',
    });
    const newer = await createIncome(db, {
      date: today,
      accountId: card.id,
      amountCents: 30000,
      categoryId: reimbursement.id,
    });
    const adjustment = await recordAdjustment(db, {
      date: today,
      accountId: card.id,
      deltaCents: -400,
      note: '对账',
    });
    const transferGroupId = await createTransfer(db, {
      date: today,
      fromAccountId: card.id,
      toAccountId: bank.id,
      amountCents: 60000,
      note: '转存',
    });
    const removed = await createExpense(db, {
      date: today,
      accountId: card.id,
      amountCents: 999,
      categoryId: food.id,
    });
    await softDeleteTxn(db, removed);
    await createExpense(db, {
      date: yesterday,
      accountId: card.id,
      amountCents: 111,
      categoryId: food.id,
    });

    // Make the creation order explicit: the repository orders same-day rows by
    // created_at, which can tie when rows are written in the same millisecond.
    const transferLegs = await db.all<{ id: string }>(
      'SELECT id FROM txn WHERE transfer_group_id = ?',
      [transferGroupId]
    );
    for (const leg of transferLegs) {
      await db.run('UPDATE txn SET created_at = ? WHERE id = ?', [
        '2026-10-21T00:00:00.000Z',
        leg.id,
      ]);
    }
    await db.run('UPDATE txn SET created_at = ? WHERE id = ?', ['2026-10-21T00:00:03.000Z', adjustment]);
    await db.run('UPDATE txn SET created_at = ? WHERE id = ?', ['2026-10-21T00:00:02.000Z', newer]);
    await db.run('UPDATE txn SET created_at = ? WHERE id = ?', ['2026-10-21T00:00:01.000Z', older]);

    const data = await loadTodayData(db, today);

    expect(data.date).toBe(today);
    expect(data.rows).toHaveLength(5);
    expect(data.rows.every(row => row.occurredDate === today)).toBe(true);
    expect(data.rows.map(row => row.id)).not.toContain(removed);
    expect(data.rows.filter(row => row.direction === 'transfer')).toHaveLength(2);
    expect(data.rows.slice(0, 3).map(row => row.id)).toEqual([adjustment, newer, older]);
  });
});

describe('TodayScreen', () => {
  it('opens on 今天 with the day written out and no totals, balance or budget', () => {
    const today = todayLocalISO();
    store.data = todayData([
      txn({ id: 'txn-lunch', occurredDate: today, note: '午饭' }),
      txn({
        id: 'txn-pay',
        occurredDate: today,
        direction: 'income',
        amountCents: 30000,
        categoryName: '报销',
        categoryId: 'c-reimbursement',
      }),
    ]);
    const html = renderScreen();

    expect(html).toContain('<h1>今天</h1>');
    expect(html).toContain(formatMonthDay(today));
    expect(html).toContain(`dateTime="${today}"`);

    for (const banned of ['总支出', '总入账', '余额', '额度', '预算', '合计', '本月']) {
      expect(html).not.toContain(banned);
    }
  });

  it('renders one card per entry, newest first, with category, account, note and amount', () => {
    const today = todayLocalISO();
    store.data = todayData([
      txn({
        id: 'txn-newest',
        occurredDate: today,
        amountCents: -1230,
        note: '午饭',
        categoryName: '饮食',
      }),
      txn({
        id: 'txn-middle',
        occurredDate: today,
        amountCents: -500,
        categoryId: null,
        categoryName: null,
        note: '',
        accountName: '微信',
      }),
      txn({
        id: 'txn-oldest',
        occurredDate: today,
        direction: 'income',
        amountCents: 30000,
        categoryId: 'c-reimbursement',
        categoryName: '报销',
        note: '报销到账',
      }),
    ]);
    const html = renderScreen();

    expect(html).toContain('<ul class="today-list">');
    expect((html.match(/data-txn-id=/g) ?? []).length).toBe(3);
    const order = [...html.matchAll(/data-txn-id="([^"]+)"/g)].map(match => match[1]);
    expect(order).toEqual(['txn-newest', 'txn-middle', 'txn-oldest']);

    expect(card(html, 'txn-newest')).toContain('饮食');
    expect(card(html, 'txn-newest')).toContain('饭卡');
    expect(card(html, 'txn-newest')).toContain('午饭');
    expect(card(html, 'txn-newest')).toContain('−12.30');
    expect(card(html, 'txn-middle')).toContain('未分类');
    expect(card(html, 'txn-middle')).toContain('微信');
    expect(card(html, 'txn-middle')).toContain('−5.00');
    expect(card(html, 'txn-oldest')).toContain('300.00');

    expect(openingTag(html, 'data-txn-id="txn-newest"')).toContain('href="/txn/txn-newest"');
    expect(openingTag(html, 'data-txn-id="txn-middle"')).toContain('href="/txn/txn-middle"');
  });

  it('appends the project name to the muted line, grey once archived', () => {
    const today = todayLocalISO();
    store.data = todayData([
      txn({
        id: 'txn-project',
        occurredDate: today,
        note: '高铁回程',
        projectId: 'p-trip',
        projectName: '国庆去成都',
      }),
      txn({
        id: 'txn-dead',
        occurredDate: today,
        accountId: 'a-wechat',
        accountName: '微信',
        amountCents: -4500,
        projectId: 'p-old',
        projectName: '换手机',
        projectArchived: true,
      }),
    ]);
    const html = renderScreen();

    // The muted line is 「note/account · project」: the name is appended last.
    expect(card(html, 'txn-project')).toContain('高铁回程');
    expect(card(html, 'txn-project')).toContain('· 国庆去成都');
    expect(card(html, 'txn-dead')).toContain('微信');
    expect(card(html, 'txn-dead')).toContain('· 换手机');
    expect(openingTag(html, 'data-project-id="p-old"')).toContain(
      'project-mark--archived'
    );
    expect(openingTag(html, 'data-project-id="p-trip"')).not.toContain(
      'project-mark--archived'
    );
  });

  it('underlines 未分类 on a card that lost its category', () => {
    const today = todayLocalISO();
    store.data = todayData([
      txn({
        id: 'txn-uncat',
        occurredDate: today,
        categoryId: null,
        categoryName: null,
        note: '球场',
        amountCents: -4500,
      }),
      txn({ id: 'txn-food', occurredDate: today, note: '午饭' }),
    ]);
    const html = renderScreen();

    expect(card(html, 'txn-uncat')).toContain('class="uncat"');
    expect(card(html, 'txn-uncat')).toContain('未分类');
    expect(card(html, 'txn-food')).not.toContain('class="uncat"');
  });

  it('says the day is empty with one plain sentence and no numbers', () => {
    store.data = todayData([]);
    const html = renderScreen();

    expect(html).toContain('今天还没有一笔');
    expect(html).not.toContain('today-list');
    expect(html).not.toContain('amount-text');
    expect(html).not.toContain('¥');
  });

  it('renders a transfer leg read-only with a 转账 label and no edit link', () => {
    const today = todayLocalISO();
    store.data = todayData([
      txn({
        id: 'txn-leg-out',
        occurredDate: today,
        direction: 'transfer',
        categoryId: null,
        categoryName: null,
        amountCents: -60000,
        note: '还信用卡',
        accountName: '微信',
        transferGroupId: 'g-1',
      }),
    ]);
    const html = renderScreen();

    expect(html).toContain('转账');
    expect(html).toContain('−600.00');
    expect(card(html, 'txn-leg-out')).toContain('today-card--readonly');
    const tag = openingTag(html, 'data-txn-id="txn-leg-out"');
    expect(tag.startsWith('<a ')).toBe(false);
    expect(tag).toContain('data-direction="transfer"');
    expect(html).not.toContain('/txn/txn-leg-out');
  });

  it('labels an adjustment as 调整 rather than as an uncategorised expense', () => {
    const today = todayLocalISO();
    store.data = todayData([
      txn({
        id: 'txn-adjust',
        occurredDate: today,
        direction: 'adjust',
        amountCents: 5000,
        categoryId: null,
        categoryName: null,
      }),
    ]);
    const html = renderScreen();

    expect(html).toContain('调整');
    expect(html).not.toContain('未分类');
    expect(openingTag(html, 'data-txn-id="txn-adjust"')).toContain('href="/txn/txn-adjust"');
  });
});