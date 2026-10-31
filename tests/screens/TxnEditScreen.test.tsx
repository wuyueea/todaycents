import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TxnEditScreen, {
  accountOptionsFor,
  commitTxnEdit,
  deleteTxnRow,
  deleteTxnWithConfirm,
  loadTxnEditData,
  planTxnEdit,
} from '../../src/screens/TxnEditScreen';
import type { TxnEditData, TxnEditDraft } from '../../src/screens/TxnEditScreen';
import App from '../../src/App';
import type { Category } from '../../src/db/repos/categories';
import type { TxnRow } from '../../src/db/repos/txns';
import { createExpense, getTxnById, listTxnsByMonth, monthSummary } from '../../src/db/repos/txns';
import { createTransfer } from '../../src/db/repos/transfers';
import { createAccount, listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import type { Account } from '../../src/domain/types';
import { createTag, getTxnTags, setTxnTags } from '../../src/db/repos/tags';
import type { Tag } from '../../src/db/repos/tags';
import { archiveProject, createProject, setTxnProject } from '../../src/db/repos/projects';
import type { Project } from '../../src/db/repos/projects';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';

/**
 * The screen is rendered with a fixed query result: SSR never runs effects, so
 * the real useQuery would only ever show its loading state. The data shape is
 * the one TxnEditScreen's own query returns.
 */
const store = vi.hoisted(() => ({ data: null as TxnEditData | null }));

vi.mock('../../src/store/useDb', () => ({
  useDb: () => ({ db: { fake: true }, revision: 0, bump: () => {}, error: null }),
  useQuery: () => ({ data: store.data, loading: store.data === null, error: null }),
}));

/** The project write must happen only when the row's project actually changes. */
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

const BANK: Account = {
  ...CARD,
  id: 'a-bank',
  name: '银行卡',
  type: 'bank',
  monthlyBudgetCents: null,
  sort: 1,
};

function txnRow(overrides: Partial<TxnRow> = {}): TxnRow {
  return {
    id: 'txn-1',
    occurredDate: '2026-10-20',
    accountId: CARD.id,
    accountName: CARD.name,
    amountCents: -1230,
    direction: 'expense',
    categoryId: FOOD.id,
    categoryName: FOOD.name,
    note: '午饭',
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

function editData(overrides: Partial<TxnEditData> = {}): TxnEditData {
  return {
    row: txnRow(),
    categories: [FOOD, SPORT, REIMBURSEMENT],
    accounts: [CARD, BANK],
    tags: [NIGHT, ROOMMATE, MOVED],
    rowTags: [],
    projects: [TRIP, OLD_PROJECT],
    ...overrides,
  };
}

function validDraft(overrides: Partial<TxnEditDraft> = {}): TxnEditDraft {
  return {
    amount: '12.30',
    categoryId: FOOD.id,
    accountId: CARD.id,
    note: '午饭',
    tagIds: [],
    projectId: null,
    ...overrides,
  };
}

function renderScreen(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/txn/:id" element={<TxnEditScreen />} />
      </Routes>
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

/** One serialized opening tag, selected by a data attribute. */
function openingTag(html: string, attribute: string): string {
  return html.match(new RegExp(`<[a-z]+[^>]*${attribute}[^>]*>`))?.[0] ?? '';
}

describe('planTxnEdit', () => {
  it('parses the typed amount into integer cents exactly once', () => {
    const plan = planTxnEdit(validDraft({ amount: '3.5' }));

    expect(plan.amountCents).toBe(350);
    expect(plan.blocked).toBe(false);
    expect(plan.problems).toEqual({ amountInvalid: false, accountInvalid: false });
  });

  it('rejects zero, blank, negative and over-precise amounts while keeping the text', () => {
    for (const amount of ['', '   ', '0', '0.00', '-3.50', '3.456', '3,50', '3.50元']) {
      const plan = planTxnEdit(validDraft({ amount }));
      expect(plan.blocked).toBe(true);
      expect(plan.amountCents).toBeNull();
      expect(plan.problems.amountInvalid).toBe(true);
      // The draft is never rewritten: the field keeps what the user typed.
      expect(plan.draft.amount).toBe(amount);
    }
  });

  it('requires an account', () => {
    const plan = planTxnEdit(validDraft({ accountId: '' }));
    expect(plan.blocked).toBe(true);
    expect(plan.problems).toEqual({ amountInvalid: false, accountInvalid: true });
  });
});

describe('accountOptionsFor', () => {
  it('keeps the row account selectable when it has been archived', () => {
    const options = accountOptionsFor([CARD], txnRow({ accountId: 'a-old', accountName: '旧卡' }));
    expect(options).toEqual([
      { id: CARD.id, name: CARD.name },
      { id: 'a-old', name: '旧卡（已归档）' },
    ]);
  });

  it('does not duplicate an account that is still live', () => {
    const options = accountOptionsFor([CARD, BANK], txnRow({ accountId: CARD.id }));
    expect(options).toEqual([
      { id: CARD.id, name: CARD.name },
      { id: BANK.id, name: BANK.name },
    ]);
  });
});

describe('loading and editing through the repository', () => {
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
      sport: categories.find(category => category.name === '运动')!,
    };
  }

  it('loads a live row by id with the pickers it needs', async () => {
    const { db, card, food } = await seeded();
    await createTag(db, '夜宵');
    const id = await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
      note: '午饭',
    });

    const data = await loadTxnEditData(db, id);
    expect(data.row).toMatchObject({ id, amountCents: -1230, note: '午饭' });
    expect(data.accounts.map(account => account.name)).toContain('饭卡');
    expect(data.categories.map(category => category.name)).toContain('饮食');
    expect(data.rowTags).toEqual([]);
    expect(data.tags.map(tag => tag.name)).toContain('夜宵');
  });

  it('loads the tags already attached to the row, archived ones included', async () => {
    const { db, card, food } = await seeded();
    const night = await createTag(db, '夜宵');
    const moved = await createTag(db, '搬家');
    const id = await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
    });
    await setTxnTags(db, id, [night, moved]);
    // Archived after the fact: history keeps the label on the row.
    await db.run('UPDATE tag SET archived_at = ? WHERE id = ?', [
      '2026-10-21T00:00:00.000Z',
      moved,
    ]);

    const data = await loadTxnEditData(db, id);
    expect(data.rowTags.map(tag => tag.name)).toEqual(['夜宵', '搬家']);
    expect(data.rowTags.find(tag => tag.id === moved)?.archivedAt).not.toBeNull();
  });

  it('opens a row from an older month by id instead of scanning the current month', async () => {
    const { db, card, food } = await seeded();
    const id = await createExpense(db, {
      date: '2026-08-15',
      accountId: card.id,
      amountCents: 660,
      categoryId: food.id,
      note: '上上个月',
    });

    const byId = await getTxnById(db, id);
    expect(byId).toMatchObject({
      id,
      occurredDate: '2026-08-15',
      amountCents: -660,
      note: '上上个月',
    });

    const data = await loadTxnEditData(db, id);
    expect(data.row?.id).toBe(id);
    expect(data.row?.occurredDate).toBe('2026-08-15');
  });

  it('reports a soft-deleted row as missing instead of loading it', async () => {
    const { db, card, food } = await seeded();
    const id = await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
    });
    await deleteTxnRow(db, (await loadTxnEditData(db, id)).row!);

    expect((await loadTxnEditData(db, id)).row).toBeNull();
  });

  it('saves amount, category, account and note while keeping the expense sign', async () => {
    const { db, card, bank, food, sport } = await seeded();
    const id = await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
      note: '午饭',
    });
    const row = (await loadTxnEditData(db, id)).row!;

    const result = await commitTxnEdit(db, row, {
      amount: '20',
      categoryId: sport.id,
      accountId: bank.id,
      note: '改过',
      tagIds: [],
      projectId: null,
    });

    expect(result.saved).toBe(true);
    const stored = (await listTxnsByMonth(db, '2026-10')).find(candidate => candidate.id === id)!;
    expect(stored).toMatchObject({
      amountCents: -2000,
      direction: 'expense',
      categoryId: sport.id,
      accountId: bank.id,
      note: '改过',
      occurredDate: '2026-10-20',
    });
  });

  it('saves the chosen tags with setTxnTags after the row update', async () => {
    const { db, card, food } = await seeded();
    const night = await createTag(db, '夜宵');
    const roommate = await createTag(db, '和室友');
    const id = await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
    });
    const row = (await loadTxnEditData(db, id)).row!;

    const result = await commitTxnEdit(
      db,
      row,
      validDraft({
        categoryId: food.id,
        accountId: card.id,
        note: '',
        tagIds: [night, roommate],
      })
    );

    expect(result.saved).toBe(true);
    expect((await getTxnTags(db, id)).map(tag => tag.name)).toEqual(['和室友', '夜宵']);
  });

  it('keeps the old tags when the edit is refused', async () => {
    const { db, card, food } = await seeded();
    const night = await createTag(db, '夜宵');
    const id = await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
    });
    await setTxnTags(db, id, [night]);
    const row = (await loadTxnEditData(db, id)).row!;

    const result = await commitTxnEdit(db, row, validDraft({ amount: '0', tagIds: [] }));

    expect(result.saved).toBe(false);
    expect((await getTxnTags(db, id)).map(tag => tag.name)).toEqual(['夜宵']);
  });

  it('writes nothing when the amount does not parse', async () => {
    const { db, card, food } = await seeded();
    const id = await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
    });
    const row = (await loadTxnEditData(db, id)).row!;

    const result = await commitTxnEdit(db, row, validDraft({ amount: '0' }));

    expect(result.saved).toBe(false);
    expect(result.problems.amountInvalid).toBe(true);
    const stored = (await listTxnsByMonth(db, '2026-10')).find(candidate => candidate.id === id)!;
    expect(stored.amountCents).toBe(-1230);
  });

  it('refuses to save a transfer leg', async () => {
    const { db, card, bank } = await seeded();
    await createTransfer(db, {
      date: '2026-10-20',
      fromAccountId: card.id,
      toAccountId: bank.id,
      amountCents: 60000,
    });
    const leg = (await listTxnsByMonth(db, '2026-10'))[0]!;

    await expect(commitTxnEdit(db, leg, validDraft())).rejects.toThrow(/转账/);
    const after = await listTxnsByMonth(db, '2026-10');
    expect(after).toHaveLength(2);
    expect(after.map(row => row.amountCents).sort((a, b) => a - b)).toEqual([-60000, 60000]);
  });

  it('moves the row to the chosen project, and writes nothing when the project is unchanged', async () => {
    const { db, card, food } = await seeded();
    const trip = await createProject(db, { name: '国庆去成都', budgetCents: 200000 });
    const id = await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
    });
    const row = (await loadTxnEditData(db, id)).row!;
    expect(row.projectId).toBeNull();

    setTxnProjectSpy.mockClear();
    await commitTxnEdit(
      db,
      row,
      validDraft({ categoryId: food.id, accountId: card.id, note: '', projectId: trip })
    );
    expect(setTxnProjectSpy).toHaveBeenCalledTimes(1);
    expect(setTxnProjectSpy).toHaveBeenCalledWith(id, trip);
    expect((await loadTxnEditData(db, id)).row).toMatchObject({
      projectId: trip,
      projectName: '国庆去成都',
      projectArchived: false,
    });

    // Re-saving the same project is not a new assignment: no second write.
    const assigned = (await loadTxnEditData(db, id)).row!;
    setTxnProjectSpy.mockClear();
    await commitTxnEdit(
      db,
      assigned,
      validDraft({ categoryId: food.id, accountId: card.id, note: '', projectId: trip })
    );
    expect(setTxnProjectSpy).not.toHaveBeenCalled();

    // Clearing is a real change.
    setTxnProjectSpy.mockClear();
    const cleared = await commitTxnEdit(
      db,
      assigned,
      validDraft({ categoryId: food.id, accountId: card.id, note: '', projectId: null })
    );
    expect(cleared.saved).toBe(true);
    expect(setTxnProjectSpy).toHaveBeenCalledWith(id, null);
    expect((await loadTxnEditData(db, id)).row?.projectId).toBeNull();
  });

  it('lets an archived project stay on its row without rewriting the assignment', async () => {
    const { db, card, food } = await seeded();
    const trip = await createProject(db, { name: '国庆去成都' });
    const id = await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
    });
    await setTxnProject(db, id, trip);
    await archiveProject(db, trip);

    const row = (await loadTxnEditData(db, id)).row!;
    expect(row).toMatchObject({ projectId: trip, projectArchived: true });

    setTxnProjectSpy.mockClear();
    const result = await commitTxnEdit(
      db,
      row,
      validDraft({ categoryId: food.id, accountId: card.id, note: '改过', projectId: trip })
    );
    expect(result.saved).toBe(true);
    expect(setTxnProjectSpy).not.toHaveBeenCalled();
    expect((await loadTxnEditData(db, id)).row?.projectId).toBe(trip);
    expect((await listTxnsByMonth(db, '2026-10')).find(item => item.id === id)?.note).toBe(
      '改过'
    );
  });
});

