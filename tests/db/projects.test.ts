import { describe, it, expect } from 'vitest';
import type { Db } from '../../src/db/driver';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';
import {
  createExpense,
  createIncome,
  getTxnById,
  listTxnsByMonth,
  monthSummary,
  softDeleteTxn,
} from '../../src/db/repos/txns';
import {
  PROJECT_RECENT_TXN_LIMIT,
  archiveProject,
  createProject,
  deleteProject,
  listProjects,
  projectDetail,
  projectTotals,
  renameProject,
  setProjectBudget,
  setTxnProject,
  unarchiveProject,
} from '../../src/db/repos/projects';

/** A seeded ledger plus the ids every project test needs. */
async function ledger(db: Db): Promise<{
  accountId: string;
  foodId: string;
  otherId: string;
}> {
  await seedDefaults(db);
  const account = await db.get<{ id: string }>(
    'SELECT id FROM account ORDER BY sort LIMIT 1'
  );
  const food = await db.get<{ id: string }>("SELECT id FROM category WHERE name = '饮食'");
  const other = await db.get<{ id: string }>("SELECT id FROM category WHERE name = '交通'");
  if (account === undefined || food === undefined || other === undefined) {
    throw new Error('seed fixture is incomplete');
  }
  return { accountId: account.id, foodId: food.id, otherId: other.id };
}

/** One expense; tests that care about "recent" pass distinct dates. */
async function spend(
  db: Db,
  accountId: string,
  categoryId: string | null,
  amountCents: number,
  note = '',
  date = '2026-10-20'
): Promise<string> {
  return createExpense(db, { date, accountId, amountCents, categoryId, note });
}

describe('createProject', () => {
  it('creates an active project with a trimmed name, budget and start date', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);

    const id = await createProject(db, {
      name: '  国庆去成都  ',
      budgetCents: 500000,
      startedDate: '2026-10-01',
    });
    const projects = await listProjects(db);

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id,
      name: '国庆去成都',
      status: 'active',
      budgetCents: 500000,
      startedDate: '2026-10-01',
      archivedDate: null,
    });
    expect(projects[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(accountId).toBeTruthy();
    expect(foodId).toBeTruthy();
  });

  it('keeps budget and start date optional', async () => {
    const db = await createTestDb();
    const id = await createProject(db, { name: '搬家' });
    const project = (await listProjects(db)).find(candidate => candidate.id === id);
    expect(project).toMatchObject({ budgetCents: null, startedDate: null });
  });

  it('refuses a blank name and writes nothing', async () => {
    const db = await createTestDb();
    await expect(createProject(db, { name: '   ' })).rejects.toThrow(/项目名不能为空/);
    expect(await listProjects(db, { includeArchived: true })).toEqual([]);
  });

  it('refuses a budget that is not integer cents', async () => {
    const db = await createTestDb();
    await expect(createProject(db, { name: '旅行', budgetCents: 12.5 })).rejects.toThrow(
      /整数分/
    );
    expect(await listProjects(db)).toEqual([]);
  });

  it('refuses a start date that is not a real calendar day', async () => {
    const db = await createTestDb();
    await expect(
      createProject(db, { name: '旅行', startedDate: '2026-02-30' })
    ).rejects.toThrow(/date must be YYYY-MM-DD/);
  });
});

describe('listProjects', () => {
  it('hides archived projects by default and shows them on request', async () => {
    const db = await createTestDb();
    const active = await createProject(db, { name: '进行中' });
    const over = await createProject(db, { name: '已结束' });
    await archiveProject(db, over);

    expect((await listProjects(db)).map(project => project.id)).toEqual([active]);

    const all = await listProjects(db, { includeArchived: true });
    expect(all.map(project => project.id)).toEqual([active, over]);
    expect(all[1].status).toBe('archived');
  });
});

