import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import { migrate } from '../../src/db/migrate';
import { MIGRATIONS } from '../../src/db/schema';
import { seedDefaults } from '../../src/db/seed';
import { listCategories } from '../../src/db/repos/categories';

describe('migrate', () => {
  it('creates all v1 tables', async () => {
    const db = await createTestDb();
    const rows = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const names = rows.map(r => r.name);
    for (const t of ['account','category','tag','txn','txn_tag','template','app_meta']) {
      expect(names).toContain(t);
    }
  });
  it('records the latest schema version once', async () => {
    const db = await createTestDb();
    const row = await db.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations');
    expect(row?.version).toBe(4);
  });
  // Not in the brief's code block: the brief's DDL also requires these indexes.
  it('creates the v1 txn indexes', async () => {
    const db = await createTestDb();
    const rows = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_txn_%' ORDER BY name"
    );
    expect(rows.map(r => r.name)).toEqual([
      'idx_txn_account',
      'idx_txn_date',
      'idx_txn_project',
      'idx_txn_transfer',
    ]);
  });
});

// Not in the brief's code block: these pin the task decisions.
describe('migrate idempotency', () => {
  it('leaves an already-migrated database unchanged', async () => {
    const db = await createTestDb();
    const listTables = () =>
      db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' OR type='index' ORDER BY name"
      );
    const before = await listTables();

    await migrate(db);
    await migrate(db);

    expect(await listTables()).toEqual(before);
    const versions = await db.all<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    expect(versions.map(r => r.version)).toEqual([1, 2, 3, 4]);
  });
});


// Migration v2 adds the one system category. It is a schema fact, not seed
// data: the seed's own guard has to ignore it or a fresh database would never
// receive its starter taxonomy.
describe('migration v2: system 未分类 category', () => {
  const SYSTEM_ID = 'uncategorized';

  it('exists exactly once on a fresh database with the fixed shape', async () => {
    const db = await createTestDb();
    const rows = await db.all<{
      id: string;
      parent_id: string | null;
      name: string;
      kind: string;
      archived_at: string | null;
    }>('SELECT id, parent_id, name, kind, archived_at FROM category WHERE id = ?', [SYSTEM_ID]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: SYSTEM_ID,
      parent_id: null,
      name: '未分类',
      kind: 'expense',
      archived_at: null,
    });
  });

  it('survives a second migrate and a repeat of the v2 statement itself', async () => {
    const db = await createTestDb();
    await migrate(db);

    // The row is already there even though the migration record is not: only
    // INSERT OR IGNORE lets the statement run without a UNIQUE failure or a
    // twin row. The statement is replayed directly so appending v3 and later
    // versions cannot stop this test from reaching it.
    const v2 = MIGRATIONS.find(migration => migration.version === 2);
    if (v2 === undefined) throw new Error('migration v2 is missing');
    await db.exec(v2.sql);
    await db.exec(v2.sql);

    const row = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM category WHERE id = ?',
      [SYSTEM_ID]
    );
    expect(row?.n).toBe(1);
  });

  it('adds it to an existing v1 database without disturbing existing rows', async () => {
    const db = await createTestDb();
    // Rewind to the v1 shape: no migration record, no project table and no
    // system row, but one user category already stored. This is what an app
    // upgrade from v1 sees.
    await db.run('DELETE FROM schema_migrations WHERE version >= 2');
    await db.run('DROP INDEX IF EXISTS idx_txn_project');
    await db.run('DROP TABLE IF EXISTS project');
    // Every table a later migration creates has to go too, or re-applying the
    // chain would trip over its own CREATE TABLE.
    await db.run('DROP TABLE IF EXISTS recurring_hint');
    await db.run('DELETE FROM category WHERE id = ?', [SYSTEM_ID]);
    await db.run(
      "INSERT INTO category (id, parent_id, name, kind, sort, archived_at) VALUES ('legacy-category', NULL, '旧分类', 'expense', 0, NULL)"
    );

    await migrate(db);

    const ids = await db.all<{ id: string }>('SELECT id FROM category ORDER BY id');
    expect(ids.map(row => row.id)).toEqual(['legacy-category', SYSTEM_ID]);
  });

  it('sorts after every seeded category', async () => {
    const db = await createTestDb();
    await seedDefaults(db);

    const expense = await listCategories(db, 'expense');
    expect(expense.filter(category => category.id === SYSTEM_ID)).toHaveLength(1);
    expect(expense.at(-1)).toMatchObject({ id: SYSTEM_ID, name: '未分类' });
  });

  it('does not suppress the seed on a fresh database', async () => {
    const db = await createTestDb();
    await seedDefaults(db);

    const names = (await listCategories(db)).map(category => category.name);
    expect(names).toEqual(
      expect.arrayContaining(['饮食', '日用', '交通', '生活费', '奖金', '报销'])
    );
    expect(await db.all('SELECT id FROM account')).toHaveLength(3);
    expect(await db.all('SELECT id FROM template')).toHaveLength(0);
  });
});

