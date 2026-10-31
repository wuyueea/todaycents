/**
 * 清除所有数据: put the database back to what a first launch leaves behind.
 *
 * One transaction removes every ledger row and writes the starter set again.
 * The deletes run children-first (RESET_TABLES) because foreign keys are on
 * for the whole app; the txn_tag -> txn/tag, txn -> account/category and
 * template -> category/account relations would all reject another order.
 *
 * schema_migrations is deliberately absent from that list. It records how far
 * the database's own schema has been upgraded, not anything the owner typed;
 * emptying it would make the next launch's migrate() re-run v1's
 * "CREATE TABLE account" and fail before the app could even open — and it would
 * fail again every launch, because the record would still be gone. The backup
 * codec's restore makes the same distinction.
 *
 * app_meta IS emptied: the last-backup record belongs to the ledger being
 * erased, and a fresh install has none.
 *
 * Nothing here formats money or knows about files; the backup/factory-reset
 * flow in src/backup/flow.ts owns the safety copy, and backup/format.ts owns
 * the copy the sheet and the toast show.
 */
import type { Db } from './driver';
import { seedInto } from './seed';
import {
  UNCATEGORIZED_CATEGORY_ID,
  UNCATEGORIZED_CATEGORY_NAME,
  UNCATEGORIZED_CATEGORY_SORT,
} from './schema';

/**
 * Every table this reset empties, children before parents.
 *
 * project sits before tag/template and after txn because txn.project_id points
 * at it (enforced by the repository, not by a foreign key). recurring_hint is
 * removed before category even though its category_id has no foreign key: a
 * hint is a snapshot of a detector run over rows that are about to disappear.
 */
const RESET_TABLES = [
  'txn_tag',
  'txn',
  'recurring_hint',
  'project',
  'tag',
  'template',
  'category',
  'account',
  'app_meta',
] as const;

/**
 * The row counts the confirmation sheet states, read in one statement so the
 * five numbers describe a single moment rather than five.
 *
 * Every count is the number of rows the wipe will remove. Archived rows count
 * too: archiving hides a row, it does not stop the reset from deleting it, and
 * "会消失" has to mean what happens. txn matches countTxnRows and the backup
 * format's 笔流水 (soft-deleted rows included). category excludes the system
 * 未分类 row: it is the app's own reflow bucket, it is immediately re-created,
 * and it was never the owner's data.
 */
export interface ResetCounts {
  txn: number;
  account: number;
  category: number;
  tag: number;
  project: number;
}

const COUNT_SQL = `SELECT
   (SELECT COUNT(*) FROM txn) AS txn,
   (SELECT COUNT(*) FROM account) AS account,
   (SELECT COUNT(*) FROM category WHERE id <> ?) AS category,
   (SELECT COUNT(*) FROM tag) AS tag,
   (SELECT COUNT(*) FROM project) AS project`;

/**
 * The system category, re-created exactly as migration v2 created it.
 *
 * INSERT OR IGNORE keeps the statement idempotent, like the migration and the
 * restore codec's own re-insert: a database that somehow still carries the row
 * must not fail the reset over it.
 */
const INSERT_SYSTEM_CATEGORY = `INSERT OR IGNORE INTO category
   (id, parent_id, name, kind, sort, archived_at)
 VALUES (?, NULL, ?, 'expense', ?, NULL)`;

/** The five numbers the confirmation sheet and the reset toast need. */
export async function readResetCounts(db: Db): Promise<ResetCounts> {
  const row = await db.get<ResetCounts>(COUNT_SQL, [UNCATEGORIZED_CATEGORY_ID]);
  // Five scalar subqueries and no GROUP BY: SQLite always answers with exactly
  // one row, even on empty tables. A missing row therefore means the schema
  // itself is damaged, and reporting "0 rows will disappear" right before a
  // wipe would be the worst possible lie — refuse instead of defaulting.
  if (row === undefined) {
    throw new Error('读不到要清除的数据量，已取消');
  }
  return row;
}

/**
 * Empties every ledger table and writes the starter set back — the data side
 * of 清除所有数据.
 *
 * The starter set is exactly what a first launch writes: three accounts
 * (微信, 支付宝, 银行卡) and the twelve categories. seedInto is the single
 * definition of it, so the reset and a fresh install cannot drift apart.
 *
 * The whole thing is ONE transaction. A reset that failed halfway would leave
 * an owner with neither their records nor a working starter set, and unlike a
 * half-finished first seed there is no next launch that could complete it; the
 * driver's ROLLBACK is what puts every deleted row back.
 *
 * The system 未分类 category is re-inserted before the seed runs. It is what a
 * deleted category's transactions reflow into, and createCategory's nextSort
 * skips it, so the seeded expense roots still start at sort 0. seedInto writes
 * the rest; it opens no transaction, which is why it can be handed this one.
 */
export async function resetLedger(db: Db): Promise<void> {
  await db.transaction(async tx => {
    for (const table of RESET_TABLES) {
      await tx.run(`DELETE FROM ${table}`);
    }

    await tx.run(INSERT_SYSTEM_CATEGORY, [
      UNCATEGORIZED_CATEGORY_ID,
      UNCATEGORIZED_CATEGORY_NAME,
      UNCATEGORIZED_CATEGORY_SORT,
    ]);

    await seedInto(tx);
  });
}
