/**
 * Ordered, append-only schema migrations. Never edit or reorder a version
 * that has shipped; add a new object with the next version instead.
 */

/**
 * The one category the app owns itself: v2 creates it, and deleting a user
 * category reflows its rows into it. A fixed id (not a UUID) keeps those rows
 * pointing at the same row across devices and backup files.
 *
 * Its sort sits far above every user category and createCategory's nextSort
 * skips it, so "排最后" holds both before and after later categories are
 * appended. These three values are part of the migration's history: changing
 * them would orphan rows in databases that already ran v2.
 */
export const UNCATEGORIZED_CATEGORY_ID = 'uncategorized';
export const UNCATEGORIZED_CATEGORY_NAME = '未分类';
export const UNCATEGORIZED_CATEGORY_SORT = 9999;

export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE account (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('cash','bank','ewallet','prepaid')),
  initial_balance_cents INTEGER NOT NULL DEFAULT 0,
  monthly_budget_cents INTEGER NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT NULL, created_at TEXT NOT NULL
);
CREATE TABLE category (
  id TEXT PRIMARY KEY, parent_id TEXT NULL REFERENCES category(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
  sort INTEGER NOT NULL DEFAULT 0, archived_at TEXT NULL
);
CREATE TABLE tag (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NULL, archived_at TEXT NULL);
CREATE TABLE txn (
  id TEXT PRIMARY KEY, occurred_date TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES account(id),
  amount_cents INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('expense','income','transfer','adjust')),
  category_id TEXT NULL REFERENCES category(id),
  project_id TEXT NULL, note TEXT NOT NULL DEFAULT '', payee TEXT NULL,
  slot_key TEXT NULL, is_fixed_cost INTEGER NOT NULL DEFAULT 0,
  transfer_group_id TEXT NULL, deleted_at TEXT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_txn_date ON txn(occurred_date);
CREATE INDEX idx_txn_account ON txn(account_id);
CREATE INDEX idx_txn_transfer ON txn(transfer_group_id);
CREATE TABLE txn_tag (
  txn_id TEXT NOT NULL REFERENCES txn(id),
  tag_id TEXT NOT NULL REFERENCES tag(id),
  PRIMARY KEY (txn_id, tag_id)
);
CREATE TABLE template (
  id TEXT PRIMARY KEY, slot_key TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
  category_id TEXT NULL REFERENCES category(id),
  default_account_id TEXT NULL REFERENCES account(id),
  default_amount_cents INTEGER NULL, sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
  },
  {
    // A row migration, not a DDL change: every database gains the system
    // category exactly once. INSERT OR IGNORE makes the statement itself
    // idempotent as well, so re-running it (a replayed migration record, an
    // imported backup pipeline) can never produce a twin row or fail.
    version: 2,
    sql: `
INSERT OR IGNORE INTO category (id, parent_id, name, kind, sort, archived_at)
VALUES ('${UNCATEGORIZED_CATEGORY_ID}', NULL, '${UNCATEGORIZED_CATEGORY_NAME}', 'expense', ${UNCATEGORIZED_CATEGORY_SORT}, NULL);
`,
  },
  {
    // A project groups one bounded stretch of spending (a trip, a move). It is
    // archived when it is over; only a project no txn row ever pointed at may
    // be physically deleted. Totals are derived from txn; no money is stored
    // here.
    //
    // txn.project_id deliberately has NO foreign key. SQLite cannot attach a
    // REFERENCES clause to an existing table: ALTER TABLE only adds columns,
    // so the only way is the twelve-step table rebuild, which would rewrite
    // the txn table on every Android device. It would also reject legitimate
    // old backup files, whose txn rows may carry a project_id but predate the
    // project table entirely. The repository enforces the reference instead
    // (setTxnProject checks existence, deleteProject refuses a used project),
    // and the partial index below serves the totals join, the detail listing
    // and every live project_id lookup.
    version: 3,
    sql: `
CREATE TABLE project (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  budget_cents INTEGER NULL, started_date TEXT NULL,
  archived_date TEXT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_txn_project ON txn(project_id) WHERE deleted_at IS NULL;
`,
  },
  {
    // A recurring hint is what the detector noticed about one repeating bill
    // and, after the owner answers, what they decided: still a candidate, in
    // the list, or never ask again. The row is a snapshot for the prompt —
    // the amount, the last bill and the clamped next date — not a schedule:
    // nothing here ever writes a transaction, and the row that actually puts
    // an item in the list is txn.is_fixed_cost.
    //
    // category_id has no foreign key on purpose. Deleting a category reflows
    // its transactions into 未分类, but a dismissal must survive that: if the
    // hint vanished with the category, deleting and re-creating a category
    // would ask the same question twice. It is a plain id the repository may
    // leave dangling, the same trade-off migration v3 made for txn.project_id.
    version: 4,
    sql: `
CREATE TABLE recurring_hint (
  id TEXT PRIMARY KEY, category_id TEXT NULL, payee TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('candidate','confirmed','dismissed')),
  monthly_cents INTEGER NOT NULL, last_date TEXT NOT NULL, next_date TEXT NOT NULL,
  occurrences INTEGER NOT NULL, detected_at TEXT NOT NULL
);
`,
  },
];