describe('transaction', () => {
  it('commits when the callback resolves', async () => {
    const db = await createTestDb();
    await db.transaction(async () => {
      await db.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', ['k', 'v']);
    });

    const row = await db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', ['k']);
    expect(row?.value).toBe('v');
  });

  it('rolls back and rethrows when the callback rejects', async () => {
    const db = await createTestDb();
    const boom = new Error('boom');

    await expect(
      db.transaction(async tx => {
        await tx.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', ['k', 'v']);
        throw boom;
      })
    ).rejects.toBe(boom);

    const row = await db.get('SELECT * FROM app_meta WHERE key = ?', ['k']);
    expect(row).toBeUndefined();
  });
});

// Migration v3 adds the project table. It is additive on purpose: no existing
// table is rebuilt, so it applies on Android as a plain CREATE TABLE.
describe('migration v3: project', () => {
  it('creates the project table with the data dictionary columns', async () => {
    const db = await createTestDb();
    const columns = await db.all<{ name: string; type: string; notnull: number }>(
      'PRAGMA table_info(project)'
    );

    expect(columns.map(column => column.name)).toEqual([
      'id',
      'name',
      'status',
      'budget_cents',
      'started_date',
      'archived_date',
      'created_at',
    ]);
    expect(columns.find(column => column.name === 'name')?.notnull).toBe(1);
    expect(columns.find(column => column.name === 'created_at')?.notnull).toBe(1);

    // Only the three required columns: everything else must default to empty.
    await db.run(
      "INSERT INTO project (id, name, created_at) VALUES ('p1', '国庆去成都', '2026-10-24T00:00:00.000Z')"
    );
    const row = await db.get(
      'SELECT status, budget_cents, started_date, archived_date FROM project WHERE id = ?',
      ['p1']
    );
    expect(row).toEqual({
      status: 'active',
      budget_cents: null,
      started_date: null,
      archived_date: null,
    });
  });

  it('only accepts active or archived as a status', async () => {
    const db = await createTestDb();
    await expect(
      db.run(
        "INSERT INTO project (id, name, status, created_at) VALUES ('p2', '坏状态', 'deleted', '2026-10-24T00:00:00.000Z')"
      )
    ).rejects.toThrow();
  });

  it('indexes live project lookups without touching the txn table', async () => {
    const db = await createTestDb();
    const row = await db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name = 'idx_txn_project'"
    );
    expect(row?.sql).toMatch(/ON txn\(project_id\).*WHERE deleted_at IS NULL/i);

    const columns = await db.all<{ name: string }>('PRAGMA table_info(txn)');
    expect(columns.map(column => column.name)).toContain('project_id');
  });

  // SQLite cannot attach a foreign key without rebuilding txn, and the txn
  // table already ships on devices. The repository guards project_id instead.
  it('leaves txn.project_id without a foreign key', async () => {
    const db = await createTestDb();
    const keys = await db.all<{ from: string }>('PRAGMA foreign_key_list(txn)');
    expect(keys.map(key => key.from).sort()).toEqual(['account_id', 'category_id']);
    expect(keys.some(key => key.from === 'project_id')).toBe(false);
  });

  it('adds project to an existing v2 database without disturbing its rows', async () => {
    const db = await createTestDb();
    // Rewind to v2: no migration record, index or table, but one category and
    // one account already stored. This is what an app upgrade actually sees.
    // Rewind the record to v2 and drop every table a later migration adds;
    // a rewind that leaves the head version behind replays nothing.
    await db.run('DELETE FROM schema_migrations WHERE version >= 3');
    await db.run('DROP INDEX idx_txn_project');
    await db.run('DROP TABLE project');
    await db.run('DROP TABLE IF EXISTS recurring_hint');
    await db.run(
      "INSERT INTO category (id, parent_id, name, kind, sort, archived_at) VALUES ('legacy-category', NULL, '旧分类', 'expense', 0, NULL)"
    );

    await migrate(db);

    const table = await db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'project'"
    );
    expect(table?.name).toBe('project');
    const category = await db.get<{ name: string }>(
      "SELECT name FROM category WHERE id = 'legacy-category'"
    );
    expect(category?.name).toBe('旧分类');
    const version = await db.get<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations'
    );
    // The upgrade runs every pending migration, so v3 brings the database all
    // the way to the current head, not to 3.
    expect(version?.version).toBe(4);
  });
});

