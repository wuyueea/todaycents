/**
 * 固定支出: the bills that come back every month, the list the owner agreed
 * to, and the total they add up to.
 *
 * Three rules shape this module.
 *
 * 1. Detection only writes hint rows. It never books a transaction, never
 *    edits one and never moves a category; `txn.is_fixed_cost` is the only
 *    ledger column this module ever writes, and only on confirm or undo.
 * 2. The list is derived, never stored. It is built from the live expense rows
 *    that carry `is_fixed_cost = 1`, so a manually flagged row appears without
 *    any hint and the total can never disagree with the rows behind it. A
 *    confirmed hint keeps the decisions (and the numbers the prompt showed),
 *    not a second copy of the money.
 * 3. 宁可漏报，不误报. The rule itself lives in domain/recurring; this file only
 *    feeds it, persists what it found and answers the screen.
 */
import type { Db } from '../driver';
import { newId } from '../id';
import { findRecurringRuns, monthEndClampedPlusOneMonth } from '../../domain/recurring';
import type { RecurringRow, RecurringRun } from '../../domain/recurring';
import { UNCATEGORIZED_CATEGORY_ID, UNCATEGORIZED_CATEGORY_NAME } from '../schema';

/** The three states the v4 CHECK allows. */
export type HintStatus = 'candidate' | 'confirmed' | 'dismissed';

/** A detected bill waiting for an answer, as the prompt renders it. */
export interface FixedCostCandidate {
  /** The hint id the confirm/dismiss calls address. */
  id: string;
  /** payee when there is one, otherwise the category name. */
  name: string;
  categoryId: string | null;
  payee: string | null;
  /** Integer cents: what the next month is expected to cost. */
  monthlyCents: number;
  /** The most recent bill of the run, YYYY-MM-DD. */
  lastDate: string;
  /** lastDate plus one month, clamped to the end of that month. */
  nextDate: string;
  /** How many bills the run holds. */
  occurrences: number;
  /** When the detector last described this identity, ISO-8601 instant. */
  detectedAt: string;
}

/** One line of the confirmed list, all of it derived from flagged rows. */
export interface FixedCost {
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  payee: string | null;
  /** The newest flagged bill's amount, positive integer cents. */
  monthlyCents: number;
  lastDate: string;
  nextDate: string;
  /** Day of the month the money leaves, 1–31, taken from lastDate. */
  dayOfMonth: number;
  /** How many live flagged rows stand behind this line. */
  occurrences: number;
}

/** Everything detectCandidates accepts; `now` exists so tests can pin the stamp. */
export interface DetectOptions {
  /** ISO-8601 instant recorded as detected_at. Default: the current time. */
  now?: string;
}

/** Raw hint row; the only shape that knows the snake_case column names. */
interface HintRow {
  id: string;
  category_id: string | null;
  payee: string | null;
  status: HintStatus;
  monthly_cents: number;
  last_date: string;
  next_date: string;
  occurrences: number;
  detected_at: string;
}

const HINT_COLUMNS =
  'id, category_id, payee, status, monthly_cents, last_date, next_date, occurrences, detected_at';

/** A live expense row plus the category name its prompt may fall back to. */
interface BillRow {
  id: string;
  occurred_date: string;
  amount_cents: number;
  category_id: string | null;
  payee: string | null;
  category_name: string | null;
  /** 1 on rows the owner flagged; the list's anchor. */
  is_fixed_cost?: number;
}

/**
 * The detector's input, in one place: live expenses only, in a category that
 * is not archived, with the amount stored the way the ledger stores it.
 *
 * The last clause refuses to build a candidate named 未分类: that bucket is
 * where a deleted category's rows land, and "买夜宵" recorded there every month
 * is exactly the false positive the plan forbids. A payee still names an
 * identity inside it, so 健身房 recorded in 未分类 is allowed through.
 */
