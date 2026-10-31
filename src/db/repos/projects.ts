/**
 * Projects: a bounded stretch of spending (a trip, a move) that can be
 * archived when it is over.
 *
 * A project owns no money. Its total is always SUM(-amount_cents) over the live
 * expense rows pointing at it, so it can never disagree with the ledger, and
 * archiving only flips status + archived_date: txn.project_id is never cleared,
 * otherwise the trip would lose its own history.
 *
 * The project does not touch monthly statistics. Attaching a row changes one
 * column, so the same expense still counts in its month and its category; the
 * project is a second, independent axis, not a filter on the first.
 *
 * txn.project_id has no foreign key (see migration v3 in schema.ts), so every
 * write here checks the reference itself.
 */
import type { Db } from '../driver';
import { newId } from '../id';
import type { CategoryShare, TxnRow } from './txns';
import { assertTxnDate, listTxnsByProject, mergeCategoryShares } from './txns';

/** The two states a project can be in; mirrors the v3 project.status CHECK. */
export type ProjectStatus = 'active' | 'archived';

/** A project as every screen consumes it; no raw columns leak out. */
export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  /** Optional spending cap in integer cents; null when the owner set none. */
  budgetCents: number | null;
  /** First day of the project as YYYY-MM-DD, or null when unknown. */
  startedDate: string | null;
  /** When the project was archived, or null while it is live. */
  archivedDate: string | null;
  createdAt: string;
}

/** Everything createProject needs. Money is integer cents, dates are YYYY-MM-DD. */
export interface CreateProjectInput {
  name: string;
  budgetCents?: number | null;
  startedDate?: string | null;
}

/** Raw project row; the only shape that knows about snake_case columns. */
interface ProjectRow {
  id: string;
  name: string;
  status: ProjectStatus;
  budget_cents: number | null;
  started_date: string | null;
  archived_date: string | null;
  created_at: string;
}

const PROJECT_COLUMNS =
  'id, name, status, budget_cents, started_date, archived_date, created_at';

/** Single row-to-object mapping; nothing else touches raw column names. */
function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    budgetCents: row.budget_cents,
    startedDate: row.started_date,
    archivedDate: row.archived_date,
    createdAt: row.created_at,
  };
}

/**
 * The one name normalisation every write shares: trim and refuse empty. Unlike
 * a tag name there is no length cap and no uniqueness: two trips may honestly
 * carry the same label, and the plan sets no limit.
 */
function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new Error('项目名不能为空');
  }
  return trimmed;
}

/** Guards the integer-cents invariant at the repository boundary. */
function assertIntegerCents(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`项目预算必须是整数分，收到 ${value}`);
  }
}

/** One project, or a user-facing error naming the id that was addressed. */
async function getProject(db: Db, id: string): Promise<Project> {
  const row = await db.get<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM project WHERE id = ?`,
    [id]
  );
  if (row === undefined) {
    throw new Error(`项目不存在：${id}`);
  }
  return toProject(row);
}

/** Creates one project in the active state and returns its id. */
export async function createProject(db: Db, input: CreateProjectInput): Promise<string> {
  const name = normalizeName(input.name);

  const budgetCents = input.budgetCents ?? null;
  if (budgetCents !== null) {
    assertIntegerCents(budgetCents);
  }

  const startedDate = input.startedDate ?? null;
  if (startedDate !== null) {
    // Reuses the ledger's one date rule: a start date that is not a real
    // calendar day would silently fall outside every range query.
    assertTxnDate(startedDate);
  }

  const id = newId();
  await db.run(
    `INSERT INTO project
       (id, name, status, budget_cents, started_date, archived_date, created_at)
     VALUES (?, ?, 'active', ?, ?, NULL, ?)`,
    [id, name, budgetCents, startedDate, new Date().toISOString()]
  );
  return id;
}

/**
 * Projects for the settings list. Archived ones are hidden unless asked for,
 * matching listTags/listAccounts. Active projects come first, newest first;
 * the id is the final tiebreak so two rows created in the same millisecond
 * still have a stable order.
 */
export async function listProjects(
  db: Db,
  opts: { includeArchived?: boolean } = {}
): Promise<Project[]> {
  const where = opts.includeArchived ? '' : "WHERE status = 'active'";
  const rows = await db.all<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM project ${where}
     ORDER BY CASE WHEN status = 'archived' THEN 1 ELSE 0 END, created_at DESC, id`
  );
  return rows.map(toProject);
}

/**
 * Changes one project's display name. Status, money, dates and every
 * transaction stay untouched. Applying createProject's trim/blank rules keeps
 * a rename from producing a name a create would have refused.
 */
