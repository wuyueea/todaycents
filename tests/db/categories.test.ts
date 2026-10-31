import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import { createCategory, listCategories } from '../../src/db/repos/categories';
import { seedDefaults } from '../../src/db/seed';
import { listAccounts } from '../../src/db/repos/accounts';

/** The system row exists in every migrated database; count only user rows. */
const SYSTEM_ID = 'uncategorized';

function withoutSystem<T extends { id: string }>(rows: T[]): T[] {
  return rows.filter(row => row.id !== SYSTEM_ID);
}

describe('categories', () => {
  it('creates a two-level tree and rejects a third level', async () => {
    const db = await createTestDb();
    const sport = await createCategory(db, { name: '运动', kind: 'expense' });
    const badminton = await createCategory(db, { name: '羽毛球', kind: 'expense', parentId: sport });
    await expect(createCategory(db, { name: '球拍', kind: 'expense', parentId: badminton })).rejects.toThrow();
    expect(withoutSystem(await listCategories(db))).toHaveLength(2);
  });
  it('seeds defaults exactly once', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    const first = await listCategories(db);
    await seedDefaults(db);
    expect((await listCategories(db)).length).toBe(first.length);
    expect(first.map(c => c.name)).toEqual(expect.arrayContaining(['饮食','日用','交通','通讯','运动','医疗','居住','订阅','其他']));
  });
});

describe('category ordering', () => {
  it('numbers siblings from zero inside each kind and each parent', async () => {
    const db = await createTestDb();
    const food = await createCategory(db, { name: '饮食', kind: 'expense' });
    const daily = await createCategory(db, { name: '日用', kind: 'expense' });
    const salary = await createCategory(db, { name: '生活费', kind: 'income' });
    const breakfast = await createCategory(db, { name: '早餐', kind: 'expense', parentId: food });
    const lunch = await createCategory(db, { name: '午餐', kind: 'expense', parentId: food });

    const byId = new Map((await listCategories(db)).map(c => [c.id, c]));
    expect(byId.get(food)?.sort).toBe(0);
    expect(byId.get(daily)?.sort).toBe(1);
    expect(byId.get(salary)?.sort).toBe(0); // income numbering restarts at zero
    expect(byId.get(breakfast)?.sort).toBe(0); // children are numbered under their own parent
    expect(byId.get(lunch)?.sort).toBe(1);
  });

  it('filters by kind and orders ascending by sort', async () => {
    const db = await createTestDb();
    await createCategory(db, { name: '奖金', kind: 'income', sort: 5 });
    await createCategory(db, { name: '其他', kind: 'expense', sort: 1 });
    await createCategory(db, { name: '饮食', kind: 'expense', sort: 0 });

    expect(withoutSystem(await listCategories(db, 'expense')).map(c => [c.name, c.sort])).toEqual([
      ['饮食', 0],
      ['其他', 1],
    ]);
    expect((await listCategories(db, 'income')).map(c => c.name)).toEqual(['奖金']);
  });

  it('hides archived categories without deleting the row', async () => {
    const db = await createTestDb();
    const old = await createCategory(db, { name: '旧分类', kind: 'expense' });
    await db.run('UPDATE category SET archived_at = ? WHERE id = ?', ['2026-10-01T00:00:00.000Z', old]);

    expect(withoutSystem(await listCategories(db))).toHaveLength(0);
    expect(
      (await listCategories(db, undefined, { includeArchived: true })).find(
        category => category.id === old
      )?.archivedAt
    ).not.toBeNull();
    expect(
      await db.all('SELECT id FROM category WHERE id <> ?', [SYSTEM_ID])
    ).toHaveLength(1);
  });
});