const DETECTION_SQL = `SELECT t.id AS id, t.occurred_date AS occurred_date,
        t.amount_cents AS amount_cents, t.category_id AS category_id,
        t.payee AS payee, c.name AS category_name
 FROM txn t
 JOIN category c ON c.id = t.category_id
 WHERE t.deleted_at IS NULL
   AND t.direction = 'expense'
   AND t.amount_cents < 0
   AND c.archived_at IS NULL
   AND (c.id <> ? OR TRIM(COALESCE(t.payee, '')) <> '')
 ORDER BY t.occurred_date, t.id`;

/**
 * The payee as the detector groups it: trimmed, with blank treated as absent.
 * Kept as one SQL expression so a lookup by identity matches the grouping the
 * pure rule performed on the very same rows — including the write below, which
 * names its column without a table alias.
 */
function normalizedPayeeSql(column = 't.payee'): string {
  return `(CASE WHEN TRIM(COALESCE(${column}, '')) = '' THEN NULL ELSE TRIM(${column}) END)`;
}

const NORMALIZED_PAYEE = normalizedPayeeSql();

/**
 * Every live bill of one identity, with the detector's own filters.
 *
 * Confirm re-derives the run through this instead of trusting the hint's
 * numbers: the schema has nowhere to store the run's row ids, and a row edited
 * between detection and confirm should move the run, not produce a flag on a
 * row the prompt never described.
 */
const IDENTITY_SQL = `SELECT t.id AS id, t.occurred_date AS occurred_date,
        t.amount_cents AS amount_cents, t.category_id AS category_id,
        t.payee AS payee, c.name AS category_name
 FROM txn t
 JOIN category c ON c.id = t.category_id
 WHERE t.deleted_at IS NULL
   AND t.direction = 'expense'
   AND t.amount_cents < 0
   AND t.category_id IS ?
   AND ${NORMALIZED_PAYEE} IS ?
   AND c.archived_at IS NULL
   AND (c.id <> ? OR TRIM(COALESCE(t.payee, '')) <> '')
 ORDER BY t.occurred_date, t.id`;

/**
 * Every live expense that belongs to an identity the owner has confirmed.
 *
 * Not just the flagged rows: once "话费 is fixed" is a decision, the next month's
 * bill is part of the same line even before anyone flags it, and the list has to
 * move 下次日期 forward on its own. The flagged rows decide *which* identities are
 * on the list; the whole identity decides *when* the next one is due.
 */
const FLAGGED_SQL = `WITH flagged AS (
   SELECT DISTINCT t.category_id AS cid, TRIM(COALESCE(t.payee, '')) AS payee
   FROM txn t
   WHERE t.deleted_at IS NULL AND t.direction = 'expense' AND t.is_fixed_cost = 1
 )
 SELECT t.id AS id, t.occurred_date AS occurred_date,
        t.amount_cents AS amount_cents, t.category_id AS category_id,
        t.payee AS payee, c.name AS category_name, t.is_fixed_cost AS is_fixed_cost
 FROM txn t
 LEFT JOIN category c ON c.id = t.category_id
 JOIN flagged f ON f.cid IS t.category_id AND f.payee = TRIM(COALESCE(t.payee, ''))
 WHERE t.deleted_at IS NULL
   AND t.direction = 'expense'
 ORDER BY t.occurred_date, t.id`;

/** Candidates with the name their category gives them. */
const LIST_CANDIDATES_SQL = `SELECT h.id AS id, h.category_id AS category_id, h.payee AS payee,
        h.status AS status, h.monthly_cents AS monthly_cents, h.last_date AS last_date,
        h.next_date AS next_date, h.occurrences AS occurrences, h.detected_at AS detected_at,
        c.name AS category_name
 FROM recurring_hint h
 LEFT JOIN category c ON c.id = h.category_id
 WHERE h.status = 'candidate'
 ORDER BY h.last_date DESC, h.id`;

/** What a list row or a prompt is called: payee first, then the category. */
function displayName(payee: string | null, categoryName: string | null): string {
  return payee ?? categoryName ?? UNCATEGORIZED_CATEGORY_NAME;
}

