/**
 * Starter taxonomy and accounts, written once the first time the app opens.
 *
 * Idempotency is an up-front guard, not conflict handling: as soon as one
 * user category row exists the database counts as seeded, and a second call
 * reads nothing further and writes nothing at all. The system 未分类 row that
 * migration v2 writes does not count: it exists before the first seed, so
 * including it would make a fresh database look seeded and permanently skip
 * the starter taxonomy.
 *
 * The body and the unit of work are split on purpose. seedDefaults is the first
 * launch's entry point: guard plus ONE transaction. seedInto is only the body,
 * so 清除所有数据 can write the very same starter set inside the reset's own
 * transaction instead of keeping a second copy of the seed data. Both callers
 * want the same rows: a first launch and a reset leave one identical starter
 * set. The driver's transactions are not re-entrant, so nothing called from
 * seedInto may open one; accounts.ts and categories.ts never do, which is why
 * they are safe to call with the transaction handle. A seed that failed halfway
 * would leave categories without accounts — and, because of the guard, would
 * never be completed on the next launch.
 */
import type { Db } from './driver';
import type { AccountType } from '../domain/types';
import { createAccount } from './repos/accounts';
import { createCategory } from './repos/categories';
import { UNCATEGORIZED_CATEGORY_ID } from './schema';

/** Root expense categories, in display order; the array index becomes sort. */
const EXPENSE_CATEGORY_NAMES = ['饮食', '日用', '交通', '通讯', '运动', '医疗', '居住', '订阅', '其他'];

/** Root income categories, in display order. */
const INCOME_CATEGORY_NAMES = ['生活费', '奖金', '报销'];

/**
 * Default accounts, in display order. Money is integer cents, and none of the
 * starter accounts carries a monthly budget, so every value is null.
 */
const DEFAULT_ACCOUNTS: ReadonlyArray<{
  name: string;
  type: AccountType;
  monthlyBudgetCents: number | null;
}> = [
  { name: '微信', type: 'ewallet', monthlyBudgetCents: null },
  { name: '支付宝', type: 'ewallet', monthlyBudgetCents: null },
  { name: '银行卡', type: 'bank', monthlyBudgetCents: null },
];

/**
 * Writes the starter categories and accounts.
 *
 * No guard and no transaction of its own: the caller owns the unit of work.
 * seedDefaults wraps this body in its transaction on first launch, and
 * resetLedger calls it inside the reset transaction. Both paths therefore leave
 * the same three accounts and twelve categories, never a second, differing
 * starter set. It must only run on an empty taxonomy — it appends, and two
 * starter sets would look identical.
 */
export async function seedInto(db: Db): Promise<void> {
  // Roots only: the starter taxonomy is one level deep by design.
  for (const [sort, name] of EXPENSE_CATEGORY_NAMES.entries()) {
    await createCategory(db, { name, kind: 'expense', sort });
  }
  for (const [sort, name] of INCOME_CATEGORY_NAMES.entries()) {
    await createCategory(db, { name, kind: 'income', sort });
  }

  for (const [sort, account] of DEFAULT_ACCOUNTS.entries()) {
    await createAccount(db, {
      name: account.name,
      type: account.type,
      monthlyBudgetCents: account.monthlyBudgetCents,
      sort,
    });
  }
}

/**
 * Seeds the first launch, at most once.
 *
 * Safe to call on every launch: the first call seeds, every later call returns
 * before opening a transaction. Nothing here opens a nested transaction, so it
 * cannot be called from inside another unit of work.
 */
export async function seedDefaults(db: Db): Promise<void> {
  const existing = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM category WHERE id <> ?',
    [UNCATEGORIZED_CATEGORY_ID]
  );
  if ((existing?.n ?? 0) > 0) return;

  await db.transaction(seedInto);
}
