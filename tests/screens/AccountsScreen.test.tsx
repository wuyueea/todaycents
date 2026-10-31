import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import AccountsScreen, {
  accountEditDraftFor,
  archiveAccountWithConfirm,
  loadAccountsData,
  parseReconciliationAmount,
  planAccountCreate,
  planAccountEdit,
  submitAccountCreate,
  submitAccountEdit,
} from '../../src/screens/AccountsScreen';
import type {
  AccountDraft,
  AccountEditDraft,
  AccountsData,
} from '../../src/screens/AccountsScreen';
import type { Account } from '../../src/domain/types';
import {
  accountBalance,
  allBalances,
  archiveAccount,
  createAccount,
  listAccounts,
} from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import { createExpense, listTxnsByMonth } from '../../src/db/repos/txns';
import type { Db } from '../../src/db/driver';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';

/**
 * A first launch plus 饭卡, the budgeted prepaid card these tests edit. It is
 * not starter data any more, so the fixture creates it explicitly.
 */
async function seedWithCard(db: Db): Promise<void> {
  await seedDefaults(db);
  await createAccount(db, { name: '饭卡', type: 'prepaid', monthlyBudgetCents: 75000 });
}

/**
 * SSR never runs effects, so the real useQuery would only ever show its loading
 * state. The screen is rendered with the exact AccountsData its query returns.
 */
const store = vi.hoisted(() => ({ data: null as AccountsData | null }));

vi.mock('../../src/store/useDb', () => ({
  useDb: () => ({ db: { fake: true }, revision: 0, bump: () => {}, error: null }),
  useQuery: () => ({ data: store.data, loading: store.data === null, error: null }),
}));