/** One identity's flagged rows while listFixedCosts folds them into a line. */
interface FlaggedGroup {
  categoryId: string | null;
  payee: string | null;
  categoryName: string | null;
  /** Newest bill of the identity, flagged or not. */
  latest: BillRow;
  /** Newest bill the owner actually flagged; the walk's starting point. */
  anchor: BillRow;
  occurrences: number;
  /** Every bill of the identity, oldest first. */
  rows: BillRow[];
}

/** The day of the month a bill left, 1–31, read from the literal date. */
function dayOfMonth(dateISO: string): number {
  return Number(dateISO.slice(8, 10));
}

/** One detected run as the pure module sees it. */
function toRecurringRow(row: BillRow): RecurringRow {
  return {
    id: row.id,
    occurredDate: row.occurred_date,
    // Expenses are stored negative; the detector compares magnitudes.
    amountCents: -row.amount_cents,
    categoryId: row.category_id,
    payee: row.payee,
  };
}

/** Category names for the prompt fallback, from the rows that are already in memory. */
function categoryNamesById(rows: readonly BillRow[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const row of rows) {
    if (row.category_id !== null && row.category_name !== null) {
      names[row.category_id] = row.category_name;
    }
  }
  return names;
}

/** One hint, or a user-facing error naming the id that was addressed. */
async function getHint(db: Db, id: string): Promise<HintRow> {
  const row = await db.get<HintRow>(
    `SELECT ${HINT_COLUMNS} FROM recurring_hint WHERE id = ?`,
    [id]
  );
  if (row === undefined) {
    throw new Error(`没有这条固定支出候选：${id}`);
  }
  return row;
}

/**
 * The run an identity still produces right now, or null when its bills no
 * longer add up to one. One run per identity is the contract, but the pure
 * function returns a list; filtering by the hint's identity keeps this honest
 * even if the rule ever grows a second source.
 */
async function resolveRun(db: Db, hint: HintRow): Promise<RecurringRun | null> {
  const rows = await db.all<BillRow>(IDENTITY_SQL, [
    hint.category_id,
    hint.payee,
    UNCATEGORIZED_CATEGORY_ID,
  ]);
  const runs = findRecurringRuns(rows.map(toRecurringRow), {
    categoryNames: categoryNamesById(rows),
  });
  return (
    runs.find(run => run.categoryId === hint.category_id && run.payee === hint.payee) ?? null
  );
}

/** The confirmed list item one run describes, before anything is written. */
function toFixedCost(run: RecurringRun, categoryName: string | null): FixedCost {
  return {
    name: displayName(run.payee, categoryName),
    categoryId: run.categoryId,
    categoryName,
    payee: run.payee,
    monthlyCents: run.monthlyCents,
    lastDate: run.lastDate,
    nextDate: run.nextDate,
    dayOfMonth: dayOfMonth(run.lastDate),
    occurrences: run.occurrences,
  };
}