describe('renameProject', () => {
  it('renames and trims without touching status or dates', async () => {
    const db = await createTestDb();
    const id = await createProject(db, { name: '旧名字' });
    await renameProject(db, id, '  国庆去成都  ');

    expect(await listProjects(db)).toEqual([
      expect.objectContaining({ id, name: '国庆去成都', status: 'active' }),
    ]);
  });

  it('refuses a blank name and an unknown project', async () => {
    const db = await createTestDb();
    const id = await createProject(db, { name: '旅行' });

    await expect(renameProject(db, id, '  ')).rejects.toThrow(/项目名不能为空/);
    await expect(renameProject(db, 'missing', '新的')).rejects.toThrow(/项目不存在/);
    expect((await listProjects(db))[0].name).toBe('旅行');
  });
});

describe('archiveProject / unarchiveProject', () => {
  it('stamps status and archived_date once and keeps the first timestamp', async () => {
    const db = await createTestDb();
    const id = await createProject(db, { name: '国庆去成都' });

    await archiveProject(db, id);
    const first = (await listProjects(db, { includeArchived: true }))[0];
    expect(first.status).toBe('archived');
    expect(first.archivedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await archiveProject(db, id);
    const second = (await listProjects(db, { includeArchived: true }))[0];
    expect(second.archivedDate).toBe(first.archivedDate);
  });

  it('never clears project_id, so the project total survives the archive', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });
    const txnId = await spend(db, accountId, foodId, 1230);
    await setTxnProject(db, txnId, projectId);

    await archiveProject(db, projectId);

    const row = await db.get<{ project_id: string | null }>(
      'SELECT project_id FROM txn WHERE id = ?',
      [txnId]
    );
    expect(row?.project_id).toBe(projectId);
    expect(await projectTotals(db)).toEqual([
      expect.objectContaining({ id: projectId, status: 'archived', txnCount: 1, totalCents: 1230 }),
    ]);
  });

  it('restores an archived project to the live list with its history intact', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });
    const txnId = await spend(db, accountId, foodId, 990);
    await setTxnProject(db, txnId, projectId);
    await archiveProject(db, projectId);

    await unarchiveProject(db, projectId);

    expect((await listProjects(db))[0]).toMatchObject({
      id: projectId,
      status: 'active',
      archivedDate: null,
    });
    expect(await projectTotals(db)).toEqual([
      expect.objectContaining({ id: projectId, status: 'active', totalCents: 990 }),
    ]);
  });
});

describe('deleteProject', () => {
  it('refuses to delete a project that still has a live transaction', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });
    const txnId = await spend(db, accountId, foodId, 500);
    await setTxnProject(db, txnId, projectId);

    await expect(deleteProject(db, projectId)).rejects.toThrow(/还有 1 笔流水，不能删除/);

    expect((await listProjects(db, { includeArchived: true })).map(p => p.id)).toEqual([
      projectId,
    ]);
    expect(
      await db.get<{ project_id: string }>('SELECT project_id FROM txn WHERE id = ?', [txnId])
    ).toMatchObject({ project_id: projectId });
  });

  it('refuses while a soft-deleted row still points at it', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });
    const txnId = await spend(db, accountId, foodId, 700);
    await setTxnProject(db, txnId, projectId);
    await softDeleteTxn(db, txnId);

    // The row is history and keeps project_id; deleting the project would
    // leave a dangling id in this database and in every backup of it.
    await expect(deleteProject(db, projectId)).rejects.toThrow(/不能删除/);
  });

  it('physically removes an unused project and refuses an unknown id', async () => {
    const db = await createTestDb();
    const used = await createProject(db, { name: '用过的' });
    const unused = await createProject(db, { name: '建错的' });

    await deleteProject(db, unused);

    const rows = await db.all<{ id: string }>('SELECT id FROM project ORDER BY id');
    expect(rows.map(row => row.id)).toEqual([used]);
    await expect(deleteProject(db, unused)).rejects.toThrow(/项目不存在/);
  });

  it('allows deleting after the last transaction was moved to another project', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const first = await createProject(db, { name: '国庆去成都' });
    const second = await createProject(db, { name: '搬家' });
    const txnId = await spend(db, accountId, foodId, 800);
    await setTxnProject(db, txnId, first);

    await setTxnProject(db, txnId, second);
    await deleteProject(db, first);

    expect((await listProjects(db)).map(project => project.id)).toEqual([second]);
  });
});

