import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/driver';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults, seedInto } from '../../src/db/seed';
import { listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import { UNCATEGORIZED_CATEGORY_ID } from '../../src/db/schema';

/**
 * Everything the seed writes, minus the random ids: categories in display
 * order and accounts in display order. Two databases that were seeded by
 * different entry points must agree.
 */
async function starterShape(db: Db) {
  return {
    categories: await db.all(
      'SELECT parent_id IS NULL AS is_root, name, kind, sort FROM category ORDER BY kind, sort, name'
    ),
    accounts: await db.all(
      `SELECT name, type, initial_balance_cents, monthly_budget_cents, sort, archived_at
         FROM account ORDER BY sort`
    ),
  };
}

describe('seedInto', () => {
  it('writes exactly the rows seedDefaults writes', async () => {
    const viaDefaults = await createTestDb();
    await seedDefaults(viaDefaults);

    const direct = await createTestDb();
    await seedInto(direct);

    expect(await starterShape(direct)).toEqual(await starterShape(viaDefaults));
    // Not vacuous: the shared shape is the full starter set.
    const userCategories = (await listCategories(direct)).filter(
      category => category.id !== UNCATEGORIZED_CATEGORY_ID
    );
    expect(userCategories).toHaveLength(12);
    expect((await listAccounts(direct)).map(account => account.name)).toEqual([
      '微信',
      '支付宝',
      '银行卡',
    ]);
    // Templates are not starter data any more, on either entry point.
    expect(await direct.all('SELECT id FROM template')).toEqual([]);
    expect(await viaDefaults.all('SELECT id FROM template')).toEqual([]);
  });

  it("writes into the caller's transaction instead of committing on its own", async () => {
    const db = await createTestDb();

    // seedInto opens no transaction of its own, so every starter row belongs to
    // the caller's unit of work: rolling that back takes the whole set with it.
    // Both a first launch and 清除所有数据 depend on this.
    await expect(
      db.transaction(async tx => {
        await seedInto(tx);
        throw new Error('seed rolled back');
      })
    ).rejects.toThrow('seed rolled back');

    expect(await db.all('SELECT id FROM account')).toEqual([]);
    // 未分类 is written by the migration, not by the seed: it is still there.
    expect(
      await db.all('SELECT id FROM category WHERE id <> ?', [UNCATEGORIZED_CATEGORY_ID])
    ).toEqual([]);
  });
});
