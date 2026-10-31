import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ProjectsScreen, {
  loadProjectsData,
  planProjectCreate,
} from '../../src/screens/ProjectsScreen';
import type { ProjectsData } from '../../src/screens/ProjectsScreen';
import type { Project } from '../../src/db/repos/projects';
import {
  archiveProject,
  createProject,
  setTxnProject,
} from '../../src/db/repos/projects';
import { createExpense } from '../../src/db/repos/txns';
import { createAccount, listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';

/**
 * The screen is rendered with a fixed query result: SSR never runs effects, so
 * the real useQuery would only ever show its loading state. The data shape is
 * the one ProjectsScreen's own query returns.
 */
const store = vi.hoisted(() => ({
  data: null as ProjectsData | null,
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

function project(overrides: Partial<Project> & Pick<Project, 'id' | 'name'>): Project {
  return {
    status: 'active',
    budgetCents: null,
    startedDate: null,
    archivedDate: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function projectsData(overrides: Partial<ProjectsData> = {}): ProjectsData {
  return {
    rows: [
      {
        project: project({ id: 'p-trip', name: '国庆去成都', budgetCents: 200000 }),
        txnCount: 23,
        totalCents: 184260,
      },
      {
        project: project({ id: 'p-move', name: '搬家', budgetCents: null }),
        txnCount: 3,
        totalCents: 3900,
      },
      {
        project: project({
          id: 'p-phone',
          name: '换手机',
          status: 'archived',
          archivedDate: '2026-08-31T10:00:00.000Z',
        }),
        txnCount: 12,
        totalCents: 219900,
      },
    ],
    ...overrides,
  };
}

function renderScreen(): string {
  return renderToString(
    <MemoryRouter initialEntries={['/settings/projects']}>
      <ProjectsScreen />
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

/** One serialized opening tag, selected by a data attribute. */
function openingTag(html: string, attribute: string): string {
  return html.match(new RegExp(`<[a-z]+[^>]*${attribute}[^>]*>`))?.[0] ?? '';
}

/** One rendered project row, selected by its project id. */
function rowBlock(html: string, projectId: string): string {
  return (
    html.match(
      new RegExp(`<li[^>]*data-project-id="${projectId}"[\\s\\S]*?<\\/li>`)
    )?.[0] ?? ''
  );
}

describe('planProjectCreate', () => {
  it('trims the name and treats a blank budget as no budget', () => {
    expect(planProjectCreate('  国庆去成都  ', '   ')).toEqual({
      name: '国庆去成都',
      budgetCents: null,
      error: null,
    });
  });

  it('parses the optional budget into integer cents, never through a float', () => {
    expect(planProjectCreate('搬家', '2000')).toEqual({
      name: '搬家',
      budgetCents: 200000,
      error: null,
    });
    expect(planProjectCreate('搬家', '1999.99').budgetCents).toBe(199999);
  });

  it('refuses a blank name and a budget a money field cannot mean', () => {
    expect(planProjectCreate('   ', '')).toEqual({
      name: null,
      budgetCents: null,
      error: '项目名不能为空',
    });
    for (const budget of ['0', '0.00', 'abc', '-10', '1.234']) {
      const plan = planProjectCreate('旅行', budget);
      expect(plan.name).toBeNull();
      expect(plan.budgetCents).toBeNull();
      expect(plan.error).toBe('预算必须是大于 0 的数字，最多两位小数');
    }
  });
});

describe('loadProjectsData', () => {
  it('pairs every project with its derived total and keeps archived ones last', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    await createAccount(db, { name: '饭卡', type: 'prepaid', monthlyBudgetCents: 75000 });
    const accounts = await listAccounts(db);
    const categories = await listCategories(db);
    const card = accounts.find(account => account.name === '饭卡')!;
    const food = categories.find(category => category.name === '饮食')!;

    const trip = await createProject(db, { name: '国庆去成都', budgetCents: 200000 });
    const phone = await createProject(db, { name: '换手机' });
    const dinner = await createExpense(db, {
      date: '2026-10-02',
      accountId: card.id,
      amountCents: 1230,
      categoryId: food.id,
    });
    const train = await createExpense(db, {
      date: '2026-10-03',
      accountId: card.id,
      amountCents: 5000,
      categoryId: food.id,
    });
    await setTxnProject(db, dinner, trip);
    await setTxnProject(db, train, trip);
    await archiveProject(db, phone);

    const data = await loadProjectsData(db);
    expect(data.rows.map(row => row.project.id)).toEqual([trip, phone]);
    expect(data.rows[0]).toMatchObject({
      totalCents: 6230,
      txnCount: 2,
    });
    expect(data.rows[0].project).toMatchObject({ name: '国庆去成都', budgetCents: 200000 });
    expect(data.rows[1]).toMatchObject({ totalCents: 0, txnCount: 0 });
    expect(data.rows[1].project.status).toBe('archived');
  });
});

describe('ProjectsScreen', () => {
  it('lists live projects first with their count and total, then the archived group', () => {
    store.data = projectsData();
    store.error = null;
    const html = renderScreen();

    expect(html).toContain('<h1>项目</h1>');
    expect(html).toContain('2 个进行中');
    // The page explains nothing about the model; the numbers speak.
    expect(html).not.toContain('另一根轴');

    const trip = rowBlock(html, 'p-trip');
    expect(trip).toContain('国庆去成都');
    expect(trip).toContain('23 笔 · 已花 1,842.60');
    expect(trip).toContain('预算 2,000.00 · 已用 1,842.60');
    expect(trip).toMatch(/<progress[^>]*value="184260"[^>]*max="200000"/);
    expect(trip).toContain('href="/settings/projects/p-trip"');

    const move = rowBlock(html, 'p-move');
    expect(move).toContain('3 笔 · 已花 39.00');
    // No budget means no meter at all.
    expect(move).not.toContain('<progress');

    // 已归档 comes after the live rows, with the project name greyed out.
    expect(html.indexOf('data-project-id="p-move"')).toBeLessThan(
      html.indexOf('data-project-id="p-phone"')
    );
    expect(html).toContain('已归档');
    const archived = rowBlock(html, 'p-phone');
    expect(archived).toContain('class="project-row project-row--archived"');
    expect(archived).toContain('12 笔 · 已花 2,199.00');
    expect(archived).toContain('href="/settings/projects/p-phone"');
  });

  it('marks a project that is over its budget without touching the amount', () => {
    store.data = projectsData({
      rows: [
        {
          project: project({ id: 'p-over', name: '装修', budgetCents: 100000 }),
          txnCount: 4,
          totalCents: 120000,
        },
      ],
    });
    store.error = null;
    const html = renderScreen();

    expect(html).toContain('预算 1,000.00 · 已用 1,200.00');
    expect(html).toContain('project-progress project-progress--over');
    expect(html).toContain('4 笔 · 已花 1,200.00');
  });

  it('offers the create form with name required and budget optional', () => {
    store.data = projectsData({ rows: [] });
    store.error = null;
    const html = renderScreen();

    expect(openingTag(html, 'id="new-project-name"')).toContain('type="text"');
    expect(openingTag(html, 'id="new-project-budget"')).toContain('data-amount-open');
    expect(openingTag(html, 'id="new-project-budget"')).toContain('type="button"');
    expect(html).toContain('可不填');
    expect(html).toContain('>新建项目</button>');
    // Name first, budget second: the name is the only required field.
    expect(html.indexOf('id="new-project-name"')).toBeLessThan(
      html.indexOf('id="new-project-budget"')
    );
  });

  it('says 还没有项目 when nothing has been created yet', () => {
    store.data = projectsData({ rows: [] });
    store.error = null;
    const html = renderScreen();

    expect(html).toContain('还没有项目');
    expect(html).not.toContain('已归档');
    expect(html).not.toContain('<progress');
  });

  it('still renders a usable page when the data layer is missing', () => {
    store.data = null;
    store.error = null;
    let html = renderScreen();
    expect(html).toContain('正在加载项目…');
    expect(html).toContain('<h1>项目</h1>');

    store.error = new Error('no sqlite');
    html = renderScreen();
    expect(html).toContain('项目暂时打不开');
    expect(html).toContain('新建项目');
    store.error = null;
  });
});