export async function renameProject(db: Db, id: string, name: string): Promise<void> {
  const trimmed = normalizeName(name);
  await getProject(db, id); // existence check before the UPDATE
  await db.run('UPDATE project SET name = ? WHERE id = ?', [trimmed, id]);
}

/**
 * Sets or clears a project's spending cap.
 *
 * The cap only ever feeds a comparison against the derived total: it lives in
 * project.budget_cents and gates no write, so changing it cannot move money.
 * null means "no cap" and is the only way to remove one. The validation is
 * createProject's exactly, so an edit cannot store a budget a create would
 * have refused. Rename and budget are separate calls because they touch
 * separate columns; a screen that changes both simply makes both calls.
 */
export async function setProjectBudget(
  db: Db,
  id: string,
  budgetCents: number | null
): Promise<void> {
  if (budgetCents !== null) {
    assertIntegerCents(budgetCents);
  }
  await getProject(db, id); // existence check before the UPDATE
  await db.run('UPDATE project SET budget_cents = ? WHERE id = ?', [budgetCents, id]);
}

/**
 * Closes a project. Only status and archived_date change: every
 * txn.project_id stays, so the trip total, its category mix and its recent
 * rows remain readable after the archive. One statement, no transaction;
 * COALESCE keeps the first archive timestamp so a second call is a no-op.
 */
export async function archiveProject(db: Db, id: string): Promise<void> {
  await db.run(
    `UPDATE project SET status = 'archived', archived_date = COALESCE(archived_date, ?)
     WHERE id = ?`,
    [new Date().toISOString(), id]
  );
}

/** Undo for archiveProject: live again, with the same id and the same rows. */
export async function unarchiveProject(db: Db, id: string): Promise<void> {
  await db.run("UPDATE project SET status = 'active', archived_date = NULL WHERE id = ?", [id]);
}

/**
 * Deletes a project that no transaction has ever pointed at, and refuses
 * otherwise.
 *
 * The rule, pinned by tests: a project is deletable only when ZERO txn rows
 * reference it — soft-deleted rows included. A soft-deleted row still stores
 * project_id and still travels through backups, so deleting its project would
 * leave a dangling id; the owner's history is worth more than tidiness. A
 * project with rows may be archived instead, which is the normal end of a trip.
 *
 * Deleting is physical, not a status='archived' tombstone: v3's data
 * dictionary has no deleted_at column, and faking one would make 删除 and 归档
 * the same action while leaving an unreferenced row in the archived list
 * forever. Nothing references the row, so nothing is lost.
 *
 * The count and the DELETE share one transaction so the rule cannot be
 * evaluated against a state the DELETE no longer sees.
 */
export async function deleteProject(db: Db, id: string): Promise<void> {
  await db.transaction(async tx => {
    const project = await tx.get<{ name: string }>('SELECT name FROM project WHERE id = ?', [
      id,
    ]);
    if (project === undefined) {
      throw new Error(`项目不存在：${id}`);
    }

    const row = await tx.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM txn WHERE project_id = ?',
      [id]
    );
    const n = row?.n ?? 0;
    if (n > 0) {
      throw new Error(`项目「${project.name}」还有 ${n} 笔流水，不能删除；可以先归档`);
    }

    await tx.run('DELETE FROM project WHERE id = ?', [id]);
  });
}

/**
 * Points one live transaction at a project, or clears the pointer.
 *
 * Clearing is always allowed — including from an archived project — because
 * that is the only way to move a row out of a finished trip. Assigning an
 * archived project is refused, since a picker only lists live projects; the
 * one exception is re-saving the project the row already carries, which is not
 * a new assignment and would otherwise break the edit screen's plain save.
 *
 * The transaction must exist and be live: a soft-deleted row is history, and
 * editing its project would rewrite what the trip cost. The project is checked
 * here because txn.project_id has no foreign key. No transaction is opened:
 * the driver's transactions are not re-entrant and this is one UPDATE.
 */
export async function setTxnProject(
  db: Db,
  txnId: string,
  projectId: string | null
): Promise<void> {
  const txn = await db.get<{ project_id: string | null }>(
    'SELECT project_id FROM txn WHERE id = ? AND deleted_at IS NULL',
    [txnId]
  );
  if (txn === undefined) {
    throw new Error(`流水不存在或已删除：${txnId}`);
  }

  if (projectId === null) {
    await db.run('UPDATE txn SET project_id = NULL WHERE id = ?', [txnId]);
    return;
  }

  const project = await db.get<{ name: string; status: ProjectStatus }>(
    'SELECT name, status FROM project WHERE id = ?',
    [projectId]
  );
  if (project === undefined) {
    throw new Error(`项目不存在：${projectId}`);
  }
  if (project.status === 'archived' && txn.project_id !== projectId) {
    throw new Error(`项目「${project.name}」已归档，不能再挂到别的流水上`);
  }

  await db.run('UPDATE txn SET project_id = ? WHERE id = ?', [projectId, txnId]);
}

