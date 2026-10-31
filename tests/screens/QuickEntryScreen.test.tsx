import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import QuickEntryScreen, {
  amountDraftDisplay,
  applyAmountKey,
  clampEntryDate,
  entryDateHint,
  pickTransferDefaults,
  planQuickEntry,
  saveQuickEntryAndLeave,
  submitQuickEntry,
} from '../../src/screens/QuickEntryScreen';
import type { QuickEntryData, QuickEntryDraft } from '../../src/screens/QuickEntryScreen';
import App, { LEGACY_TRANSFER_TARGET } from '../../src/App';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';
import { lastEntryDefaults, listTxnsByMonth, monthSummary } from '../../src/db/repos/txns';
import { accountBalance, createAccount, listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import type { Category } from '../../src/db/repos/categories';
import type { Account } from '../../src/domain/types';
import { todayLocalISO } from '../../src/domain/date';
import { createTag, getTxnTags } from '../../src/db/repos/tags';
import type { Tag } from '../../src/db/repos/tags';
import { createProject, projectTotals } from '../../src/db/repos/projects';
import type { Project } from '../../src/db/repos/projects';

/**
 * The screen itself is rendered with a fixed query result: SSR never runs
 * effects, so the real useQuery would only ever show its loading state. The
 * data shape is the one QuickEntryScreen's own query returns.
 */
const store = vi.hoisted(() => ({
  data: null as QuickEntryData | null,
  error: null as Error | null,
}));

vi.mock('../../src/store/useDb', () => ({
  useDb: () => ({ db: { fake: true }, revision: 0, bump: () => {}, error: null }),
  useQuery: () => ({ data: store.data, loading: store.data === null, error: store.error }),
}));

/** The save path must hand the chosen ids to setTxnTags, not just write rows. */
const setTxnProjectSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/db/repos/projects', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/db/repos/projects')>();
  return {
    ...actual,
    setTxnProject: (
      db: Parameters<typeof actual.setTxnProject>[0],
      txnId: string,
      projectId: string | null
    ) => {
      setTxnProjectSpy(txnId, projectId);
      return actual.setTxnProject(db, txnId, projectId);
    },
  };
});

const setTxnTagsSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/db/repos/tags', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/db/repos/tags')>();
  return {
    ...actual,
    setTxnTags: (
      db: Parameters<typeof actual.setTxnTags>[0],
      txnId: string,
      tagIds: readonly string[]
    ) => {
      setTxnTagsSpy(txnId, tagIds);
      return actual.setTxnTags(db, txnId, tagIds);
    },
  };
});

const FOOD: Category = {
  id: 'c-food',
  parentId: null,
  name: '饮食',
  kind: 'expense',
  sort: 0,
  archivedAt: null,
};

const SPORT: Category = {
  id: 'c-sport',
  parentId: null,
  name: '运动',
  kind: 'expense',
  sort: 1,
  archivedAt: null,
};

const SHUTTLECOCK: Category = {
  id: 'c-shuttlecock',
  parentId: SPORT.id,
  name: '羽毛球',
  kind: 'expense',
  sort: 2,
  archivedAt: null,
};

const REIMBURSEMENT: Category = {
  id: 'c-reimbursement',
  parentId: null,
  name: '报销',
  kind: 'income',
  sort: 0,
  archivedAt: null,
};

const NIGHT: Tag = { id: 'tag-night', name: '夜宵', color: null, archivedAt: null };
const ROOMMATE: Tag = { id: 'tag-roommate', name: '和室友', color: null, archivedAt: null };
const MOVED: Tag = {
  id: 'tag-moved',
  name: '搬家',
  color: null,
  archivedAt: '2026-10-01T00:00:00.000Z',
};

const TRIP: Project = {
  id: 'p-trip',
  name: '国庆去成都',
  status: 'active',
  budgetCents: 200000,
  startedDate: null,
  archivedDate: null,
  createdAt: '2026-09-30T00:00:00.000Z',
};

const OLD_PROJECT: Project = {
  ...TRIP,
  id: 'p-old',
  name: '换手机',
  status: 'archived',
  archivedDate: '2026-08-31T00:00:00.000Z',
};

const CARD: Account = {
  id: 'a-card',
  name: '饭卡',
  type: 'prepaid',
  initialBalanceCents: 75000,
  monthlyBudgetCents: 75000,
  sort: 0,
  archivedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
};

const WECHAT: Account = {
  ...CARD,
  id: 'a-wechat',
  name: '微信',
  type: 'ewallet',
  monthlyBudgetCents: null,
  sort: 1,
};

const BANK: Account = {
  ...CARD,
  id: 'a-bank',
  name: '银行卡',
  type: 'bank',
  monthlyBudgetCents: null,
  sort: 2,
};

const CASH: Account = {
  ...CARD,
  id: 'a-cash',
  name: '现金',
  type: 'cash',
  monthlyBudgetCents: null,
  sort: 3,
};

function quickEntryData(overrides: Partial<QuickEntryData> = {}): QuickEntryData {
  return {
    categories: [FOOD, SPORT, SHUTTLECOCK, REIMBURSEMENT],
    accounts: [CARD, WECHAT],
    tags: [NIGHT, ROOMMATE, MOVED],
    projects: [TRIP, OLD_PROJECT],
    lastUsed: {
      expense: { categoryId: FOOD.id, accountId: WECHAT.id },
      income: { categoryId: REIMBURSEMENT.id, accountId: CARD.id },
    },
    ...overrides,
  };
}

