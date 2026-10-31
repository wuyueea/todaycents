import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import FixedCostsScreen, {
  FIXED_COST_RULE,
  FixedCostsView,
  confirmFixedCost,
  loadFixedCostsData,
  undoFixedCost,
} from '../../src/screens/FixedCostsScreen';
import type { FixedCostsData, FixedCostViewProps } from '../../src/screens/FixedCostsScreen';
import type { FixedCost, FixedCostCandidate } from '../../src/db/repos/fixedCosts';
import { detectCandidates, listCandidates } from '../../src/db/repos/fixedCosts';
import { createAccount } from '../../src/db/repos/accounts';
import { createCategory } from '../../src/db/repos/categories';
import { createExpense } from '../../src/db/repos/txns';
import { createTestDb } from '../helpers/nodeDb';
import App from '../../src/App';

/** The screen renders one snapshot supplied by useQuery; SSR never runs effects. */
const store = vi.hoisted(() => ({
  data: null as FixedCostsData | null,
  error: null as Error | null,
}));

vi.mock('../../src/store/useDb', () => ({
  useDb: () => ({ db: { fake: true }, revision: 0, bump: () => {}, error: null }),
  useQuery: () => ({
    data: store.data,
    loading: store.data === null,
    error: store.error,
  }),
}));

const PHONE: FixedCost = {
  name: '话费',
  categoryId: 'c-phone',
  categoryName: '通讯',
  payee: '话费',
  monthlyCents: 5988,
  lastDate: '2026-03-01',
  nextDate: '2026-04-01',
  dayOfMonth: 1,
  occurrences: 3,
};

const INTERNET: FixedCost = {
  name: '校园网',
  categoryId: 'c-phone',
  categoryName: '通讯',
  payee: '校园网',
  monthlyCents: 3000,
  lastDate: '2026-03-05',
  nextDate: '2026-04-05',
  dayOfMonth: 5,
  occurrences: 4,
};

const CANDIDATE: FixedCostCandidate = {
  id: 'h-phone',
  name: '话费',
  categoryId: 'c-phone',
  payee: '话费',
  monthlyCents: 5988,
  lastDate: '2026-03-01',
  nextDate: '2026-04-01',
  occurrences: 5,
  detectedAt: '2026-04-02T00:00:00.000Z',
};

function fixedData(overrides: Partial<FixedCostsData> = {}): FixedCostsData {
  return {
    candidates: [],
    items: [],
    totalCents: 0,
    expenseMonthCount: 1,
    ...overrides,
  };
}