function account(overrides: Partial<Account> & Pick<Account, 'id' | 'name' | 'type'>): Account {
  return {
    initialBalanceCents: 0,
    monthlyBudgetCents: null,
    sort: 0,
    archivedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const CAT = account({ id: 'a-cat', name: '猫咪基金', type: 'ewallet', monthlyBudgetCents: 30000 });
const TRIP = account({ id: 'a-trip', name: '旅行基金', type: 'bank' });

function accountsData(overrides: Partial<AccountsData> = {}): AccountsData {
  return {
    accounts: [CAT, TRIP],
    balances: { 'a-cat': 12345, 'a-trip': -700 },
    txnCounts: {},
    ...overrides,
  };
}

/** 账户 is a pushed page; it needs a router even though SSR never runs effects. */
function renderScreen(): string {
  return renderToString(
    <MemoryRouter initialEntries={['/accounts']}>
      <AccountsScreen />
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

/** One account's rendered block, from its data attribute to its closing tag. */
function rowHtml(html: string, accountId: string): string {
  return (
    new RegExp(`<li[^>]*data-account-id="${accountId}"[\\s\\S]*?</li>`).exec(html)?.[0] ?? ''
  );
}

function createDraft(overrides: Partial<AccountDraft> = {}): AccountDraft {
  return {
    name: '猫咪基金',
    type: 'ewallet',
    initialBalance: '12.34',
    monthlyBudget: '300',
    ...overrides,
  };
}

function editDraft(overrides: Partial<AccountEditDraft> = {}): AccountEditDraft {
  return { name: '旅行基金', type: 'bank', monthlyBudget: '', ...overrides };
}

describe('planAccountCreate', () => {
  it('trims the name and parses both money fields once', () => {
    const plan = planAccountCreate(createDraft({ name: '  猫咪基金  ' }));
    expect(plan.blocked).toBe(false);
    expect(plan.input).toEqual({
      name: '猫咪基金',
      type: 'ewallet',
      initialBalanceCents: 1234,
      monthlyBudgetCents: 30000,
    });
  });

  it('treats an empty initial balance as 0 and an empty budget as no budget', () => {
    const plan = planAccountCreate(createDraft({ initialBalance: '', monthlyBudget: '   ' }));
    expect(plan.input).toEqual({
      name: '猫咪基金',
      type: 'ewallet',
      initialBalanceCents: 0,
      monthlyBudgetCents: null,
    });
  });

  it('refuses a blank name, a negative initial balance and a bad budget', () => {
    const blankName = planAccountCreate(createDraft({ name: '   ' }));
    expect(blankName.problems.nameInvalid).toBe(true);
    expect(blankName.blocked).toBe(true);
    expect(blankName.input).toBeNull();

    const negativeInitial = planAccountCreate(createDraft({ initialBalance: '-12.34' }));
    expect(negativeInitial.problems.initialBalanceInvalid).toBe(true);
    expect(negativeInitial.blocked).toBe(true);
    expect(negativeInitial.input).toBeNull();

    expect(planAccountCreate(createDraft({ monthlyBudget: '0' })).problems.monthlyBudgetInvalid).toBe(
      true
    );
    expect(
      planAccountCreate(createDraft({ monthlyBudget: '-1' })).problems.monthlyBudgetInvalid
    ).toBe(true);
    expect(
      planAccountCreate(createDraft({ monthlyBudget: '1.234' })).problems.monthlyBudgetInvalid
    ).toBe(true);
  });
});

describe('planAccountEdit', () => {
  it('plans a rename, retype and budget change', () => {
    const plan = planAccountEdit(
      editDraft({ name: '  旅行基金  ', type: 'cash', monthlyBudget: '250.00' })
    );
    expect(plan.blocked).toBe(false);
    expect(plan.patch).toEqual({ name: '旅行基金', type: 'cash', monthlyBudgetCents: 25000 });
  });

  it('clears the budget when the edit leaves it blank', () => {
    expect(planAccountEdit(editDraft()).patch).toEqual({
      name: '旅行基金',
      type: 'bank',
      monthlyBudgetCents: null,
    });
  });

  it('refuses a blank name and a bad budget', () => {
    const blank = planAccountEdit(editDraft({ name: '  ' }));
    expect(blank.problems.nameInvalid).toBe(true);
    expect(blank.patch).toBeNull();

    expect(planAccountEdit(editDraft({ monthlyBudget: '-5' })).problems.monthlyBudgetInvalid).toBe(
      true
    );
  });

  it('includes the opening balance only while the account has no transactions', () => {
    const editable = planAccountEdit(
      editDraft({ initialBalance: '120.00', initialBalanceEditable: true })
    );
    expect(editable.patch).toMatchObject({ initialBalanceCents: 12000 });

    const frozen = planAccountEdit(
      editDraft({ initialBalance: '120.00', initialBalanceEditable: false })
    );
    expect(frozen.patch).not.toHaveProperty('initialBalanceCents');

    const bad = planAccountEdit(
      editDraft({ initialBalance: '-1', initialBalanceEditable: true })
    );
    expect(bad.problems.initialBalanceInvalid).toBe(true);
    expect(bad.patch).toBeNull();
  });
});

describe('parseReconciliationAmount', () => {
  it('treats a blank field as 0 and parses every other amount once', () => {
    expect(parseReconciliationAmount('')).toBe(0);
    expect(parseReconciliationAmount('   ')).toBe(0);
    expect(parseReconciliationAmount('9000')).toBe(900000);
    expect(parseReconciliationAmount('90.05')).toBe(9005);
  });

  it('rejects negative, over-precise or literal-zero text instead of rounding it', () => {
    for (const text of ['0', '0.00', '-1', '1.234', '12,30', '12.30元']) {
      expect(parseReconciliationAmount(text)).toBeNull();
    }
  });
});

describe('account writes', () => {
  it('writes a new account only when the draft is valid', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    const before = (await listAccounts(db)).length;

    const blocked = await submitAccountCreate(db, createDraft({ name: '' }));
    expect(blocked.created).toBe(false);
    expect((await listAccounts(db)).length).toBe(before);

    const result = await submitAccountCreate(
      db,
      createDraft({ name: '猫咪基金', type: 'ewallet', initialBalance: '12.34', monthlyBudget: '' })
    );
    expect(result.created).toBe(true);

    const accounts = await listAccounts(db);
    expect(accounts).toHaveLength(before + 1);
    const created = accounts.find(candidate => candidate.name === '猫咪基金')!;
    expect(created.initialBalanceCents).toBe(1234);
    expect(created.monthlyBudgetCents).toBeNull();

    const data = await loadAccountsData(db);
    expect(data.accounts.some(candidate => candidate.id === created.id)).toBe(true);
    expect(data.balances[created.id]).toBe(1234);
  });

  it('renames, retypes and re-budgets without touching the derived balance', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    await submitAccountCreate(
      db,
      createDraft({ name: '旅行基金', type: 'bank', initialBalance: '100.00', monthlyBudget: '' })
    );
    const created = (await listAccounts(db)).find(candidate => candidate.name === '旅行基金')!;
    const balanceBefore = await accountBalance(db, created.id);

    const saved = await submitAccountEdit(db, created.id, {
      name: '旅行基金 2026',
      type: 'cash',
      monthlyBudget: '250.00',
    });
    expect(saved.saved).toBe(true);

    const edited = (await listAccounts(db)).find(candidate => candidate.id === created.id)!;
    expect(edited).toMatchObject({
      name: '旅行基金 2026',
      type: 'cash',
      monthlyBudgetCents: 25000,
    });
    expect(await accountBalance(db, created.id)).toBe(balanceBefore);

    await submitAccountEdit(db, created.id, {
      name: '旅行基金 2026',
      type: 'cash',
      monthlyBudget: '',
    });
    expect(
      (await listAccounts(db)).find(candidate => candidate.id === created.id)?.monthlyBudgetCents
    ).toBeNull();
  });

  it('renames a zero-opening account with the draft the edit screen opens', async () => {
    const db = await createTestDb();
    await seedWithCard(db);
    const card = (await listAccounts(db)).find(account => account.name === '饭卡')!;
    expect(card.initialBalanceCents).toBe(0);
    expect(await listTxnsByMonth(db, '2026-10')).toHaveLength(0);

    const draft = accountEditDraftFor(card, 0);
    // Zero is shown as a blank field with the 0.00 placeholder; "0.00" itself is
    // not a value parseAmountToCents accepts.
    expect(draft.initialBalance).toBe('');
    expect(draft.initialBalanceEditable).toBe(true);

    const saved = await submitAccountEdit(db, card.id, { ...draft, name: '饭卡 2026' });
    expect(saved.saved).toBe(true);

    const edited = (await listAccounts(db)).find(account => account.id === card.id)!;
    expect(edited).toMatchObject({ name: '饭卡 2026', initialBalanceCents: 0 });
  });

  it('changes the budget of a zero-opening account without tripping the opening field', async () => {
    const db = await createTestDb();
    await seedWithCard(db);
    const card = (await listAccounts(db)).find(account => account.name === '饭卡')!;
    const draft = accountEditDraftFor(card, 0);

    const saved = await submitAccountEdit(db, card.id, { ...draft, monthlyBudget: '200.00' });
    expect(saved.saved).toBe(true);

    const edited = (await listAccounts(db)).find(account => account.id === card.id)!;
    expect(edited).toMatchObject({ monthlyBudgetCents: 20000, initialBalanceCents: 0 });
  });

  it('still formats a non-zero opening balance and freezes it once history exists', () => {
    const funded = accountEditDraftFor({ ...CAT, initialBalanceCents: 12000 }, 0);
    expect(funded.initialBalance).toBe('120.00');
    expect(funded.initialBalanceEditable).toBe(true);

    const frozen = accountEditDraftFor({ ...CAT, initialBalanceCents: 12000 }, 1);
    expect(frozen.initialBalance).toBe('120.00');
    expect(frozen.initialBalanceEditable).toBe(false);
  });

  it('archives only after the confirmation, and includeArchived can show the row again', async () => {
    const db = await createTestDb();
    await seedWithCard(db);
    const card = (await listAccounts(db)).find(account => account.name === '饭卡')!;
    const balanceBefore = await accountBalance(db, card.id);
    let asked = '';

    const declined = await archiveAccountWithConfirm(db, card, message => {
      asked = message;
      return false;
    });
    expect(declined).toBe(false);
    expect(asked).toContain('归档');
    expect((await listAccounts(db)).some(account => account.id === card.id)).toBe(true);

    const archived = await archiveAccountWithConfirm(db, card, () => true);
    expect(archived).toBe(true);
    expect((await loadAccountsData(db)).accounts.some(item => item.id === card.id)).toBe(false);

    const withArchived = await loadAccountsData(db, { includeArchived: true });
    expect(withArchived.accounts.find(item => item.id === card.id)?.archivedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    );
    expect(await accountBalance(db, card.id)).toBe(balanceBefore);
  });

  it('archives softly: the account leaves the list while its history and balance stay', async () => {
    const db = await createTestDb();
    await seedWithCard(db);
    const accounts = await listAccounts(db);
    const card = accounts.find(candidate => candidate.name === '饭卡')!;
    const categories = await listCategories(db);
    const food = categories.find(category => category.name === '饮食')!;
    await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1250,
      categoryId: food.id,
    });

    const beforeArchive = await loadAccountsData(db);
    expect(beforeArchive.accounts.some(item => item.id === card.id)).toBe(true);
    expect(beforeArchive.txnCounts[card.id]).toBe(1);

    await archiveAccount(db, card.id);

    const after = await loadAccountsData(db);
    expect(after.accounts.some(item => item.id === card.id)).toBe(false);
    expect(after.balances[card.id]).toBe(-1250);
    expect((await allBalances(db))[card.id]).toBe(-1250);
    expect((await listTxnsByMonth(db, '2026-10')).some(row => row.accountId === card.id)).toBe(
      true
    );
  });
});