/** Runs detection, persists what it found and answers with the open prompts. */
export async function detectCandidates(
  db: Db,
  opts: DetectOptions = {}
): Promise<FixedCostCandidate[]> {
  const detectedAt = opts.now ?? new Date().toISOString();

  const bills = await db.all<BillRow>(DETECTION_SQL, [UNCATEGORIZED_CATEGORY_ID]);
  const runs = findRecurringRuns(bills.map(toRecurringRow), {
    categoryNames: categoryNamesById(bills),
  });

  // One transaction: a detection either records the whole picture or nothing,
  // so two devices can never leave half a prompt behind. The driver's
  // transactions are not re-entrant, so callers must not wrap this call.
  return db.transaction(async tx => {
    const hints = await tx.all<HintRow>(`SELECT ${HINT_COLUMNS} FROM recurring_hint`);
    const byKey = new Map(
      hints.map(hint => [JSON.stringify([hint.category_id, hint.payee]), hint])
    );
    const kept = new Set<string>();

    for (const run of runs) {
      const key = JSON.stringify([run.categoryId, run.payee]);
      const existing = byKey.get(key);
      // A confirmed or dismissed identity is settled: asking again would be
      // the one thing the plan forbids outright. Its stored snapshot stays as
      // the record of what was decided.
      if (existing !== undefined && existing.status !== 'candidate') continue;

      if (existing === undefined) {
        const id = newId();
        await tx.run(
          `INSERT INTO recurring_hint
             (id, category_id, payee, status, monthly_cents, last_date, next_date,
              occurrences, detected_at)
           VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?, ?)`,
          [
            id,
            run.categoryId,
            run.payee,
            run.monthlyCents,
            run.lastDate,
            run.nextDate,
            run.occurrences,
            detectedAt,
          ]
        );
        kept.add(id);
      } else {
        await tx.run(
          `UPDATE recurring_hint
              SET monthly_cents = ?, last_date = ?, next_date = ?, occurrences = ?,
                  detected_at = ?
            WHERE id = ?`,
          [
            run.monthlyCents,
            run.lastDate,
            run.nextDate,
            run.occurrences,
            detectedAt,
            existing.id,
          ]
        );
        kept.add(existing.id);
      }
    }

    // A prompt whose bills no longer support it is not a prompt any more.
    // Only candidates are collected; a decision is never thrown away here.
    for (const hint of hints) {
      if (hint.status !== 'candidate') continue;
      if (kept.has(hint.id)) continue;
      await tx.run('DELETE FROM recurring_hint WHERE id = ?', [hint.id]);
    }

    return listCandidates(tx);
  });
}

/** The open prompts, newest bill first. */
export async function listCandidates(db: Db): Promise<FixedCostCandidate[]> {
  const rows = await db.all<
    HintRow & { category_name: string | null }
  >(LIST_CANDIDATES_SQL);

  return rows.map(row => ({
    id: row.id,
    name: displayName(row.payee, row.category_name),
    categoryId: row.category_id,
    payee: row.payee,
    monthlyCents: row.monthly_cents,
    lastDate: row.last_date,
    nextDate: row.next_date,
    occurrences: row.occurrences,
    detectedAt: row.detected_at,
  }));
}

/**
 * Accepts one candidate: the run's rows become 固定支出, the hint records the
 * decision, and the caller gets the line the list now holds.
 *
 * The run is re-derived from the live ledger rather than read from the hint,
 * because the hint cannot store which rows it described. Re-deriving means a
 * bill entered between detection and confirm is included, and a run whose
 * evidence vanished refuses instead of flagging something the prompt never
 * mentioned. Confirming an already confirmed candidate writes nothing and
 * returns the current line, so a double tap can neither duplicate nor extend
 * the decision.
 */
export async function confirmCandidate(db: Db, hintId: string): Promise<FixedCost> {
  const hint = await getHint(db, hintId);
  if (hint.status === 'dismissed') {
    throw new Error(`这条候选已经被忽略，不能再加入清单：${hintId}`);
  }

  const run = await resolveRun(db, hint);
  if (run === null) {
    throw new Error(`这条候选已经没有足够的流水支撑，请重新识别：${hintId}`);
  }
  const categoryName = await categoryNameOf(db, run.categoryId);
  const item = toFixedCost(run, categoryName);
  if (hint.status === 'confirmed') return item;

  return db.transaction(async tx => {
    const placeholders = run.txnIds.map(() => '?').join(', ');
    await tx.run(`UPDATE txn SET is_fixed_cost = 1 WHERE id IN (${placeholders})`, [
      ...run.txnIds,
    ]);
    await tx.run(
      `UPDATE recurring_hint
          SET status = 'confirmed', monthly_cents = ?, last_date = ?, next_date = ?,
              occurrences = ?, detected_at = ?
        WHERE id = ?`,
      [
        run.monthlyCents,
        run.lastDate,
        run.nextDate,
        run.occurrences,
        new Date().toISOString(),
        hintId,
      ]
    );
    return item;
  });
}