describe('deleteTxnRow', () => {
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
    };
  }

  it('soft-deletes a normal row so it leaves the list and the totals', async () => {
    const { db, card, food } = await seeded();
    const id = await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
    });
    const row = (await loadTxnEditData(db, id)).row!;

    await deleteTxnRow(db, row);

    expect(await listTxnsByMonth(db, '2026-10')).toEqual([]);
    expect((await monthSummary(db, '2026-10')).expenseCents).toBe(0);
    expect((await loadTxnEditData(db, id)).row).toBeNull();
  });

  it('asks for confirmation and writes nothing when the second tap is declined', async () => {
    const { db, card, food } = await seeded();
    const id = await createExpense(db, {
      date: '2026-10-20',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
    });
    const row = (await loadTxnEditData(db, id)).row!;
    let asked = '';

    const declined = await deleteTxnWithConfirm(db, row, message => {
      asked = message;
      return false;
    });
    expect(declined).toBe(false);
    expect(asked).toContain('删除');
    expect((await listTxnsByMonth(db, '2026-10')).some(candidate => candidate.id === id)).toBe(
      true
    );

    const confirmed = await deleteTxnWithConfirm(db, row, () => true);
    expect(confirmed).toBe(true);
    expect(await listTxnsByMonth(db, '2026-10')).toEqual([]);
  });

  it('refuses a transfer leg and leaves both legs live', async () => {
    const { db, card, bank } = await seeded();
    await createTransfer(db, {
      date: '2026-10-20',
      fromAccountId: card.id,
      toAccountId: bank.id,
      amountCents: 60000,
    });
    const leg = (await listTxnsByMonth(db, '2026-10'))[0]!;

    await expect(deleteTxnRow(db, leg)).rejects.toThrow(/转账/);
    // Neither leg was soft-deleted by the refused call.
    expect(await listTxnsByMonth(db, '2026-10')).toHaveLength(2);
  });
});