describe('AccountsScreen', () => {
  it('renders the live accounts with type, balance and budget', () => {
    store.data = accountsData();
    const html = renderScreen();

    expect(html).toContain('<h1>账户</h1>');
    expect(html).toContain('猫咪基金');
    expect(html).toContain('旅行基金');
    expect(html).toContain('电子钱包');
    expect(html).toContain('银行卡');
    expect(html).toContain('123.45');
    expect(html).toContain('−7.00');
    expect(html).toContain('额度 300.00');

    const tripRow = rowHtml(html, 'a-trip');
    // Row actions stay hidden until the row is selected; the add action is fixed.
    expect(tripRow).toContain('data-account-row');
    expect(tripRow).not.toContain('>编辑<');
    expect(html).not.toContain('>对账<');
    expect(html).toContain('＋ 新增账户');
    expect(tripRow).not.toContain('额度 ');
    expect(rowHtml(html, 'a-cat')).toContain('额度 300.00');
  });

  it('offers a blank form with all four account types and no hardcoded account list', () => {
    store.data = accountsData();
    const html = renderScreen();

    expect(html).toContain('id="account-name"');
    expect(html).toContain('id="account-type"');
    expect(html).toContain('id="account-initial"');
    expect(html).toContain('id="account-budget"');
    expect(html).toContain('期初余额');
    expect(html).toContain('月度额度');
    expect(html).toContain('新增账户');
    for (const label of ['现金', '银行卡', '电子钱包', '预付卡']) {
      expect(html).toContain(label);
    }
  });

  it('never renders an archived account as live', () => {
    store.data = accountsData({
      accounts: [CAT, { ...TRIP, archivedAt: '2026-10-01T00:00:00.000Z' }],
    });
    const html = renderScreen();

    expect(html).toContain('猫咪基金');
    expect(html).not.toContain('旅行基金');
  });

  it('offers the add action and the 显示已归档 switch without a paragraph about it', () => {
    store.data = accountsData();
    const html = renderScreen();

    expect(html).toContain('＋ 新增账户');
    expect(html).toContain('显示已归档');
    expect(html).toMatch(/type="checkbox"/);
    // The page no longer explains itself; the controls carry the meaning.
    expect(html).not.toContain('历史流水仍然保留');
  });

  // The 转账 shortcut moved into 随手记, so 账户 opens on its own list.
  it('no longer offers a 转账 row and puts the archived switch under the list', () => {
    store.data = accountsData();
    const html = renderScreen();

    expect(html).not.toContain('href="/transfer"');
    expect(html).not.toContain('accounts-transfer');
    expect(html).not.toContain('两个账户间的金额转移');

    const toggle = html.indexOf('accounts-toggle');
    const list = html.indexOf('accounts-list');
    expect(toggle).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(-1);
    expect(list).toBeLessThan(toggle);
    expect(html.slice(list, toggle)).not.toContain('转账');
  });

  it('says there are no accounts yet and still offers the form', () => {
    store.data = accountsData({ accounts: [], balances: {} });
    const html = renderScreen();

    expect(html).toContain('还没有账户');
    expect(html).toContain('新增账户');
  });

  it('falls back to zero rather than NaN when a balance is missing', () => {
    store.data = accountsData({ balances: {} });
    const html = renderScreen();

    expect(html).not.toContain('NaN');
    expect(html).toContain('0.00');
  });

  it('is a pushed page under 设置: back goes to the hub, not a gear', () => {
    store.data = accountsData();
    const html = renderScreen();

    const back = html.match(/<a[^>]*class="add-back"[^>]*>/)?.[0] ?? '';
    expect(back).toContain('href="/settings"');
    expect(back).toContain('aria-label="返回设置"');
    // The gear is gone: 设置 is a tab now, so 账户 does not lead to it.
    expect(html).not.toContain('class="accounts-settings"');
  });
});