describe('setTxnProject', () => {
  it('assigns an active project and clears it again', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });
    const txnId = await spend(db, accountId, foodId, 1230);

    await setTxnProject(db, txnId, projectId);
    expect(
      await db.get<{ project_id: string | null }>('SELECT project_id FROM txn WHERE id = ?', [
        txnId,
      ])
    ).toMatchObject({ project_id: projectId });

    await setTxnProject(db, txnId, null);
    expect(
      await db.get<{ project_id: string | null }>('SELECT project_id FROM txn WHERE id = ?', [
        txnId,
      ])
    ).toMatchObject({ project_id: null });
  });

  it('refuses an archived project for a new assignment and changes nothing', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const archived = await createProject(db, { name: '已经结束' });
    await archiveProject(db, archived);
    const txnId = await spend(db, accountId, foodId, 600);

    await expect(setTxnProject(db, txnId, archived)).rejects.toThrow(/已归档/);

    const row = await db.get<{ project_id: string | null }>(
      'SELECT project_id FROM txn WHERE id = ?',
      [txnId]
    );
    expect(row?.project_id).toBeNull();
  });

  it('always allows clearing, even from an archived project', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });
    const txnId = await spend(db, accountId, foodId, 640);
    await setTxnProject(db, txnId, projectId);
    await archiveProject(db, projectId);

    await setTxnProject(db, txnId, null);

    expect(
      await db.get<{ project_id: string | null }>('SELECT project_id FROM txn WHERE id = ?', [
        txnId,
      ])
    ).toMatchObject({ project_id: null });
  });

  it('lets an existing archived assignment be saved again unchanged', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });
    const txnId = await spend(db, accountId, foodId, 430);
    await setTxnProject(db, txnId, projectId);
    await archiveProject(db, projectId);

    // The edit screen sends the row's current project back on save; that is
    // not a new assignment and must not fail.
    await expect(setTxnProject(db, txnId, projectId)).resolves.toBeUndefined();
    expect(
      await db.get<{ project_id: string | null }>('SELECT project_id FROM txn WHERE id = ?', [
        txnId,
      ])
    ).toMatchObject({ project_id: projectId });
  });

  it('refuses an unknown transaction and an unknown project', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const txnId = await spend(db, accountId, foodId, 100);
    const projectId = await createProject(db, { name: '旅行' });

    await expect(setTxnProject(db, 'missing', projectId)).rejects.toThrow(/流水不存在/);
    await expect(setTxnProject(db, txnId, 'missing')).rejects.toThrow(/项目不存在/);
  });

  it('does not change the monthly totals', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });
    const txnId = await spend(db, accountId, foodId, 1230);

    const before = await monthSummary(db, '2026-10');
    await setTxnProject(db, txnId, projectId);
    const after = await monthSummary(db, '2026-10');

    expect(after).toEqual(before);
    expect(after.expenseCents).toBe(1230);
  });
});