describe('TxnEditScreen', () => {
  it('shows the row with editable amount, category, account and note, and a display-only date', () => {
    store.data = editData();
    const html = renderScreen('/txn/txn-1');

    expect(html).toContain('<h1>编辑流水</h1>');
    expect(html).toContain('2026-10-20');
    // The date is display-only: no date control, and the repository refuses a move.
    expect(html).not.toContain('type="date"');

    const amountButton = openingTag(html, 'id="edit-amount"');
    expect(amountButton).toContain('data-amount-open');
    expect(html).toContain('>12.30</button>');
    expect(html).not.toContain('inputMode="decimal"');
    expect(openingTag(html, 'data-category-id="c-food"')).toContain('aria-pressed="true"');
    expect(html).toContain('>饮食</button>');
    // Only the row's own category kind is offered.
    expect(html).not.toContain('>报销</button>');

    expect(openingTag(html, 'data-account-id="a-card"')).toContain('aria-pressed="true"');
    expect(html).toContain('>饭卡</button>');

    expect(openingTag(html, 'id="edit-note"')).toContain('value="午饭"');
    expect(openingTag(html, 'data-tag-id="tag-night"')).toContain('aria-pressed="false"');
    expect(html).toContain('>夜宵</button>');
    expect(html).not.toContain('添加标签');
    expect(html).toContain('保存');
    expect(html).toContain('删除');
  });

  it('shows the row project as an optional row after 标签', () => {
    store.data = editData({
      row: txnRow({ projectId: 'p-trip', projectName: '国庆去成都' }),
    });
    const html = renderScreen('/txn/txn-1');

    const chip = openingTag(html, 'data-project-id="p-trip"');
    expect(chip).toContain('aria-pressed="true"');
    expect(html).toContain('>国庆去成都</button>');

    const order = ['data-tag-id="tag-night"', 'data-project-id="p-trip"', 'id="edit-note"'].map(marker =>
      html.indexOf(marker)
    );
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The sheet is closed until the row is tapped.
    expect(html).not.toContain('role="dialog"');
  });

  it('says 不归项目 on a row that belongs to no project', () => {
    store.data = editData();
    const html = renderScreen('/txn/txn-1');

    expect(openingTag(html, 'data-project-clear="true"')).toContain('aria-pressed="true"');
    expect(html).toContain('>不归项目</button>');
  });

  it('keeps naming an archived project and says the save leaves it alone', () => {
    store.data = editData({
      row: txnRow({ projectId: 'p-old', projectName: '换手机', projectArchived: true }),
    });
    const html = renderScreen('/txn/txn-1');

    expect(openingTag(html, 'data-project-id="p-old"')).toContain('aria-pressed="true"');
    expect(html).toContain('换手机（已归档）');
    expect(html).toContain('当前项目「换手机」已归档；不重新选择会保留原项目。');
  });

  it('shows the row tags as a summary on the edit form', () => {
    store.data = editData({ rowTags: [NIGHT, ROOMMATE] });
    const html = renderScreen('/txn/txn-1');

    expect(openingTag(html, 'data-tag-id="tag-night"')).toContain('aria-pressed="true"');
    expect(html).toContain('>夜宵</button>');
    expect(html).toContain('>和室友</button>');
    expect(html).not.toContain('添加标签');
  });

  // A plain button on the right of a 固定支出 row: the thumb's position carries
  // the state, and neither 已标记 nor 未标记 is printed.
  it('offers an immediate 固定支出 button on an expense row, with no status word', () => {
    store.data = editData({ row: txnRow({ isFixedCost: true }) });
    const html = renderScreen('/txn/txn-1');

    const button = openingTag(html, 'data-fixed-toggle');
    expect(button).toContain('<button');
    expect(button).toContain('role="switch"');
    expect(button).toContain('aria-checked="true"');
    expect(html).toContain('>固定支出<');
    expect(html).not.toContain('已标记');
    expect(html).not.toContain('未标记');
  });

  it('starts the expense button off when the row is not marked', () => {
    store.data = editData();
    const html = renderScreen('/txn/txn-1');

    const button = openingTag(html, 'data-fixed-toggle');
    expect(button).not.toBe('');
    expect(button).toContain('aria-checked="false"');
    expect(html).not.toContain('未标记');
  });

  it('offers the project on income but not on an adjustment', () => {
    store.data = editData({
      row: txnRow({
        id: 't-income-project',
        direction: 'income',
        amountCents: 100000,
        categoryId: REIMBURSEMENT.id,
        categoryName: REIMBURSEMENT.name,
      }),
    });
    expect(renderScreen('/txn/t-income-project')).toContain('data-project-clear="true"');

    store.data = editData({
      row: txnRow({
        id: 't-adjust-no-project',
        direction: 'adjust',
        amountCents: -500,
        categoryId: null,
        categoryName: null,
      }),
    });
    expect(renderScreen('/txn/t-adjust-no-project')).not.toContain('data-project-clear');
  });

  it('hides the 固定支出 switch on income, adjustment and transfer rows', () => {
    for (const row of [
      txnRow({
        id: 't-income',
        direction: 'income',
        amountCents: 100000,
        categoryId: REIMBURSEMENT.id,
        categoryName: REIMBURSEMENT.name,
      }),
      txnRow({
        id: 't-adjust',
        direction: 'adjust',
        amountCents: -500,
        categoryId: null,
        categoryName: null,
      }),
      txnRow({
        id: 't-transfer',
        direction: 'transfer',
        amountCents: -60000,
        categoryId: null,
        categoryName: null,
      }),
    ]) {
      store.data = editData({ row });
      const html = renderScreen(`/txn/${row.id}`);
      expect(html).not.toContain('data-fixed-toggle');
      expect(html).not.toContain('role="switch"');
      expect(html).not.toContain('id="edit-fixed"');
    }
  });

  it('renders a transfer leg read-only, with no save or delete control', () => {
    store.data = editData({
      row: txnRow({
        id: 't-out',
        direction: 'transfer',
        categoryId: null,
        categoryName: null,
        amountCents: -60000,
        note: '还信用卡',
      }),
    });
    const html = renderScreen('/txn/t-out');

    expect(html).toContain('转账');
    expect(html).toContain('−600.00');
    expect(html).toContain('不能在这里单独修改');
    expect(html).not.toContain('id="edit-amount"');
    expect(html).not.toContain('<button');
  });

  it('survives a row that no longer exists', () => {
    store.data = { row: null, categories: [], accounts: [], tags: [], rowTags: [], projects: [] };
    const html = renderScreen('/txn/gone');

    expect(html).toContain('这笔记录不存在');
    expect(html).toContain('href="/ledger"');
    expect(html).not.toContain('id="edit-amount"');
    expect(html).not.toContain('<button');
  });

  it('is a real /txn/:id route pushed over the shell', () => {
    store.data = editData();
    const html = renderToString(
      <MemoryRouter initialEntries={['/txn/txn-1']}>
        <App />
      </MemoryRouter>
    );

    expect(html).toContain('<h1>编辑流水</h1>');
    expect(html).not.toContain('tab-bar');
  });
});