function renderScreen(): string {
  return renderToString(
    <MemoryRouter initialEntries={['/settings/fixed']}>
      <FixedCostsScreen />
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

function renderView(overrides: Partial<FixedCostViewProps> = {}): string {
  const props: FixedCostViewProps = {
    data: fixedData(),
    error: null,
    confirmation: null,
    busy: false,
    notice: null,
    onConfirm: () => {},
    onDismiss: () => {},
    onUndo: () => {},
    ...overrides,
  };
  return renderToString(
    <MemoryRouter initialEntries={['/settings/fixed']}>
      <FixedCostsView {...props} />
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

/** Three live monthly bills for one payee, ready for detection. */
async function phoneHistory() {
  const db = await createTestDb();
  const card = await createAccount(db, {
    name: '饭卡',
    type: 'prepaid',
    initialBalanceCents: 0,
  });
  const phone = await createCategory(db, { name: '通讯', kind: 'expense' });
  for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) {
    const id = await createExpense(db, {
      date,
      accountId: card,
      amountCents: 5988,
      categoryId: phone,
    });
    await db.run('UPDATE txn SET payee = ? WHERE id = ?', ['话费', id]);
  }
  return { db, card, phone };
}

describe('loadFixedCostsData', () => {
  it('runs detection first, then reports the list, total and history depth', async () => {
    const { db } = await phoneHistory();

    const loaded = await loadFixedCostsData(db);

    expect(loaded.candidates).toHaveLength(1);
    expect(loaded.candidates[0]).toMatchObject({
      name: '话费',
      monthlyCents: 5988,
      nextDate: '2026-04-01',
    });
    expect(loaded.items).toEqual([]);
    expect(loaded.totalCents).toBe(0);
    expect(loaded.expenseMonthCount).toBe(3);
  });

  it('turns a confirmation into a list row and undo puts the prompt back', async () => {
    const { db } = await phoneHistory();
    const [candidate] = await detectCandidates(db);

    const confirmation = await confirmFixedCost(db, candidate);
    expect(confirmation).toEqual({
      hintId: candidate.id,
      name: '话费',
      nextDate: '2026-04-01',
    });

    const confirmed = await loadFixedCostsData(db);
    expect(confirmed.candidates).toEqual([]);
    expect(confirmed.items).toMatchObject([
      { name: '话费', monthlyCents: 5988, nextDate: '2026-04-01' },
    ]);
    expect(confirmed.totalCents).toBe(5988);

    await undoFixedCost(db, confirmation);
    const undone = await loadFixedCostsData(db);
    expect(undone.candidates.map(row => row.id)).toEqual([candidate.id]);
    expect(undone.items).toEqual([]);
    expect(undone.totalCents).toBe(0);
    expect((await listCandidates(db)).map(row => row.id)).toEqual([candidate.id]);
  });
});

describe('FixedCostsView candidate prompt', () => {
  it('does not render a prompt at all when there is no candidate', () => {
    const html = renderView({ data: fixedData({ items: [PHONE], totalCents: 5988 }) });

    expect(html).not.toContain('data-fixed-prompt');
    expect(html).not.toContain('要加进清单吗？');
    expect(html).not.toContain('确认，是固定支出');
    expect(html).toContain('话费');
  });

  it('shows §7 candidate copy above the total and the list', () => {
    const html = renderView({
      data: fixedData({
        candidates: [CANDIDATE],
        items: [PHONE, INTERNET],
        totalCents: 8988,
      }),
    });

    expect(html).toContain('从历史里认出来的');
    expect(html).toContain('每月约 59.88');
    expect(html).toContain('连续 5 个月都是这个数，下次 4月1日。要加进清单吗？');
    expect(html).toContain('>确认，是固定支出</button>');
    expect(html).toContain('>不是</button>');

    const prompt = html.indexOf('data-fixed-prompt');
    const total = html.indexOf('data-fixed-total');
    const list = html.indexOf('data-fixed-list');
    expect(prompt).toBeGreaterThanOrEqual(0);
    expect(prompt).toBeLessThan(total);
    expect(total).toBeLessThan(list);
  });

  it('does not render the same candidate again while the list catches up', () => {
    const html = renderView({
      data: fixedData({ candidates: [CANDIDATE], items: [PHONE], totalCents: 5988 }),
      confirmation: { hintId: CANDIDATE.id, name: '话费', nextDate: '2026-04-01' },
    });

    expect(html).toContain('data-fixed-confirmed');
    expect(html).not.toContain('data-fixed-prompt');
    expect(html).not.toContain('要加进清单吗？');
  });

  it('turns that block into the confirmed line and keeps the list in place', () => {
    const html = renderView({
      data: fixedData({ items: [PHONE], totalCents: 5988 }),
      confirmation: { hintId: CANDIDATE.id, name: '话费', nextDate: '2026-04-01' },
    });

    expect(html).toContain('data-fixed-confirmed');
    expect(html).toContain('已加入清单 · 下次 4月1日');
    expect(html).toContain('>撤销</button>');
    expect(html).not.toContain('要加进清单吗？');
    expect(html).not.toContain('确认，是固定支出');

    // Same page, same header, list still below: nothing navigated.
    expect(html).toContain('<h1>固定支出</h1>');
    expect(html.indexOf('data-fixed-confirmed')).toBeLessThan(
      html.indexOf('data-fixed-list')
    );
  });
});

describe('FixedCostsView list and empty state', () => {
  it('lists name, day of month, amount and next date under 手动标记', () => {
    const html = renderView({
      data: fixedData({ items: [PHONE, INTERNET], totalCents: 8988 }),
    });

    expect(html).toContain('本月合计 · 2 项');
    expect(html).toContain('89.88');
    expect(html).toContain('每月 1 日');
    expect(html).toContain('59.88');
    expect(html).toContain('下次 4月1日');
    expect(html).toContain('每月 5 日');
    expect(html).toContain('30.00');
    expect(html).toContain('下次 4月5日');
    // The list sits in the 手动标记 block, and the old §7 footnote is gone.
    expect(html.indexOf('手动标记')).toBeLessThan(html.indexOf('data-fixed-list'));
    expect(html).not.toContain('不会自动记账');
  });

  // The page is two headings and one line each now: no history-depth paragraph,
  // no caution, no footnote.
  it('always shows 建议标记 and 手动标记 with their one-line rules', () => {
    const short = renderView({ data: fixedData({ expenseMonthCount: 1 }) });

    expect(short).toContain('建议标记');
    expect(short).toContain(FIXED_COST_RULE);
    expect(short).toContain('手动标记');
    expect(short).toContain('在流水里挑一笔');
    expect(short).not.toContain('历史只有');
    expect(short).not.toContain('还差');
    expect(short).not.toContain('data-fixed-total');
    expect(short).not.toContain('data-fixed-list');
  });

  it('keeps the same two blocks once the history is long enough', () => {
    const html = renderView({ data: fixedData({ expenseMonthCount: 8 }) });

    expect(html).toContain('建议标记');
    expect(html).toContain('手动标记');
    expect(html).toContain(FIXED_COST_RULE);
    expect(html).toContain('在流水里挑一笔');
    expect(html).not.toContain('还没认出固定支出');
    // The caution sentence is gone with the rest of the explanation.
    expect(html).not.toContain('攒到 3 个月');
  });
});

describe('FixedCostsScreen', () => {
  it('survives a missing database', () => {
    store.data = null;
    store.error = new Error('no sqlite');

    const html = renderScreen();
    expect(html).toContain('<h1>固定支出</h1>');
    expect(html).toContain('固定支出暂时打不开');
    expect(html).toContain('href="/settings"');
    store.error = null;
  });

  it('is a real /settings/fixed route pushed over the shell', () => {
    store.data = fixedData({ items: [PHONE], totalCents: 5988 });
    store.error = null;
    const html = renderToString(
      <MemoryRouter initialEntries={['/settings/fixed']}>
        <App />
      </MemoryRouter>
    ).replace(/<!-- -->/g, '');

    expect(html).toContain('<h1>固定支出</h1>');
    expect(html).not.toContain('tab-bar');
    expect(html).toContain('href="/settings"');
  });
});