describe('projectTotals', () => {
  it('counts live rows and sums expenses into positive cents', async () => {
    const db = await createTestDb();
    const { accountId, foodId, otherId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });

    const first = await spend(db, accountId, foodId, 1000);
    const second = await spend(db, accountId, foodId, 2500);
    const third = await spend(db, accountId, otherId, 500);
    for (const txnId of [first, second, third]) await setTxnProject(db, txnId, projectId);
    await spend(db, accountId, foodId, 9999);
    const deleted = await spend(db, accountId, foodId, 4000);
    await setTxnProject(db, deleted, projectId);
    await softDeleteTxn(db, deleted);

    expect(await projectTotals(db)).toEqual([
      {
        id: projectId,
        name: '国庆去成都',
        status: 'active',
        txnCount: 3,
        totalCents: 4000,
      },
    ]);
  });

  it('keeps income in the row count but out of the amount spent', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });
    const expense = await spend(db, accountId, foodId, 1200);
    const income = await createIncome(db, {
      date: '2026-10-20',
      accountId,
      amountCents: 300,
      categoryId: null,
      note: '报销',
    });
    await setTxnProject(db, expense, projectId);
    await setTxnProject(db, income, projectId);

    const total = (await projectTotals(db))[0];
    expect(total).toMatchObject({ txnCount: 2, totalCents: 1200 });
  });

  it('lists a project with no transactions as zero and keeps archived projects', async () => {
    const db = await createTestDb();
    const empty = await createProject(db, { name: '还没出发' });
    const over = await createProject(db, { name: '已经结束' });
    await archiveProject(db, over);

    expect(await projectTotals(db)).toEqual([
      {
        id: empty,
        name: '还没出发',
        status: 'active',
        txnCount: 0,
        totalCents: 0,
      },
      {
        id: over,
        name: '已经结束',
        status: 'archived',
        txnCount: 0,
        totalCents: 0,
      },
    ]);
  });
});

describe('projectDetail', () => {
  it('rejects an unknown project', async () => {
    const db = await createTestDb();
    await expect(projectDetail(db, 'missing')).rejects.toThrow(/项目不存在/);
  });

  it('answers what the trip cost and where it went', async () => {
    const db = await createTestDb();
    const { accountId, foodId, otherId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });

    const food = await spend(db, accountId, foodId, 5000, '火锅', '2026-10-02');
    const foodAgain = await spend(db, accountId, foodId, 1000, '早饭', '2026-10-03');
    const transport = await spend(db, accountId, otherId, 2500, '高铁', '2026-10-04');
    const uncategorised = await spend(db, accountId, null, 500, '随手', '2026-10-05');
    for (const txnId of [food, foodAgain, transport, uncategorised]) {
      await setTxnProject(db, txnId, projectId);
    }

    const detail = await projectDetail(db, projectId);

    expect(detail.project).toMatchObject({ id: projectId, name: '国庆去成都', status: 'active' });
    expect(detail.totalCents).toBe(9000);
    expect(detail.byCategory).toEqual([
      { categoryId: foodId, name: '饮食', cents: 6000 },
      { categoryId: otherId, name: '交通', cents: 2500 },
      { categoryId: '', name: '未分类', cents: 500 },
    ]);
    expect(detail.byCategory.reduce((sum, share) => sum + share.cents, 0)).toBe(
      detail.totalCents
    );
    expect(detail.recentTxns.map(row => row.id)).toEqual([
      uncategorised,
      transport,
      foodAgain,
      food,
    ]);
  });

  it('merges a null category and the system 未分类 category into one bucket', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });
    const nullCategory = await spend(db, accountId, null, 100);
    const systemCategory = await spend(db, accountId, 'uncategorized', 200);
    await setTxnProject(db, nullCategory, projectId);
    await setTxnProject(db, systemCategory, projectId);

    expect((await projectDetail(db, projectId)).byCategory).toEqual([
      { categoryId: '', name: '未分类', cents: 300 },
    ]);
    expect(foodId).toBeTruthy();
  });

  it('keeps at most five recent live rows by default and honours a limit', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });
    const ids: string[] = [];
    for (let index = 0; index < PROJECT_RECENT_TXN_LIMIT + 2; index += 1) {
      const day = String(index + 1).padStart(2, '0');
      const txnId = await spend(db, accountId, foodId, 100 + index, '', `2026-10-${day}`);
      await setTxnProject(db, txnId, projectId);
      ids.push(txnId);
    }
    const deleted = await spend(db, accountId, foodId, 999, '', '2026-10-09');
    await setTxnProject(db, deleted, projectId);
    await softDeleteTxn(db, deleted);

    const detail = await projectDetail(db, projectId);
    expect(detail.recentTxns).toHaveLength(PROJECT_RECENT_TXN_LIMIT);
    expect(detail.recentTxns.map(row => row.id)).toEqual(ids.slice(-5).reverse());

    const two = await projectDetail(db, projectId, { recentLimit: 2 });
    expect(two.recentTxns.map(row => row.id)).toEqual(ids.slice(-2).reverse());
  });

  it('refuses a nonsensical recent limit', async () => {
    const db = await createTestDb();
    const projectId = await createProject(db, { name: '旅行' });
    for (const recentLimit of [0, -1, 1.5]) {
      await expect(projectDetail(db, projectId, { recentLimit })).rejects.toThrow(
        /recentLimit/
      );
    }
  });

  it('still reports an archived project total', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });
    const txnId = await spend(db, accountId, foodId, 4321);
    await setTxnProject(db, txnId, projectId);
    await archiveProject(db, projectId);

    const detail = await projectDetail(db, projectId);
    expect(detail.project.status).toBe('archived');
    expect(detail.totalCents).toBe(4321);
  });
});