/** Refuses to ask again: the identity is dismissed for good, nothing is flagged. */
export async function dismissCandidate(db: Db, hintId: string): Promise<void> {
  const hint = await getHint(db, hintId);
  if (hint.status === 'confirmed') {
    throw new Error(`这条固定支出已经在清单里，不能再忽略：${hintId}`);
  }
  if (hint.status === 'dismissed') return;
  await db.run("UPDATE recurring_hint SET status = 'dismissed' WHERE id = ?", [hintId]);
}

/** The category's display name, or null when the row is gone. */
async function categoryNameOf(db: Db, categoryId: string | null): Promise<string | null> {
  if (categoryId === null) return null;
  const row = await db.get<{ name: string }>('SELECT name FROM category WHERE id = ?', [
    categoryId,
  ]);
  return row?.name ?? null;
}

/**
 * The confirmed list, built from the live flagged expense rows.
 *
 * Rows are grouped by the same identity detection uses — category plus payee —
 * and each group becomes one line: the newest bill supplies the amount, the
 * date and the day of the month, and the clamped next date is the month after
 * it. Only the latest amount counts, never the sum of every flagged row; the
 * list answers "what will next month cost", not "what did this pattern cost".
 *
 * Rows whose category was archived or deleted still count: 历史保留. A flagged
 * row in a deleted category has been reflowed into 未分类 by then, which is why
 * the join is a LEFT JOIN and the name falls back to the payee.
 */
export async function listFixedCosts(db: Db): Promise<FixedCost[]> {
  const rows = await db.all<BillRow>(FLAGGED_SQL);
  const groups = new Map<string, FlaggedGroup>();
  for (const row of rows) {
    // Blank payees are no payee, exactly as the detector groups them.
    const trimmedPayee = (row.payee ?? '').trim();
    const payee = trimmedPayee === '' ? null : trimmedPayee;
    const key = JSON.stringify([row.category_id, payee]);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        categoryId: row.category_id,
        payee,
        categoryName: row.category_name,
        latest: row,
        anchor: row,
        occurrences: 1,
        rows: [row],
      });
    } else {
      existing.latest = row; // rows arrive oldest first
      existing.rows.push(row);
      existing.occurrences += 1;
      if (row.is_fixed_cost === 1) existing.anchor = row;
    }
  }

  const items = [...groups.values()].map(group => {
    const bill = latestPlausibleOccurrence(group);
    return {
      name: displayName(group.payee, group.categoryName),
      categoryId: group.categoryId,
      categoryName: group.categoryName,
      payee: group.payee,
      monthlyCents: -bill.amount_cents,
      lastDate: bill.occurred_date,
      nextDate: monthEndClampedPlusOneMonth(bill.occurred_date),
      dayOfMonth: dayOfMonth(bill.occurred_date),
      occurrences: group.occurrences,
    };
  });

  return items.sort(
    (left, right) =>
      left.nextDate.localeCompare(right.nextDate) ||
      left.name.localeCompare(right.name) ||
      (left.categoryId ?? '').localeCompare(right.categoryId ?? '')
  );
}

/**
 * The bill the line currently points at.
 *
 * Starts from the row the owner actually flagged, then walks forward through the
 * identity's later bills, accepting one only when its amount is within the
 * detector's own ±15%. A month that looks like the same charge moves the date
 * and the amount; a one-off shopping trip in the same category does not.
 */
function latestPlausibleOccurrence(group: FlaggedGroup): BillRow {
  let current = group.anchor;
  for (const row of group.rows) {
    if (row.occurred_date <= current.occurred_date) continue;
    if (row.is_fixed_cost === 1) {
      current = row;
      continue;
    }
    if (withinTolerance(row.amount_cents, current.amount_cents)) current = row;
  }
  return current;
}

/** Same tolerance the detector uses: 15%, compared in integers. */
function withinTolerance(left: number, right: number): boolean {
  const difference = Math.abs(left - right) * 100;
  return difference <= Math.abs(right) * 15;
}

/**
 * The owner's own verdict on one row: 这是固定支出 / 不是.
 *
 * The detector can only see a habit after it repeats; a person can decide on the
 * first bill. Flagging makes the row an anchor for its identity, so the list
 * picks it up immediately; clearing it takes that anchor away again.
 */
