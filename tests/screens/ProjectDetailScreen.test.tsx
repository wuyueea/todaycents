import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ProjectDetailScreen, {
  ProjectArchiveSheet,
  loadProjectDetailData,
} from '../../src/screens/ProjectDetailScreen';
import type { ProjectDetailData } from '../../src/screens/ProjectDetailScreen';
import type { Project } from '../../src/db/repos/projects';
import { createProject, setTxnProject } from '../../src/db/repos/projects';
import { createExpense } from '../../src/db/repos/txns';
import type { TxnRow } from '../../src/db/repos/txns';
import { createAccount, listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';

/**
 * SSR never runs effects, so the screen is rendered with the exact snapshot
 * its own query returns. The route supplies :id through a real router.
 */
const store = vi.hoisted(() => ({
  data: null as ProjectDetailData | null,
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

const TRIP: Project = {
  id: 'p-trip',
  name: '国庆去成都',
  status: 'active',
  budgetCents: 200000,
  startedDate: null,
  archivedDate: null,
  createdAt: '2026-09-30T00:00:00.000Z',
};

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

function detailData(overrides: Partial<ProjectDetailData> = {}): ProjectDetailData {
  const detail = {
    project: TRIP,
    totalCents: 100000,
    byCategory: [
      { categoryId: 'c-transport', name: '交通', cents: 60000 },
      { categoryId: 'c-food', name: '饮食', cents: 40000 },
    ],
    recentTxns: [
      txn({
        id: 'txn-train',
        occurredDate: '2026-10-06',
        amountCents: -26300,
        categoryId: 'c-transport',
        categoryName: '交通',
        note: '高铁回程',
      }),
      txn({
        id: 'txn-hotpot',
        occurredDate: '2026-10-04',
        amountCents: -16800,
        note: '',
      }),
    ],
  };
  return { detail, txnCount: 23, ...overrides };
}

function renderScreen(id = 'p-trip'): string {
  return renderToString(
    <MemoryRouter initialEntries={[`/settings/projects/${id}`]}>
      <ProjectDetailScreen />
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

/** One serialized opening tag, selected by a data attribute. */
function openingTag(html: string, attribute: string): string {
  return html.match(new RegExp(`<[a-z]+[^>]*${attribute}[^>]*>`))?.[0] ?? '';
}

/** One rendered line, selected by its transaction id. */
function txnBlock(html: string, txnId: string): string {
  return (
    html.match(
      new RegExp(`<li[^>]*>[\\s\\S]*?data-txn-id="${txnId}"[\\s\\S]*?<\\/li>`)
    )?.[0] ?? ''
  );
}

describe('loadProjectDetailData', () => {
  it('reads the total, the category mix and the recent rows through the project API', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    await createAccount(db, { name: '饭卡', type: 'prepaid', monthlyBudgetCents: 75000 });
    const accounts = await listAccounts(db);
    const categories = await listCategories(db);
    const card = accounts.find(account => account.name === '饭卡')!;
    const food = categories.find(category => category.name === '饮食')!;
    const transport = categories.find(category => category.name === '交通')!;

    const projectId = await createProject(db, { name: '国庆去成都', budgetCents: 200000 });
    const hotpot = await createExpense(db, {
      date: '2026-10-04',
      accountId: card.id,
      amountCents: 16800,
      categoryId: food.id,
      note: '火锅',
    });
    const train = await createExpense(db, {
      date: '2026-10-06',
      accountId: card.id,
      amountCents: 26300,
      categoryId: transport.id,
      note: '高铁回程',
    });
    const stray = await createExpense(db, {
      date: '2026-10-06',
      accountId: card.id,
      amountCents: 500,
      categoryId: null,
    });
    await setTxnProject(db, hotpot, projectId);
    await setTxnProject(db, train, projectId);

    const data = await loadProjectDetailData(db, projectId);
    expect(data.detail.project).toMatchObject({ id: projectId, name: '国庆去成都' });
    expect(data.detail.totalCents).toBe(43100);
    expect(data.txnCount).toBe(2);
    expect(data.detail.byCategory).toEqual([
      { categoryId: transport.id, name: '交通', cents: 26300 },
      { categoryId: food.id, name: '饮食', cents: 16800 },
    ]);
    expect(data.detail.recentTxns.map(row => row.id)).toEqual([train, hotpot]);
    // The unrelated row is not the project's, whatever its date.
    expect(data.detail.recentTxns.some(row => row.id === stray)).toBe(false);
  });
});

describe('ProjectDetailScreen', () => {
  it('answers 这趟一共花了, 花在哪里 and 最近几笔 for one project', () => {
    store.data = detailData();
    store.error = null;
    const html = renderScreen();

    expect(html).toContain('<h1>国庆去成都</h1>');
    expect(html).toContain('进行中');
    expect(html).toContain('这趟一共花了');
    expect(html).toContain('1,000.00');
    // The hero names the cap, what is left and how many rows the total covers.
    expect(html).toContain('预算 2,000.00 · 还剩 1,000.00 · 23 笔');

    expect(html).toContain('花在哪里');
    expect(html).toContain('交通');
    expect(html).toContain('600.00');
    expect(html).toContain('60.0%');
    expect(html).toContain('饮食');
    expect(html).toContain('400.00');
    expect(html).toContain('40.0%');
    // Same drawing as 统计: shares are bars against the largest one.
    expect(html).toContain('width:100%');
    expect(html).toMatch(/width:66\.7%/);

    expect(html).toContain('最近几笔');
    const train = txnBlock(html, 'txn-train');
    expect(train).toContain('高铁回程');
    expect(train).toContain('10月6日 · 交通');
    expect(train).toContain('−263.00');
    expect(train).toContain('href="/txn/txn-train"');
    const hotpot = txnBlock(html, 'txn-hotpot');
    expect(hotpot).toContain('饮食');
    expect(hotpot).toContain('10月4日');
    expect(hotpot).toContain('−168.00');

    // A back link to the list, and the prototype's one action.
    expect(html).toContain('aria-label="返回项目"');
    expect(html).toContain('归档这个项目');
  });

  it('drops the budget sentence when the project has no cap', () => {
    store.data = detailData({
      detail: { ...detailData().detail, project: { ...TRIP, budgetCents: null } },
    });
    store.error = null;
    const html = renderScreen();

    expect(html).toContain('这趟一共花了');
    expect(html).not.toContain('还剩');
    expect(html).not.toContain('超出');
    expect(html).toContain('>23 笔<');
  });

  it('says 超出 rather than a negative remainder when the trip went over', () => {
    store.data = detailData({
      detail: {
        ...detailData().detail,
        project: { ...TRIP, budgetCents: 80000 },
        totalCents: 100000,
      },
      txnCount: 4,
    });
    store.error = null;
    const html = renderScreen();

    expect(html).toContain('预算 800.00 · 超出 200.00 · 4 笔');
    expect(html).not.toContain('还剩');
  });

  it('shows an archived project read-only as history, with 恢复归档 instead of 归档', () => {
    store.data = detailData({
      detail: {
        ...detailData().detail,
        project: {
          ...TRIP,
          status: 'archived',
          archivedDate: '2026-10-20T00:00:00.000Z',
        },
      },
    });
    store.error = null;
    const html = renderScreen();

    expect(html).toContain('已归档');
    expect(html).not.toContain('归档这个项目');
    expect(html).toContain('恢复归档');
    // The numbers survive the archive: that is the point of it.
    expect(html).toContain('1,000.00');
    expect(html).toContain('高铁回程');
  });

  it('says where the money went is unknown when nothing is attached yet', () => {
    store.data = detailData({
      detail: {
        ...detailData().detail,
        totalCents: 0,
        byCategory: [],
        recentTxns: [],
      },
      txnCount: 0,
    });
    store.error = null;
    const html = renderScreen();

    expect(html).toContain('还没有支出，暂无分类占比');
    expect(html).not.toContain('最近几笔');
    expect(html).not.toContain('NaN');
  });

  it('offers renaming and a budget change on the same page', () => {
    store.data = detailData();
    store.error = null;
    const html = renderScreen();

    expect(html).toContain('改名与预算');
    const name = openingTag(html, 'id="project-name"');
    expect(name).toContain('value="国庆去成都"');
    const budget = openingTag(html, 'id="project-budget"');
    expect(budget).toContain('data-amount-open');
    expect(html).toContain('>2,000.00</button>');
    expect(html).toContain('保存修改');
  });

  it('renders the missing-data states instead of a blank page', () => {
    store.data = null;
    store.error = null;
    let html = renderScreen();
    expect(html).toContain('正在加载项目…');

    store.error = new Error('项目不存在：p-missing');
    html = renderScreen('p-missing');
    expect(html).toContain('项目暂时打不开');
    store.error = null;
  });
});

describe('ProjectArchiveSheet', () => {
  it('states how many rows stay put and that the archive is reversible', () => {
    const html = renderToString(
      <ProjectArchiveSheet
        projectName="国庆去成都"
        txnCount={23}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    ).replace(/<!-- -->/g, '');

    expect(html).toContain('归档项目');
    expect(html).toContain('归档后，「国庆去成都」不再出现在进行中。');
    expect(html).toContain('这趟的 23 笔账一笔都不会动');
    expect(html).toContain('仍然算进各月的分类统计。');
    expect(html).toContain('随时可以反悔：在「已归档」里点开，选恢复。');
    expect(html).toContain('class="sheet__primary"');
    expect(html).toContain('取消');
  });
});