describe('category tree depth', () => {
  it('keeps the stated message when a third level is attempted', async () => {
    const db = await createTestDb();
    const sport = await createCategory(db, { name: '运动', kind: 'expense' });
    const badminton = await createCategory(db, { name: '羽毛球', kind: 'expense', parentId: sport });

    await expect(
      createCategory(db, { name: '球拍', kind: 'expense', parentId: badminton })
    ).rejects.toThrow('分类最多两级');
    expect(
      await db.all('SELECT id FROM category WHERE id <> ?', [SYSTEM_ID])
    ).toHaveLength(2);
  });

  it('rejects a parent that does not exist instead of leaning on the foreign key', async () => {
    const db = await createTestDb();
    await expect(
      createCategory(db, { name: '羽毛球', kind: 'expense', parentId: 'missing-parent' })
    ).rejects.toThrow(/not found/);
    expect(
      await db.all('SELECT id FROM category WHERE id <> ?', [SYSTEM_ID])
    ).toHaveLength(0);
  });

  it('rejects a child whose kind differs from its parent', async () => {
    const db = await createTestDb();
    const salary = await createCategory(db, { name: '生活费', kind: 'income' });
    await expect(
      createCategory(db, { name: '早餐', kind: 'expense', parentId: salary })
    ).rejects.toThrow(/kind/);
    expect(
      await db.all('SELECT id FROM category WHERE id <> ?', [SYSTEM_ID])
    ).toHaveLength(1);
  });
});

describe('seedDefaults content', () => {
  it('writes the starter categories in display order', async () => {
    const db = await createTestDb();
    await seedDefaults(db);

    const expense = withoutSystem(await listCategories(db, 'expense'));
    expect(expense.map(c => c.name)).toEqual(['饮食', '日用', '交通', '通讯', '运动', '医疗', '居住', '订阅', '其他']);
    expect(expense.map(c => c.sort)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(expense.every(c => c.parentId === null)).toBe(true);

    const income = await listCategories(db, 'income');
    expect(income.map(c => c.name)).toEqual(['生活费', '奖金', '报销']);
    expect(income.map(c => c.sort)).toEqual([0, 1, 2]);
  });

  it('writes exactly the three starter accounts, in display order', async () => {
    const db = await createTestDb();
    await seedDefaults(db);

    expect((await listAccounts(db)).map(a => [a.name, a.type, a.monthlyBudgetCents, a.initialBalanceCents, a.sort])).toEqual([
      ['微信', 'ewallet', null, 0, 0],
      ['支付宝', 'ewallet', null, 0, 1],
      ['银行卡', 'bank', null, 0, 2],
    ]);
  });

  it('writes no template rows', async () => {
    const db = await createTestDb();
    await seedDefaults(db);

    // The template table and its repository remain for a future feature, but
    // nothing seeds the retired day grid any more.
    expect(await db.all('SELECT id FROM template')).toEqual([]);
  });
});

describe('seedDefaults safety', () => {
  async function snapshot(db: Awaited<ReturnType<typeof createTestDb>>) {
    return {
      category: await db.all('SELECT id, parent_id, name, kind, sort, archived_at FROM category ORDER BY id'),
      account: await db.all(
        'SELECT id, name, type, initial_balance_cents, monthly_budget_cents, sort, archived_at, created_at FROM account ORDER BY id'
      ),
      template: await db.all(
        'SELECT id, slot_key, label, category_id, default_account_id, default_amount_cents, sort, active FROM template ORDER BY id'
      ),
    };
  }

  it('leaves the database unchanged on a second call', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    const before = await snapshot(db);

    await seedDefaults(db);

    expect(await snapshot(db)).toEqual(before);
  });

  it('does nothing at all when any category row already exists', async () => {
    const db = await createTestDb();
    await createCategory(db, { name: '手工分类', kind: 'expense' });

    await seedDefaults(db);

    expect(withoutSystem(await listCategories(db)).map(c => c.name)).toEqual(['手工分类']);
    expect(await db.all('SELECT id FROM account')).toHaveLength(0);
    expect(await db.all('SELECT id FROM template')).toHaveLength(0);
  });

  it('rolls the whole seed back when it cannot finish', async () => {
    const db = await createTestDb();
    // The categories are written first and the accounts second, so aborting the
    // first account insert fails the seed halfway: the one transaction must
    // leave no categories behind, not a half-written starter set.
    await db.exec(
      `CREATE TRIGGER seed_interrupted BEFORE INSERT ON account
       BEGIN SELECT RAISE(ABORT, 'seed interrupted'); END`
    );

    await expect(seedDefaults(db)).rejects.toThrow(/seed interrupted/);
    expect(
      await db.all('SELECT id FROM category WHERE id <> ?', [SYSTEM_ID])
    ).toHaveLength(0);
    expect(await db.all('SELECT id FROM account')).toHaveLength(0);
    expect(await db.all('SELECT id FROM template')).toHaveLength(0);
  });
});