export async function setTxnFixedCost(db: Db, txnId: string, on: boolean): Promise<void> {
  const row = await db.get<{ direction: string; amount_cents: number; deleted_at: string | null }>(
    'SELECT direction, amount_cents, deleted_at FROM txn WHERE id = ?',
    [txnId]
  );
  if (row === undefined) {
    throw new Error(`流水不存在：${txnId}`);
  }
  if (row.deleted_at !== null) {
    throw new Error('已删除的流水不能标记为固定支出。');
  }
  if (row.direction !== 'expense' || row.amount_cents >= 0) {
    throw new Error('只有支出可以标记为固定支出。');
  }
  await db.run('UPDATE txn SET is_fixed_cost = ? WHERE id = ?', [on ? 1 : 0, txnId]);
}

/**
 * What the confirmed list costs per month, in integer cents.
 *
 * Summed from listFixedCosts on purpose: the header and the lines can never
 * disagree, because there is exactly one derivation of "每月多少钱". This is
 * the money already promised — not what this month's ledger happens to show.
 */
export async function monthlyTotalCents(db: Db): Promise<number> {
  const items = await listFixedCosts(db);
  return items.reduce((total, item) => total + item.monthlyCents, 0);
}

/**
 * How many distinct calendar months hold a live expense.
 *
 * The empty state needs to say "历史只有 1 个月" honestly: three rows in one
 * month are still one month of history. Months are read from the date prefix,
 * exactly like every other bucket in the ledger, so no time zone can move a
 * bill into a month it was not recorded in. Income, transfers and adjustments
 * are not spending history and do not count; a soft-deleted bill is gone.
 */
export async function countExpenseMonths(db: Db): Promise<number> {
  const row = await db.get<{ months: number }>(
    `SELECT COUNT(DISTINCT substr(t.occurred_date, 1, 7)) AS months
       FROM txn t
      WHERE t.deleted_at IS NULL
        AND t.direction = 'expense'
        AND t.amount_cents < 0`
  );
  return row?.months ?? 0;
}

/**
 * Undo for a confirmation: the flags go back to 0, the hint returns to
 * candidate, and the list and total fall back with them.
 *
 * The whole identity is unmarked, not just the run's rows, so "合计与清单立即
 * 回退" holds even when an older row of the same bill was flagged by hand.
 * Rows are never deleted and no category moves. The undo is offered once,
 * immediately after confirm (§4.3), which is why an identity-wide undo is
 * safe: nothing else has happened in between.
 *
 * A row re-categorised between confirm and undo keeps its flag — the identity
 * it now belongs to is a different one — and is the only state this cannot
 * reach.
 */
export async function unmarkFixed(db: Db, hintId: string): Promise<FixedCostCandidate> {
  const hint = await getHint(db, hintId);
  if (hint.status === 'dismissed') {
    throw new Error(`这条候选已经被忽略：${hintId}`);
  }

  return db.transaction(async tx => {
    if (hint.status === 'confirmed') {
      await tx.run(
        `UPDATE txn SET is_fixed_cost = 0
          WHERE is_fixed_cost = 1 AND deleted_at IS NULL AND direction = 'expense'
            AND category_id IS ? AND ${normalizedPayeeSql('payee')} IS ?`,
        [hint.category_id, hint.payee]
      );
      // detected_at keeps describing the detection, not the undo: the next
      // detectCandidates refreshes it anyway, and this call must not pretend
      // to have looked at the ledger.
      await tx.run("UPDATE recurring_hint SET status = 'candidate' WHERE id = ?", [hintId]);
    }

    const candidates = await listCandidates(tx);
    const restored = candidates.find(candidate => candidate.id === hintId);
    if (restored === undefined) {
      // Unreachable while the row exists; the guard keeps the return type
      // honest instead of asserting with !.
      throw new Error(`没有这条固定支出候选：${hintId}`);
    }
    return restored;
  });
}