// Migration v4 adds recurring_hint: what the detector noticed and what the
// owner decided about it. It stores a snapshot for the prompt (name, amount,
// last and next date) and moves no money; the flag that puts a row in the
// list stays on txn.is_fixed_cost.
describe('migration v4: recurring_hint', () => {
  it('creates the table with the data dictionary columns', async () => {
    const db = await createTestDb();
    const columns = await db.all<{ name: string; notnull: number }>(
      'PRAGMA table_info(recurring_hint)'
    );

    expect(columns.map(column => column.name)).toEqual([
      'id',
      'category_id',
      'payee',
      'status',
      'monthly_cents',
      'last_date',
      'next_date',
      'occurrences',
      'detected_at',
    ]);
    // Only the two identifying columns a prompt may legitimately miss are
    // nullable; the rest of the row is the snapshot and must be complete.
    // SQLite does not add NOT NULL to a TEXT PRIMARY KEY on its own, so id
    // shows up here too — the three NOT NULL money/date/count columns do not.
    expect(columns.filter(column => column.notnull === 0).map(column => column.name)).toEqual([
      'id',
      'category_id',
      'payee',
    ]);
    for (const name of ['monthly_cents', 'last_date', 'next_date', 'occurrences', 'detected_at']) {
      expect(columns.find(column => column.name === name)?.notnull).toBe(1);
    }
  });

  it('only accepts candidate, confirmed and dismissed as a status', async () => {
    const db = await createTestDb();
    const insert = (id: string, status: string) =>
      db.run(
        `INSERT INTO recurring_hint
           (id, category_id, payee, status, monthly_cents, last_date, next_date, occurrences, detected_at)
         VALUES (?, NULL, NULL, ?, 5900, '2026-10-01', '2026-11-01', 5, '2026-10-24T00:00:00.000Z')`,
        [id, status]
      );

    for (const status of ['candidate', 'confirmed', 'dismissed']) {
      await expect(insert(`ok-${status}`, status)).resolves.toBeUndefined();
    }
    await expect(insert('bad-pending', 'pending')).rejects.toThrow();
    await expect(insert('bad-empty', '')).rejects.toThrow();
  });

  it('keeps the category reference loose so a decision outlives its category', async () => {
    const db = await createTestDb();
    // Deleting a category reflows its transactions to 未分类, and a dismissed
    // hint must survive that: if the row disappeared, deleting and re-creating
    // a category would ask the owner the same question twice. A foreign key
    // would either block the delete or cascade the decision away, so the
    // column is a plain id the repository may leave dangling.
    const keys = await db.all<{ from: string }>('PRAGMA foreign_key_list(recurring_hint)');
    expect(keys).toEqual([]);

    await db.run(
      `INSERT INTO recurring_hint
         (id, category_id, payee, status, monthly_cents, last_date, next_date, occurrences, detected_at)
       VALUES ('h1', 'gone-category', '话费', 'candidate', 5988, '2026-10-01', '2026-11-01', 5, '2026-10-24T00:00:00.000Z')`
    );
    expect(await db.get('SELECT * FROM recurring_hint WHERE id = ?', ['h1'])).toEqual({
      id: 'h1',
      category_id: 'gone-category',
      payee: '话费',
      status: 'candidate',
      monthly_cents: 5988,
      last_date: '2026-10-01',
      next_date: '2026-11-01',
      occurrences: 5,
      detected_at: '2026-10-24T00:00:00.000Z',
    });
  });

  it('adds the table to an existing v3 database without disturbing its rows', async () => {
    const db = await createTestDb();
    await db.run(
      `INSERT INTO account (id, name, type, initial_balance_cents, sort, created_at)
       VALUES ('a-legacy', '旧卡', 'cash', 0, 0, '2026-10-01T00:00:00.000Z')`
    );
    await db.run(
      `INSERT INTO txn (id, occurred_date, account_id, amount_cents, direction, note, created_at)
       VALUES ('t-legacy', '2026-09-01', 'a-legacy', -5900, 'expense', '', '2026-09-01T00:00:00.000Z')`
    );
    // Rewind to v3: drop the v4 table and its migration record only.
    await db.run('DELETE FROM schema_migrations WHERE version = 4');
    await db.run('DROP TABLE recurring_hint');

    await migrate(db);

    const table = await db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'recurring_hint'"
    );
    expect(table?.name).toBe('recurring_hint');
    const txn = await db.get<{ amount_cents: number }>(
      "SELECT amount_cents FROM txn WHERE id = 't-legacy'"
    );
    expect(txn?.amount_cents).toBe(-5900);
    const account = await db.get<{ name: string }>(
      "SELECT name FROM account WHERE id = 'a-legacy'"
    );
    expect(account?.name).toBe('旧卡');
    const version = await db.get<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations'
    );
    expect(version?.version).toBe(4);
  });
});