function validDraft(overrides: Partial<QuickEntryDraft> = {}): QuickEntryDraft {
  return {
    direction: 'expense',
    amount: '3.50',
    categoryId: FOOD.id,
    accountId: CARD.id,
    fromAccountId: '',
    toAccountId: '',
    note: '',
    tagIds: [],
    projectId: null,
    ...overrides,
  };
}

/** The same form filled in as a transfer: no category, two accounts. */
function transferDraft(overrides: Partial<QuickEntryDraft> = {}): QuickEntryDraft {
  return {
    direction: 'transfer',
    amount: '600',
    categoryId: null,
    accountId: '',
    fromAccountId: BANK.id,
    toAccountId: CARD.id,
    note: '',
    tagIds: [],
    projectId: null,
    ...overrides,
  };
}

function renderScreen(initialDirection?: 'expense' | 'income' | 'transfer'): string {
  return renderToString(
    <MemoryRouter initialEntries={['/']}>
      <QuickEntryScreen initialDirection={initialDirection} />
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

/** One serialized opening tag, selected by a data attribute. */
function openingTag(html: string, attribute: string): string {
  return html.match(new RegExp(`<[a-z]+[^>]*${attribute}[^>]*>`))?.[0] ?? '';
}

describe('planQuickEntry', () => {
  it('parses the typed amount into integer cents', () => {
    const plan = planQuickEntry(validDraft({ amount: '3.5' }));
    expect(plan.blocked).toBe(false);
    expect(plan.amountCents).toBe(350);
    expect(plan.problems).toEqual({
      amountInvalid: false,
      categoryInvalid: false,
      accountInvalid: false,
      fromAccountInvalid: false,
      toAccountInvalid: false,
      sameAccount: false,
    });
  });

  it('rejects zero, blank and malformed amounts while keeping the typed text', () => {
    for (const amount of ['0', '0.00', '', '   ', '3.456', '-3.50', '3,50', '3.50元']) {
      const plan = planQuickEntry(validDraft({ amount }));
      expect(plan.blocked).toBe(true);
      expect(plan.problems.amountInvalid).toBe(true);
      expect(plan.amountCents).toBeNull();
      // The plan never rewrites the input: the screen shows exactly what was typed.
      expect(plan.draft.amount).toBe(amount);
    }
  });

  // 清除所有数据 leaves the account list empty; the form must point somewhere
// instead of dead-ending on 无可用账户.
it('points at 账户 when there is none to pick', () => {
  store.data = quickEntryData({ accounts: [], lastUsed: { expense: { categoryId: null, accountId: null }, income: { categoryId: null, accountId: null } } });
  const html = renderScreen();

  expect(html).toContain('无可用账户');
  expect(html).toContain('还没有账户');
  expect(html).toContain('href="/accounts"');
});

it('requires a category and an account', () => {
    expect(planQuickEntry(validDraft({ categoryId: null })).problems).toEqual({
      amountInvalid: false,
      categoryInvalid: true,
      accountInvalid: false,
      fromAccountInvalid: false,
      toAccountInvalid: false,
      sameAccount: false,
    });
    expect(planQuickEntry(validDraft({ categoryId: '' })).problems.categoryInvalid).toBe(true);
    expect(planQuickEntry(validDraft({ accountId: '' })).problems).toEqual({
      amountInvalid: false,
      categoryInvalid: false,
      accountInvalid: true,
      fromAccountInvalid: false,
      toAccountInvalid: false,
      sameAccount: false,
    });
  });
});

/**
 * The transfer half of planning, moved here with the form. A transfer is not a
 * category-bearing entry: it must never demand a category or one single
 * account, and it must refuse a source equal to its destination.
 */
describe('planQuickEntry transfer', () => {
  it('parses the amount and asks for no category, because a transfer is never spending', () => {
    const plan = planQuickEntry(transferDraft({ amount: '599.99', categoryId: null }));

    expect(plan.amountCents).toBe(59999);
    expect(plan.blocked).toBe(false);
    expect(plan.problems).toEqual({
      amountInvalid: false,
      categoryInvalid: false,
      accountInvalid: false,
      fromAccountInvalid: false,
      toAccountInvalid: false,
      sameAccount: false,
    });
  });

  it('refuses zero, blank, negative and malformed amounts while keeping the typed text', () => {
    for (const amount of ['0', '0.00', '', '   ', '-1', '-0.01', 'abc', '6,00', '600.001', '600元']) {
      const plan = planQuickEntry(transferDraft({ amount }));

      expect(plan.amountCents).toBeNull();
      expect(plan.problems.amountInvalid).toBe(true);
      expect(plan.blocked).toBe(true);
      // A rejected submit must leave every keystroke in place.
      expect(plan.draft.amount).toBe(amount);
    }
  });

  it('refuses the same account on both sides', () => {
    const plan = planQuickEntry(transferDraft({ toAccountId: BANK.id }));

    expect(plan.problems.sameAccount).toBe(true);
    expect(plan.blocked).toBe(true);
  });

  it('refuses a missing account on either side without inventing a same-account error', () => {
    expect(planQuickEntry(transferDraft({ fromAccountId: '' })).problems.fromAccountInvalid).toBe(
      true
    );
    expect(planQuickEntry(transferDraft({ toAccountId: '' })).problems.toAccountInvalid).toBe(true);

    const empty = planQuickEntry(transferDraft({ fromAccountId: '', toAccountId: '' }));
    expect(empty.problems).toEqual({
      amountInvalid: false,
      categoryInvalid: false,
      accountInvalid: false,
      fromAccountInvalid: true,
      toAccountInvalid: true,
      sameAccount: false,
    });
    expect(empty.blocked).toBe(true);
  });
});

/**
 * 转出/转入 defaults, ported from the retired transfer page: the bank pays,
 * and a budgeted prepaid card receives, because that is the weekly top-up.
 */
describe('pickTransferDefaults', () => {
  it('picks the bank as 转出 and the budgeted account as 转入 by type and budget, not by name', () => {
    expect(pickTransferDefaults([CARD, BANK, WECHAT])).toEqual({
      fromAccountId: BANK.id,
      toAccountId: CARD.id,
    });

    const campus = { ...CARD, id: 'a-campus', name: '校园卡', monthlyBudgetCents: 20000 };
    const savings = { ...BANK, id: 'a-savings', name: '储蓄卡' };
    const wallet = { ...WECHAT, id: 'a-wallet', name: '零钱' };
    expect(pickTransferDefaults([campus, savings, wallet])).toEqual({
      fromAccountId: savings.id,
      toAccountId: campus.id,
    });
  });

  it('falls back to the first account and then the second live account', () => {
    expect(pickTransferDefaults([WECHAT, CASH])).toEqual({
      fromAccountId: WECHAT.id,
      toAccountId: CASH.id,
    });
    expect(pickTransferDefaults([CASH])).toEqual({ fromAccountId: CASH.id, toAccountId: '' });
    expect(pickTransferDefaults([])).toEqual({ fromAccountId: '', toAccountId: '' });
  });

  it('never preselects the same account on both sides', () => {
    const budgetedBank = { ...BANK, monthlyBudgetCents: 30000 };
    expect(pickTransferDefaults([budgetedBank, WECHAT])).toEqual({
      fromAccountId: budgetedBank.id,
      toAccountId: WECHAT.id,
    });
  });
});

describe('clampEntryDate', () => {
  it('keeps a past or today date and refuses the future, a blank and a malformed value', () => {
    expect(clampEntryDate('2026-10-20', '2026-10-21')).toBe('2026-10-20');
    expect(clampEntryDate('2026-10-21', '2026-10-21')).toBe('2026-10-21');
    expect(clampEntryDate('2026-10-22', '2026-10-21')).toBe('2026-10-21');
    expect(clampEntryDate('', '2026-10-21')).toBe('2026-10-21');
    expect(clampEntryDate('2026-1-5', '2026-10-21')).toBe('2026-10-21');
  });
});

describe('entryDateHint', () => {
  it('says nothing for today and names the day being back-filled otherwise', () => {
    expect(entryDateHint('2026-10-21', '2026-10-21')).toBeNull();
    expect(entryDateHint('2026-10-20', '2026-10-21')).toBe('补记 10月20日');
    expect(entryDateHint('2026-01-05', '2026-10-21')).toBe('补记 1月5日');
  });
});

describe('submitQuickEntry', () => {
  async function seeded() {
    const db = await createTestDb();
    await seedDefaults(db);
    await createAccount(db, { name: '饭卡', type: 'prepaid', monthlyBudgetCents: 75000 });
    const categories = await listCategories(db);
    const accounts = await listAccounts(db);
    return {
      db,
      food: categories.find(category => category.name === '饮食')!,
      sport: categories.find(category => category.name === '运动')!,
      reimbursement: categories.find(category => category.name === '报销')!,
      card: accounts.find(account => account.name === '饭卡')!,
    };
  }

  it('writes an expense with the expense sign and the supplied date', async () => {
    const { db, food, card } = await seeded();
    const result = await submitQuickEntry(
      db,
      '2026-10-20',
      validDraft({ categoryId: food.id, accountId: card.id, amount: '3.50' })
    );

    expect(result.written).toBe(true);
    const [row] = await listTxnsByMonth(db, '2026-10');
    expect(row).toMatchObject({
      occurredDate: '2026-10-20',
      direction: 'expense',
      amountCents: -350,
      categoryId: food.id,
      accountId: card.id,
    });
  });

  it('writes the optional note, and stores a blank note as the empty string', async () => {
    const { db, food, card } = await seeded();
    await submitQuickEntry(
      db,
      '2026-10-20',
      validDraft({ categoryId: food.id, accountId: card.id, amount: '3.50', note: '午饭' })
    );
    await submitQuickEntry(
      db,
      '2026-10-20',
      validDraft({ categoryId: food.id, accountId: card.id, amount: '2', note: '' })
    );

    const rows = await listTxnsByMonth(db, '2026-10');
    expect(rows.find(row => row.amountCents === -350)?.note).toBe('午饭');
    expect(rows.find(row => row.amountCents === -200)?.note).toBe('');
  });

  // A note of spaces is no note: the ledger would draw an empty line above the
  // account name for a row the user believes carries nothing.
  it('trims the note so a blank-looking note is stored blank', async () => {
    const { db, food, card } = await seeded();
    await submitQuickEntry(
      db,
      '2026-10-20',
      validDraft({ categoryId: food.id, accountId: card.id, amount: '3.50', note: '  午饭  ' })
    );
    await submitQuickEntry(
      db,
      '2026-10-20',
      validDraft({ categoryId: food.id, accountId: card.id, amount: '2', note: '   ' })
    );

    const rows = await listTxnsByMonth(db, '2026-10');
    expect(rows.find(row => row.amountCents === -350)?.note).toBe('午饭');
    expect(rows.find(row => row.amountCents === -200)?.note).toBe('');
  });

  it('writes the chosen tags after the row exists, with exactly those ids', async () => {
    const { db, food, card } = await seeded();
    const night = await createTag(db, '夜宵');
    const roommate = await createTag(db, '和室友');
    setTxnTagsSpy.mockClear();

    const result = await submitQuickEntry(
      db,
      '2026-10-20',
      validDraft({
        categoryId: food.id,
        accountId: card.id,
        amount: '8',
        tagIds: [night, roommate],
      })
    );

    expect(result.written).toBe(true);
    const [row] = await listTxnsByMonth(db, '2026-10');
    expect(setTxnTagsSpy).toHaveBeenCalledTimes(1);
    expect(setTxnTagsSpy).toHaveBeenCalledWith(row!.id, [night, roommate]);
    expect((await getTxnTags(db, row!.id)).map(tag => tag.name)).toEqual(['和室友', '夜宵']);
  });

  it('writes income as positive rather than as an expense', async () => {
    const { db, reimbursement, card } = await seeded();
    const result = await submitQuickEntry(
      db,
      '2026-10-20',
      validDraft({
        direction: 'income',
        categoryId: reimbursement.id,
        accountId: card.id,
        amount: '300',
      })
    );

    expect(result.written).toBe(true);
    const [row] = await listTxnsByMonth(db, '2026-10');
    expect(row).toMatchObject({
      direction: 'income',
      amountCents: 30000,
      categoryId: reimbursement.id,
    });
  });

  it('writes nothing for a zero amount or a missing category', async () => {
    const { db } = await seeded();
    const zero = await submitQuickEntry(db, '2026-10-20', validDraft({ amount: '0' }));
    const noCategory = await submitQuickEntry(
      db,
      '2026-10-20',
      validDraft({ categoryId: null, amount: '3.50' })
    );

    expect(zero.written).toBe(false);
    expect(zero.problems.amountInvalid).toBe(true);
    expect(noCategory.written).toBe(false);
    expect(noCategory.problems.categoryInvalid).toBe(true);
    expect(await listTxnsByMonth(db, '2026-10')).toEqual([]);
  });

  it('leaves earlier rows untouched when a later entry is rejected', async () => {
    const { db, food, card } = await seeded();
    await submitQuickEntry(db, '2026-10-01', validDraft({ categoryId: food.id, accountId: card.id }));
    const rejected = await submitQuickEntry(db, '2026-10-02', validDraft({ amount: 'x' }));

    expect(rejected.written).toBe(false);
    expect(await listTxnsByMonth(db, '2026-10')).toHaveLength(1);
  });

  it('points the new row at the chosen project after it exists, and writes nothing when none is chosen', async () => {
    const { db, food, card } = await seeded();
    const trip = await createProject(db, { name: '国庆去成都', budgetCents: 200000 });
    setTxnProjectSpy.mockClear();

    const result = await submitQuickEntry(
      db,
      '2026-10-20',
      validDraft({ categoryId: food.id, accountId: card.id, amount: '8', projectId: trip })
    );

    expect(result.written).toBe(true);
    const [row] = await listTxnsByMonth(db, '2026-10');
    expect(setTxnProjectSpy).toHaveBeenCalledTimes(1);
    expect(setTxnProjectSpy).toHaveBeenCalledWith(row!.id, trip);
    expect((await projectTotals(db)).find(total => total.id === trip)).toMatchObject({
      txnCount: 1,
      totalCents: 800,
    });

    // Selecting a project is optional: no choice means no second write at all.
    setTxnProjectSpy.mockClear();
    await submitQuickEntry(
      db,
      '2026-10-21',
      validDraft({ categoryId: food.id, accountId: card.id, amount: '2' })
    );
    expect(setTxnProjectSpy).not.toHaveBeenCalled();
    const afterSecond = await listTxnsByMonth(db, '2026-10');
    // The earlier row keeps its project; the new one has none.
    expect(afterSecond.find(row => row.amountCents === -200)?.projectId).toBeNull();
    expect(afterSecond.find(row => row.amountCents === -800)?.projectId).toBe(trip);
  });

  it('lets income point at a project without counting it as spending', async () => {
    const { db, reimbursement, card } = await seeded();
    const trip = await createProject(db, { name: '国庆去成都', budgetCents: 200000 });
    setTxnProjectSpy.mockClear();

    const result = await submitQuickEntry(
      db,
      '2026-10-20',
      validDraft({
        direction: 'income',
        categoryId: reimbursement.id,
        accountId: card.id,
        amount: '8',
        projectId: trip,
      })
    );

    expect(result.written).toBe(true);
    const [row] = await listTxnsByMonth(db, '2026-10');
    expect(row!.direction).toBe('income');
    expect(row!.projectId).toBe(trip);
    expect(setTxnProjectSpy).toHaveBeenCalledWith(row!.id, trip);
    expect((await projectTotals(db)).find(total => total.id === trip)).toMatchObject({
      txnCount: 1,
      totalCents: 0,
    });
  });
});

/**
 * The transfer write path, moved here from the retired /transfer screen. It
 * goes through createTransfer, so both legs and their signs stay in one
 * transaction; the quick-entry plan never re-implements them.
 */
describe('submitQuickEntry transfer', () => {
  async function seeded() {
    const db = await createTestDb();
    await seedDefaults(db);
    await createAccount(db, { name: '饭卡', type: 'prepaid', monthlyBudgetCents: 75000 });
    const accounts = await listAccounts(db);
    return {
      db,
      bank: accounts.find(account => account.type === 'bank')!,
      card: accounts.find(account => account.name === '饭卡')!,
    };
  }

  const txnCount = async (db: Awaited<ReturnType<typeof createTestDb>>): Promise<number> =>
    (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM txn'))?.n ?? 0;

  it('writes both legs: signed amounts under one group, the date and the trimmed note', async () => {
    const { db, bank, card } = await seeded();
    const result = await submitQuickEntry(
      db,
      '2026-10-20',
      transferDraft({
        fromAccountId: bank.id,
        toAccountId: card.id,
        amount: '600',
        note: '  充饭卡  ',
      })
    );

    expect(result.written).toBe(true);
    const groupId = result.transferGroupId;
    if (groupId === null) throw new Error('a written transfer must have a group id');

    const legs = await db.all<{
      amount_cents: number;
      account_id: string;
      direction: string;
      category_id: string | null;
      occurred_date: string;
      note: string;
    }>(
      `SELECT amount_cents, account_id, direction, category_id, occurred_date, note
       FROM txn WHERE transfer_group_id = ? ORDER BY amount_cents`,
      [groupId]
    );

    expect(legs).toHaveLength(2);
    expect(legs.map(leg => leg.amount_cents)).toEqual([-60000, 60000]);
    expect(legs.map(leg => leg.account_id)).toEqual([bank.id, card.id]);
    for (const leg of legs) {
      expect(leg).toMatchObject({
        direction: 'transfer',
        category_id: null,
        occurred_date: '2026-10-20',
        note: '充饭卡',
      });
    }
  });

  it('moves both balances and is neither spending nor income', async () => {
    const { db, bank, card } = await seeded();
    const bankBefore = await accountBalance(db, bank.id);
    const cardBefore = await accountBalance(db, card.id);

    await submitQuickEntry(
      db,
      '2026-10-20',
      transferDraft({ fromAccountId: bank.id, toAccountId: card.id, amount: '600' })
    );

    expect(await accountBalance(db, bank.id)).toBe(bankBefore - 60000);
    expect(await accountBalance(db, card.id)).toBe(cardBefore + 60000);
    expect(await monthSummary(db, '2026-10')).toMatchObject({
      expenseCents: 0,
      incomeCents: 0,
    });
  });

  // The whole point of the merge: a transfer may be back-filled a month or more.
  it('keeps the chosen past date on both legs, so the transfer lands in that month only', async () => {
    const { db, bank, card } = await seeded();

    await submitQuickEntry(
      db,
      '2026-08-15',
      transferDraft({ fromAccountId: bank.id, toAccountId: card.id, amount: '600' })
    );

    const august = await listTxnsByMonth(db, '2026-08');
    expect(august).toHaveLength(2);
    expect(august.every(row => row.occurredDate === '2026-08-15')).toBe(true);
    // Nothing leaked into the current month or the day the form was filled in.
    expect(await listTxnsByMonth(db, '2026-10')).toEqual([]);
  });

  it('writes nothing when the same account is chosen on both sides', async () => {
    const { db, bank } = await seeded();
    const before = await txnCount(db);

    const result = await submitQuickEntry(
      db,
      '2026-10-20',
      transferDraft({ fromAccountId: bank.id, toAccountId: bank.id, amount: '600' })
    );

    expect(result.written).toBe(false);
    expect(result.transferGroupId).toBeNull();
    expect(result.problems.sameAccount).toBe(true);
    expect(await txnCount(db)).toBe(before);
  });

  it('writes nothing for a zero, malformed or missing account draft', async () => {
    const { db, bank, card } = await seeded();
    const before = await txnCount(db);

    for (const amount of ['0', '', 'abc', '-600']) {
      const result = await submitQuickEntry(
        db,
        '2026-10-20',
        transferDraft({ fromAccountId: bank.id, toAccountId: card.id, amount })
      );
      expect(result.written).toBe(false);
      expect(result.problems.amountInvalid).toBe(true);
    }

    const noSource = await submitQuickEntry(
      db,
      '2026-10-20',
      transferDraft({ fromAccountId: '', toAccountId: card.id })
    );
    expect(noSource.written).toBe(false);
    expect(noSource.problems.fromAccountInvalid).toBe(true);

    const noDestination = await submitQuickEntry(
      db,
      '2026-10-20',
      transferDraft({ fromAccountId: bank.id, toAccountId: '' })
    );
    expect(noDestination.written).toBe(false);
    expect(noDestination.problems.toAccountInvalid).toBe(true);

    expect(await txnCount(db)).toBe(before);
  });

  // Tags and a project may still be selected from a previous 支出 draft on the
  // same form; a transfer must not carry either onto its legs.
  it('writes no tags and no project, even when the form still holds a choice', async () => {
    const { db, bank, card } = await seeded();
    setTxnTagsSpy.mockClear();
    setTxnProjectSpy.mockClear();

    const result = await submitQuickEntry(
      db,
      '2026-10-20',
      transferDraft({
        fromAccountId: bank.id,
        toAccountId: card.id,
        tagIds: [NIGHT.id],
        projectId: TRIP.id,
      })
    );

    expect(result.written).toBe(true);
    expect(setTxnTagsSpy).not.toHaveBeenCalled();
    expect(setTxnProjectSpy).not.toHaveBeenCalled();
    const [row] = await listTxnsByMonth(db, '2026-10');
    expect(await getTxnTags(db, row!.id)).toEqual([]);
  });

  it('leaves for 今天 exactly as an expense save does, after writing both legs', async () => {
    const { db, bank, card } = await seeded();
    const calls: string[] = [];
    const onSaved = vi.fn(() => {
      calls.push('saved');
    });
    const navigate = vi.fn((to: string, options: { replace: true }) => {
      calls.push(`navigate:${to}:${String(options.replace)}`);
    });

    const result = await saveQuickEntryAndLeave(
      db,
      '2026-09-15',
      transferDraft({ fromAccountId: bank.id, toAccountId: card.id }),
      { onSaved, navigate }
    );

    expect(result.written).toBe(true);
    expect(calls).toEqual(['saved', 'navigate:/:true']);
    expect(await listTxnsByMonth(db, '2026-09')).toHaveLength(2);
  });
});

describe('saveQuickEntryAndLeave', () => {
  async function seeded() {
    const db = await createTestDb();
    await seedDefaults(db);
    await createAccount(db, { name: '饭卡', type: 'prepaid', monthlyBudgetCents: 75000 });
    const categories = await listCategories(db);
    const accounts = await listAccounts(db);
    return {
      db,
      food: categories.find(category => category.name === '饮食')!,
      card: accounts.find(account => account.name === '饭卡')!,
    };
  }

  it('writes the row, bumps the list, then replaces history with the today list', async () => {
    const { db, food, card } = await seeded();
    const calls: string[] = [];
    const onSaved = vi.fn(() => {
      calls.push('saved');
    });
    const navigate = vi.fn((to: string, options: { replace: true }) => {
      calls.push(`navigate:${to}:${String(options.replace)}`);
    });

    const result = await saveQuickEntryAndLeave(
      db,
      '2026-10-20',
      validDraft({ categoryId: food.id, accountId: card.id, amount: '3.50' }),
      { onSaved, navigate }
    );

    expect(result.written).toBe(true);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/', { replace: true });
    expect(calls).toEqual(['saved', 'navigate:/:true']);
    expect(await listTxnsByMonth(db, '2026-10')).toHaveLength(1);
  });

  it('stays on the form and writes nothing when the draft is refused', async () => {
    const { db, food, card } = await seeded();
    const onSaved = vi.fn();
    const navigate = vi.fn();

    const result = await saveQuickEntryAndLeave(
      db,
      '2026-10-20',
      validDraft({ categoryId: food.id, accountId: card.id, amount: '0' }),
      { onSaved, navigate }
    );

    expect(result.written).toBe(false);
    expect(result.problems.amountInvalid).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(await listTxnsByMonth(db, '2026-10')).toEqual([]);
  });
});

describe('lastEntryDefaults', () => {
  it('reads the newest live row of the requested direction only', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    await createAccount(db, { name: '饭卡', type: 'prepaid', monthlyBudgetCents: 75000 });
    const categories = await listCategories(db);
    const accounts = await listAccounts(db);
    const food = categories.find(category => category.name === '饮食')!;
    const sport = categories.find(category => category.name === '运动')!;
    const reimbursement = categories.find(category => category.name === '报销')!;
    const card = accounts.find(account => account.name === '饭卡')!;

    await submitQuickEntry(
      db,
      '2026-10-01',
      validDraft({ categoryId: food.id, accountId: card.id, amount: '1' })
    );
    await submitQuickEntry(
      db,
      '2026-10-19',
      validDraft({ categoryId: sport.id, accountId: card.id, amount: '2' })
    );
    await submitQuickEntry(
      db,
      '2026-10-20',
      validDraft({
        direction: 'income',
        categoryId: reimbursement.id,
        accountId: card.id,
        amount: '3',
      })
    );

    expect(await lastEntryDefaults(db, 'expense')).toEqual({
      categoryId: sport.id,
      accountId: card.id,
    });
    expect(await lastEntryDefaults(db, 'income')).toEqual({
      categoryId: reimbursement.id,
      accountId: card.id,
    });
  });

  it('returns nulls when there is no history yet', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    expect(await lastEntryDefaults(db, 'expense')).toEqual({
      categoryId: null,
      accountId: null,
    });
  });
});

describe('applyAmountKey', () => {
  it('builds a decimal amount and refuses a second dot or a third decimal', () => {
    expect(applyAmountKey('', '3')).toBe('3');
    expect(applyAmountKey('3', '.')).toBe('3.');
    expect(applyAmountKey('3.', '5')).toBe('3.5');
    expect(applyAmountKey('3.5', '0')).toBe('3.50');
    expect(applyAmountKey('3.50', '0')).toBe('3.50');
    expect(applyAmountKey('3.50', '.')).toBe('3.50');
  });

  it('handles 00, backspace, clear and the leading zero', () => {
    expect(applyAmountKey('1', '00')).toBe('100');
    expect(applyAmountKey('', '00')).toBe('0');
    expect(applyAmountKey('', '.')).toBe('0.');
    expect(applyAmountKey('0', '5')).toBe('5');
    expect(applyAmountKey('3.50', 'del')).toBe('3.5');
    expect(applyAmountKey('3.50', 'clr')).toBe('');
  });

  it('caps the integer part at seven digits', () => {
    expect(applyAmountKey('1234567', '8')).toBe('1234567');
    expect(applyAmountKey('123456', '7')).toBe('1234567');
  });
});

describe('amountDraftDisplay', () => {
  it('shows the typed draft, grouping thousands without forcing decimals', () => {
    expect(amountDraftDisplay('', 'expense')).toBe('0.00');
    expect(amountDraftDisplay('36.5', 'expense')).toBe('−36.5');
    expect(amountDraftDisplay('36.5', 'income')).toBe('36.5');
    expect(amountDraftDisplay('1200', 'expense')).toBe('−1,200');
    expect(amountDraftDisplay('0', 'expense')).toBe('0');
  });
});

describe('QuickEntryScreen', () => {
  it('says plainly when the pickers are still loading or failed', () => {
  store.data = null;
  store.error = null;
  const loading = renderScreen();
  expect(loading).toContain('正在加载账户和分类…');
  const loadingSave = loading.match(/<button[^>]*data-action="save"[^>]*>/)?.[0] ?? '';
  expect(loadingSave).toContain('disabled');

  store.error = new Error('数据层未就绪');
  const failed = renderScreen();
  expect(failed).toContain('账户和分类加载失败');
  store.error = null;
});

it('opens as a bottom sheet on 支出 with the last used category and account selected', () => {
    store.data = quickEntryData();
    const html = renderScreen();

    expect(html).toContain('class="entry-sheet"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('data-entry-close');
    expect(html).toContain('class="entry-keypad"');
    expect(html).toContain('>随手记</h1>');

    expect(openingTag(html, 'data-direction="expense"')).toContain('aria-pressed="true"');
    expect(openingTag(html, 'data-direction="income"')).toContain('aria-pressed="false"');
    expect(openingTag(html, 'data-direction="transfer"')).toContain('aria-pressed="false"');

    // The category and account are chips now, not picker triggers over selects.
    expect(openingTag(html, 'data-category-id="c-food"')).toContain('aria-pressed="true"');
    expect(openingTag(html, 'data-account-id="a-wechat"')).toContain('aria-pressed="true"');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('data-category-trigger');
    // The keyboard is in the app, so the amount is a display rather than an input.
    expect(html).toContain('0.00');
    expect(html).toContain('data-key="7"');
    expect(html).toContain('data-action="save"');
  });

  it('shows a top category’s children under 细分 and keeps the top selected', () => {
    store.data = quickEntryData({
      lastUsed: {
        expense: { categoryId: SHUTTLECOCK.id, accountId: WECHAT.id },
        income: { categoryId: REIMBURSEMENT.id, accountId: CARD.id },
      },
    });
    const html = renderScreen();

    expect(openingTag(html, 'data-category-id="c-sport"')).toContain('aria-pressed="true"');
    expect(openingTag(html, 'data-subcategory-id="c-shuttlecock"')).toContain(
      'aria-pressed="true"'
    );
    expect(openingTag(html, 'data-subcategory-id=""')).toContain('aria-pressed="false"');
    expect(html).toContain('细分（可不选）');
    expect(html).toContain('羽毛球');
  });

  it('offers live tags as chips and an inline new-tag control', () => {
    store.data = quickEntryData();
    const html = renderScreen();

    expect(html).toContain('data-tag-id="tag-night"');
    expect(html).toContain('data-tag-id="tag-roommate"');
    expect(html).not.toContain('data-tag-id="tag-moved"');
    expect(html).toContain('data-tag-new="true"');
    expect(html).toContain('＋ 新标签');
    expect(html).not.toContain('data-tag-trigger');
  });

  it('offers projects to income as well as to expense', () => {
    store.data = quickEntryData();
    const html = renderScreen('income');

    expect(html).toContain('data-project-id="p-trip"');
    expect(html).toContain('>不归项目<');
  });

  it('offers active projects after tags and before the date', () => {
    store.data = quickEntryData();
    const html = renderScreen();

    expect(openingTag(html, 'data-project-clear="true"')).toContain('aria-pressed="true"');
    expect(html).toContain('data-project-id="p-trip"');
    expect(html).not.toContain('data-project-id="p-old"');

    const order = ['data-tag-id="tag-night"', 'data-project-id="p-trip"', 'id="add-date"'].map(
      marker => html.indexOf(marker)
    );
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('puts 日期 and 备注 after 项目, with the date capped at today and a blank note', () => {
    store.data = quickEntryData();
    const html = renderScreen();
    const today = todayLocalISO();

    const date = openingTag(html, 'id="add-date"');
    expect(date).toContain('type="date"');
    expect(date).toContain(`value="${today}"`);
    expect(date).toContain(`max="${today}"`);

    const note = openingTag(html, 'id="add-note"');
    expect(note).toContain('type="text"');
    expect(note).toContain('value=""');
    expect(note).toContain('备注（可不填）');

    const order = [
      'data-category-id="c-food"',
      'data-account-id="a-wechat"',
      'data-tag-id="tag-night"',
      'data-project-id="p-trip"',
      'id="add-date"',
      'id="add-note"',
      'class="entry-keypad"',
    ].map(marker => html.indexOf(marker));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('opens 转账 with the two account sides and nothing categorised', () => {
    store.data = quickEntryData();
    const html = renderScreen('transfer');
    const today = todayLocalISO();

    expect(openingTag(html, 'data-direction="transfer"')).toContain('aria-pressed="true"');
    expect(openingTag(html, 'data-direction="expense"')).toContain('aria-pressed="false"');

    expect(html).toContain('>从</span>');
    expect(html).toContain('>到</span>');
    // There is no bank in this fixture: 转出 falls back to 饭卡, and 转入 skips
    // it for 微信 rather than starting on an invalid pair.
    expect(openingTag(html, 'data-from-account-id="a-card"')).toContain('aria-pressed="true"');
    expect(openingTag(html, 'data-to-account-id="a-wechat"')).toContain('aria-pressed="true"');

    expect(html).not.toContain('data-category-id=');
    expect(html).not.toContain('data-tag-id=');
    expect(html).not.toContain('data-project-id=');
    expect(html).not.toContain('>分类</span>');
    expect(html).not.toContain('>标签</span>');
    expect(html).not.toContain('>项目</span>');

    const date = openingTag(html, 'id="add-date"');
    expect(date).toContain('type="date"');
    expect(date).toContain(`max="${today}"`);
    expect(openingTag(html, 'id="add-note"')).toContain('placeholder="备注（可不填）"');
    expect(html).toContain('data-action="save"');
    expect(html).not.toContain('确认转账');
  });

  it('falls back to no selected category when the last one is no longer live', () => {
    store.data = quickEntryData({
      lastUsed: {
        expense: { categoryId: 'c-archived', accountId: WECHAT.id },
        income: { categoryId: REIMBURSEMENT.id, accountId: CARD.id },
      },
    });
    const html = renderScreen();

    expect(html).not.toContain('data-category-id="c-archived"');
    // Top categories are still offered, but none claims to be chosen.
    expect(html).toContain('data-category-id="c-food"');
    expect(html.match(/data-category-id="[^"]+"[^>]*aria-pressed="true"/g) ?? []).toHaveLength(0);
  });

  it('sends the retired /transfer route to /add instead of the old transfer form', () => {
    store.data = quickEntryData();
    expect(LEGACY_TRANSFER_TARGET).toBe('/add');

    const html = renderToString(
      <MemoryRouter initialEntries={['/transfer']}>
        <App />
      </MemoryRouter>
    ).replace(/<!-- -->/g, '');

    // The old screen is gone; the route is now only a redirect into the sheet.
    expect(html).not.toContain('<h1>转账</h1>');
    expect(html).not.toContain('transfer-screen');
    expect(html).not.toContain('id="transfer-from"');
    // SSR renders the redirect target on the next location; the absence above
    // is what this test can pin without a browser.
  });

  it('keeps the page that opened it underneath the sheet', () => {
    store.data = quickEntryData();
    const html = renderToString(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/add',
            state: {
              backgroundLocation: {
                pathname: '/ledger',
                search: '',
                hash: '',
                state: null,
                key: 'ledger-under-sheet',
              },
            },
          },
        ]}
      >
        <App />
      </MemoryRouter>
    ).replace(/<!-- -->/g, '');

    expect(html).toContain('class="ledger-screen"');
    expect(html).toContain('class="entry-sheet"');
    expect(html).not.toContain('class="dock"');
  });

  it('is a modal over the page that opened it, not a pushed page', () => {
    store.data = quickEntryData();
    const html = renderToString(
      <MemoryRouter initialEntries={['/add']}>
        <App />
      </MemoryRouter>
    ).replace(/<!-- -->/g, '');

    expect(html).toContain('随手记');
    expect(html).toContain('class="entry-sheet"');
    expect(html).toContain('data-entry-close');
    // A direct /add has no saved page underneath, so 今天 stands in.
    expect(html).toContain('<h1>今天</h1>');
    // The dock belongs to the page, not the sheet.
    expect(html).not.toContain('class="dock"');
    expect(html).not.toContain('class="add-back"');
  });
});