describe('setProjectBudget', () => {
  it('sets and clears the cap without moving any money or row assignment', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });
    const txnId = await spend(db, accountId, foodId, 6230);
    await setTxnProject(db, txnId, projectId);

    await setProjectBudget(db, projectId, 200000);

    expect((await listProjects(db))[0]).toMatchObject({
      id: projectId,
      budgetCents: 200000,
    });
    expect(await projectTotals(db)).toEqual([
      expect.objectContaining({ id: projectId, totalCents: 6230, txnCount: 1 }),
    ]);
    expect(
      await db.get<{ project_id: string | null }>('SELECT project_id FROM txn WHERE id = ?', [
        txnId,
      ])
    ).toEqual({ project_id: projectId });

    await setProjectBudget(db, projectId, null);
    expect((await listProjects(db))[0].budgetCents).toBeNull();
    expect((await projectTotals(db))[0].totalCents).toBe(6230);
  });

  it('refuses fractional cents and an unknown project, leaving the old cap alone', async () => {
    const db = await createTestDb();
    const id = await createProject(db, { name: '旅行', budgetCents: 5000 });

    await expect(setProjectBudget(db, id, 12.5)).rejects.toThrow(/整数分/);
    await expect(setProjectBudget(db, 'missing', 100)).rejects.toThrow(/项目不存在/);
    expect((await listProjects(db))[0].budgetCents).toBe(5000);
  });
});

describe('TxnRow project marks', () => {
  it('carries the project id, its name and the archived flag on every row read', async () => {
    const db = await createTestDb();
    const { accountId, foodId } = await ledger(db);
    const projectId = await createProject(db, { name: '国庆去成都' });
    const txnId = await spend(db, accountId, foodId, 6230);
    await setTxnProject(db, txnId, projectId);

    const [monthRow] = await listTxnsByMonth(db, '2026-10');
    expect(monthRow).toMatchObject({
      id: txnId,
      projectId,
      projectName: '国庆去成都',
      projectArchived: false,
    });
    expect((await getTxnById(db, txnId))?.projectName).toBe('国庆去成都');

    // Archiving never clears the pointer: the name survives, only the flag flips.
    await archiveProject(db, projectId);
    expect(await getTxnById(db, txnId)).toMatchObject({
      projectId,
      projectName: '国庆去成都',
      projectArchived: true,
    });

    // A row that belongs to nothing reports nulls, not stale values.
    const loose = await spend(db, accountId, foodId, 100, '', '2026-10-21');
    expect(await getTxnById(db, loose)).toMatchObject({
      projectId: null,
      projectName: null,
      projectArchived: false,
    });
  });
});