/** What the project list shows per row; money is always derived. */
export interface ProjectTotal {
  id: string;
  name: string;
  status: ProjectStatus;
  /** Every live transaction assigned to the project, whatever its direction. */
  txnCount: number;
  /** Positive integer cents: the sum of the live expense rows only. */
  totalCents: number;
}

/**
 * Per-project rows for the settings list, archived projects included so a
 * finished trip can still answer 一共花了多少.
 *
 * totalCents is SUM(-amount_cents) over live expense rows and nothing else:
 * an income row (a reimbursement, say) is not a cost of the trip, and a
 * transfer or adjustment never was spending. That is the same rule
 * categoryShares uses, which is why projectDetail's byCategory adds up to this
 * number exactly. txnCount, by contrast, counts every live assigned row, the
 * way tagUsage counts every live tagged row; the two numbers answer different
 * questions and are deliberately not forced to agree.
 */
export async function projectTotals(db: Db): Promise<ProjectTotal[]> {
  const rows = await db.all<{
    id: string;
    name: string;
    status: ProjectStatus;
    txn_count: number;
    total_cents: number;
  }>(
    `SELECT p.id AS id, p.name AS name, p.status AS status,
            COUNT(t.id) AS txn_count,
            COALESCE(SUM(CASE WHEN t.direction = 'expense' THEN -t.amount_cents ELSE 0 END), 0)
              AS total_cents
     FROM project p
     LEFT JOIN txn t ON t.project_id = p.id AND t.deleted_at IS NULL
     GROUP BY p.id, p.name, p.status, p.created_at
     ORDER BY CASE WHEN p.status = 'archived' THEN 1 ELSE 0 END, p.created_at DESC, p.id`
  );

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    status: row.status,
    txnCount: row.txn_count,
    totalCents: row.total_cents,
  }));
}

/** Default number of 最近几笔 on the project detail screen. */
export const PROJECT_RECENT_TXN_LIMIT = 5;

/** Everything the detail screen renders, all of it derived from txn. */
export interface ProjectDetail {
  project: Project;
  totalCents: number;
  /** Expense totals per category, in categoryShares' exact shape. */
  byCategory: CategoryShare[];
  /** Newest live rows, capped by recentLimit. */
  recentTxns: TxnRow[];
}

const SHARES_BY_PROJECT = `SELECT t.category_id AS category_id, c.name AS name,
        SUM(-t.amount_cents) AS cents
 FROM txn t
 LEFT JOIN category c ON c.id = t.category_id
 WHERE t.deleted_at IS NULL AND t.direction = 'expense' AND t.project_id = ?
 GROUP BY t.category_id
 ORDER BY cents DESC`;

/**
 * One project with its total, its category mix and its newest rows.
 *
 * The total comes from projectTotals on purpose: the list and the detail must
 * never answer 一共花了多少 differently. An archived project is still fully
 * readable — that is the point of archiving rather than deleting. An unknown
 * id is an error, like accountBalance's, because the caller is addressing one
 * project and a silent empty shape would hide the typo.
 *
 * recentLimit is validated here rather than in SQL, where LIMIT 0 would
 * quietly return nothing: a screen that asks for zero rows is a bug.
 */
export async function projectDetail(
  db: Db,
  id: string,
  opts: { recentLimit?: number } = {}
): Promise<ProjectDetail> {
  const recentLimit = opts.recentLimit ?? PROJECT_RECENT_TXN_LIMIT;
  if (!Number.isSafeInteger(recentLimit) || recentLimit <= 0) {
    throw new RangeError(
      `recentLimit must be a positive integer, received ${recentLimit}`
    );
  }

  const project = await getProject(db, id);
  const totals = await projectTotals(db);
  const total = totals.find(candidate => candidate.id === id);
  if (total === undefined) {
    // projectTotals reads the same table, so this is unreachable; the type
    // guard keeps the return type honest instead of asserting with !.
    throw new Error(`项目不存在：${id}`);
  }

  const shareRows = await db.all<{
    category_id: string | null;
    name: string | null;
    cents: number;
  }>(SHARES_BY_PROJECT, [id]);

  return {
    project,
    totalCents: total.totalCents,
    byCategory: mergeCategoryShares(shareRows),
    recentTxns: await listTxnsByProject(db, id, recentLimit),
  };
}
