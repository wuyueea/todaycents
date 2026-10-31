import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/driver';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';
import { createAccount } from '../../src/db/repos/accounts';
import { createCategory } from '../../src/db/repos/categories';
import { createExpense, createIncome, softDeleteTxn } from '../../src/db/repos/txns';
import { createTransfer } from '../../src/db/repos/transfers';
import { createProject, setTxnProject } from '../../src/db/repos/projects';
import {
  buildBackup,
  parseBackup,
  restoreBackup,
  serializeBackup,
  type BackupFile,
} from '../../src/db/backup';

/** The nine tables of this slice, in foreign-key order. */
const TABLES = [
  'account',
  'category',
  'tag',
  'project',
  'recurring_hint',
  'template',
  'txn',
  'txn_tag',
  'app_meta',
] as const;

/** Every row of every table, in insertion order; rowid survives a no-op restore. */
async function snapshot(db: Db): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    result[table] = await db.all<unknown>(`SELECT * FROM ${table} ORDER BY rowid`);
  }
  return result;
}

async function tableCounts(db: Db): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of TABLES) {
    const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    result[table] = row?.n ?? 0;
  }
  return result;
}

/**
 * A database with something in every table, including a child category, a
 * transfer pair, a soft-deleted row, a project_id and non-null optional
 * columns, so the round trip is not just the empty/default shape.
 */
async function seedRichLedger(db: Db): Promise<{ expenseId: string }> {
  await seedDefaults(db);

  // 饭卡 is no longer a starter account; this fixture wants a prepaid card
  // with non-default values, so it creates one instead of relying on the seed.
  const accountId = await createAccount(db, {
    name: '饭卡',
    type: 'prepaid',
    monthlyBudgetCents: 75000,
  });
  const target = await db.get<{ id: string }>("SELECT id FROM account WHERE name = '银行卡'");
  const category = await db.get<{ id: string }>("SELECT id FROM category WHERE name = '饮食'");
  if (target === undefined || category === undefined) {
    throw new Error('seed fixture is incomplete');
  }

  // A second level exercises the category table's self-referencing foreign key.
  const child = await createCategory(db, {
    name: '早餐',
    kind: 'expense',
    parentId: category.id,
  });

  const expenseId = await createExpense(db, {
    date: '2026-10-20',
    accountId,
    amountCents: 1250,
    categoryId: child,
    note: '早饭',
  });
  await createIncome(db, {
    date: '2026-10-21',
    accountId: target.id,
    amountCents: 300000,
    categoryId: null,
    note: '生活费',
  });
  await createTransfer(db, {
    date: '2026-10-22',
    fromAccountId: target.id,
    toAccountId: accountId,
    amountCents: 50000,
    note: '充饭卡',
  });
  const deleted = await createExpense(db, {
    date: '2026-10-23',
    accountId,
    amountCents: 800,
    categoryId: null,
    note: '已删',
  });
  await softDeleteTxn(db, deleted);

  // A project and the row that points at it: both sides of the new relation
  // must survive the codec, not just the txn column.
  const projectId = await createProject(db, {
    name: '国庆去成都',
    budgetCents: 200000,
    startedDate: '2026-10-01',
  });
  await setTxnProject(db, expenseId, projectId);
  // payee has no repository writer yet, but it is a txn column; the codec must
  // carry it.
  await db.run('UPDATE txn SET payee = ?, is_fixed_cost = 1 WHERE id = ?', ['食堂', expenseId]);
  await db.run('INSERT INTO tag (id, name, color, archived_at) VALUES (?, ?, ?, ?)', [
    'tag-1',
    '夜宵',
    '#8C5A2E',
    null,
  ]);
  await db.run('INSERT INTO txn_tag (txn_id, tag_id) VALUES (?, ?)', [expenseId, 'tag-1']);
  await db.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', [
    'last_backup_at',
    '2026-10-23T12:00:00+08:00',
  ]);
  await db.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', ['备注', '含中文与 emoji 🧾']);

  return { expenseId };
}

describe('backup codec', () => {
  it('round-trips the whole database through serialize and parse', async () => {
    const db = await createTestDb();
    const { expenseId } = await seedRichLedger(db);
    const before = await snapshot(db);

    const file = await buildBackup(db);

    expect(file.magic).toBe('ledger-backup');
    expect(file.formatVersion).toBe(1);
    expect(file.schemaVersion).toBe(4);
    expect(file.exportedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/
    );
    expect(Object.keys(file.counts)).toEqual([...TABLES]);
    // Money is copied as integer cents; nothing is formatted or converted.
    expect(file.tables.txn.find(row => row.id === expenseId)?.amount_cents).toBe(-1250);

    const parsed = parseBackup(serializeBackup(file));
    await restoreBackup(db, parsed);

    expect(await snapshot(db)).toEqual(before);
    expect(await tableCounts(db)).toEqual(file.counts);
  });

  it('replaces every table instead of merging the file into the current data', async () => {
    const target = await createTestDb();
    await seedDefaults(target);
    expect((await tableCounts(target)).account).toBe(3);

    const source = await createTestDb();
    const onlyAccount = await createAccount(source, { name: '只有B', type: 'cash' });
    await createExpense(source, {
      date: '2026-10-01',
      accountId: onlyAccount,
      amountCents: 999,
      categoryId: null,
    });
    const file = await buildBackup(source);

    await restoreBackup(target, file);

    expect(await tableCounts(target)).toEqual({
      account: 1,
      // Every migrated database carries the system 未分类 row, and the source
      // database's backup carries it like any other category row.
      category: 1,
      tag: 0,
      project: 0,
      recurring_hint: 0,
      template: 0,
      txn: 1,
      txn_tag: 0,
      app_meta: 0,
    });
    expect((await target.all<{ name: string }>('SELECT name FROM account')).map(r => r.name)).toEqual([
      '只有B',
    ]);
  });

  it('rejects corrupt files and leaves the database untouched', async () => {
    const db = await createTestDb();
    await seedRichLedger(db);
    const before = await tableCounts(db);
    const good = await buildBackup(db);

    const badMagic = JSON.parse(serializeBackup(good));
    badMagic.magic = 'other-app';
    expect(() => parseBackup(JSON.stringify(badMagic))).toThrow(/magic/);

    const badFormat = JSON.parse(serializeBackup(good));
    badFormat.formatVersion = 2;
    expect(() => parseBackup(JSON.stringify(badFormat))).toThrow(/格式版本/);

    const missingTable = JSON.parse(serializeBackup(good));
    delete missingTable.tables.txn;
    expect(() => parseBackup(JSON.stringify(missingTable))).toThrow(/缺少数据表.*txn/);

    // Malformed text: JSON.parse itself never reaches any database work.
    expect(() => parseBackup('{"magic": "ledger-backup",')).toThrow(/JSON/);

    const badRow = JSON.parse(serializeBackup(good));
    badRow.tables.account[0] = 'not-a-row';
    expect(() => parseBackup(JSON.stringify(badRow))).toThrow(/account.*第 1 行/);

    const badCell = JSON.parse(serializeBackup(good));
    badCell.tables.txn[0].amount_cents = 12.5;
    expect(() => parseBackup(JSON.stringify(badCell))).toThrow(/amount_cents/);

    // SQLite's dynamic typing would accept "1250" in an INTEGER column; the
    // codec rejects it so money can never change shape on the way in.
    const stringMoney = JSON.parse(serializeBackup(good));
    stringMoney.tables.txn[0].amount_cents = '1250';
    expect(() => parseBackup(JSON.stringify(stringMoney))).toThrow(/amount_cents/);

    const textAsNumber = JSON.parse(serializeBackup(good));
    textAsNumber.tables.account[0].name = 42;
    expect(() => parseBackup(JSON.stringify(textAsNumber))).toThrow(/name/);

    const future = JSON.parse(serializeBackup(good)) as BackupFile;
    future.schemaVersion = 99;
    const error = await restoreBackup(db, future).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('BackupSchemaTooNewError');
    expect((error as Error).message).toMatch(/升级 App/);

    expect(await tableCounts(db)).toEqual(before);
  });

  it('rolls the whole import back when a table count disagrees with counts', async () => {
    const db = await createTestDb();
    await seedRichLedger(db);
    const before = await snapshot(db);
    const file = await buildBackup(db);
    file.counts.txn += 1;

    await expect(restoreBackup(db, file)).rejects.toThrow(/txn 表行数/);

    expect(await snapshot(db)).toEqual(before);
  });

  it('rolls back when a row passes the shape check but violates a foreign key', async () => {
    const db = await createTestDb();
    await seedRichLedger(db);
    const before = await snapshot(db);
    const file = await buildBackup(db);
    file.tables.txn[0].account_id = 'missing-account';

    await expect(restoreBackup(db, file)).rejects.toThrow(/txn 表第 1 行无法写入/);

    expect(await snapshot(db)).toEqual(before);
  });

  it('refuses to export a numeric column that the database stored as text', async () => {
    const db = await createTestDb();
    await seedRichLedger(db);
    // SQLite only converts a string to INTEGER when the conversion is
    // lossless; "oops" stays TEXT and must not become a backup.
    await db.run('UPDATE txn SET amount_cents = ? WHERE id = (SELECT id FROM txn LIMIT 1)', [
      'oops',
    ]);

    await expect(buildBackup(db)).rejects.toThrow(/amount_cents/);
  });

  it('re-checks column kinds when restore is called without parseBackup', async () => {
    const db = await createTestDb();
    await seedRichLedger(db);
    const before = await snapshot(db);
    const file = await buildBackup(db);
    // A typed BackupFile can still be hand-built; the database boundary must
    // not trust it just because this caller skipped parseBackup.
    file.tables.txn[0].amount_cents = '1250';

    await expect(restoreBackup(db, file)).rejects.toThrow(/txn 表第 1 行无法写入/);

    expect(await snapshot(db)).toEqual(before);
  });

  it('always exports all nine tables, even empty ones, and no out-of-scope table', async () => {
    const db = await createTestDb();
    const file = await buildBackup(db);

    expect(Object.keys(file.tables)).toEqual([...TABLES]);
    for (const table of TABLES) {
      if (table === 'category') continue;
      expect(file.tables[table]).toEqual([]);
      expect(file.counts[table]).toBe(0);
    }
    // The one row every migrated database owns, exported like any other.
    expect(file.tables.category).toEqual([
      {
        id: 'uncategorized',
        parent_id: null,
        name: '未分类',
        kind: 'expense',
        sort: 9999,
        archived_at: null,
      },
    ]);
    expect(file.counts.category).toBe(1);
    expect(file.tables).not.toHaveProperty('import_batch');

    const text = serializeBackup(file);
    expect(text.startsWith('{\n  "magic": "ledger-backup"')).toBe(true);
    expect(JSON.parse(text)).toEqual(file);
  });

  it('serializes with a stable key order regardless of object insertion order', async () => {
    const db = await createTestDb();
    await seedRichLedger(db);
    const file = await buildBackup(db);
    const text = serializeBackup(file);

    const reversed = {
      tables: Object.fromEntries(
        Object.entries(file.tables)
          .reverse()
          .map(([table, rows]) => [
            table,
            rows.map(row => Object.fromEntries(Object.entries(row).reverse())),
          ])
      ),
      counts: Object.fromEntries(Object.entries(file.counts).reverse()),
      exportedAt: file.exportedAt,
      schemaVersion: file.schemaVersion,
      formatVersion: file.formatVersion,
      magic: file.magic,
    } as unknown as BackupFile;

    expect(serializeBackup(reversed)).toBe(text);
  });

  // category.parent_id points back at category: a dump that listed a child
  // before its parent would fail to restore with foreign keys on.
  it('dumps categories parents-first so the file can be restored in order', async () => {
    const db = await createTestDb();
    await seedRichLedger(db);
    const file = await buildBackup(db);

    const names = (file.tables.category ?? []).map(row => String(row.name));
    expect(names.indexOf('饮食')).toBeLessThan(names.indexOf('早餐'));

    const target = await createTestDb();
    await restoreBackup(target, file);
    const restored = await target.all<{ id: string; name: string; parent_id: string | null }>(
      'SELECT id, name, parent_id FROM category'
    );
    const food = restored.find(row => row.name === '饮食');
    const breakfast = restored.find(row => row.name === '早餐');
    expect(food).toBeDefined();
    expect(breakfast?.parent_id).toBe(food?.id);
  });

  // A file written before migration v2 has no system 未分类 row. Restoring it
  // must leave the database able to reflow a deleted category's transactions.
  it('restores the system 未分类 row even when the file predates it', async () => {
    const db = await createTestDb();
    await seedRichLedger(db);
    const file = await buildBackup(db);

    const withoutSystem = {
      ...file,
      tables: {
        ...file.tables,
        category: (file.tables.category ?? []).filter(row => row.id !== 'uncategorized'),
      },
      counts: { ...file.counts, category: file.counts.category - 1 },
    };

    const target = await createTestDb();
    await restoreBackup(target, withoutSystem);

    const system = await target.get<{ id: string }>(
      "SELECT id FROM category WHERE id = 'uncategorized'"
    );
    expect(system?.id).toBe('uncategorized');
  });

  it('allows a file whose schemaVersion is lower than the database', async () => {
    const source = await createTestDb();
    await seedDefaults(source);
    const file = await buildBackup(source);

    const target = await createTestDb();
    await restoreBackup(target, { ...file, schemaVersion: 0 });

    expect(await tableCounts(target)).toEqual(file.counts);
  });
});

// The project table arrived in schema v3. The backup format is still v1, so
// the file must be readable in both directions: a new file carries projects,
// and an old file without the key imports as zero rows instead of failing.
describe('backup compatibility: project', () => {
  it('round-trips projects and the rows that point at them into another database', async () => {
    const source = await createTestDb();
    const { expenseId } = await seedRichLedger(source);
    const file = await buildBackup(source);

    expect(file.counts.project).toBe(1);
    const exported = file.tables.project[0];
    expect(exported).toMatchObject({
      name: '国庆去成都',
      status: 'active',
      budget_cents: 200000,
      started_date: '2026-10-01',
      archived_date: null,
    });
    expect(file.tables.txn.find(row => row.id === expenseId)?.project_id).toBe(exported.id);
    // project is inserted before txn, the order the restore relies on.
    expect(Object.keys(file.tables)).toEqual([...TABLES]);
    expect(Object.keys(file.counts)).toEqual([...TABLES]);
    expect(Object.keys(file.tables).indexOf('project')).toBeLessThan(
      Object.keys(file.tables).indexOf('txn')
    );

    const target = await createTestDb();
    await restoreBackup(target, parseBackup(serializeBackup(file)));

    expect(await target.all('SELECT * FROM project')).toEqual(file.tables.project);
    const restoredTxn = await target.get<{ project_id: string | null }>(
      'SELECT project_id FROM txn WHERE id = ?',
      [expenseId]
    );
    expect(restoredTxn?.project_id).toBe(exported.id);
  });

  it('imports a file written before the project table as zero projects', async () => {
    const source = await createTestDb();
    const { expenseId } = await seedRichLedger(source);
    const file = await buildBackup(source);
    const projectId = file.tables.txn.find(row => row.id === expenseId)?.project_id;

    // What the previous release wrote: no project key in counts or tables, a
    // schemaVersion of 2, and a project_id column that already existed.
    const raw = JSON.parse(serializeBackup(file)) as {
      schemaVersion: number;
      counts: Record<string, number>;
      tables: Record<string, unknown[]>;
    };
    delete raw.counts.project;
    delete raw.tables.project;
    raw.schemaVersion = 2;

    const parsed = parseBackup(JSON.stringify(raw));
    expect(parsed.counts.project).toBe(0);
    expect(parsed.tables.project).toEqual([]);

    const target = await createTestDb();
    await restoreBackup(target, parsed);

    expect(await target.get<{ n: number }>('SELECT COUNT(*) AS n FROM project')).toEqual({ n: 0 });
    // No foreign key means the old file's project_id is still restorable
    // verbatim; inventing a project row or dropping the id would both lie.
    const restoredTxn = await target.get<{ project_id: string | null }>(
      'SELECT project_id FROM txn WHERE id = ?',
      [expenseId]
    );
    expect(restoredTxn?.project_id).toBe(projectId);
  });
});

// A dismissal is a decision the owner made; losing it on restore would make the
// app ask the same question again. That is why recurring_hint is in the file.
describe('backup compatibility: recurring_hint', () => {
  it('carries a dismissed candidate across a restore', async () => {
    const source = await createTestDb();
    await seedRichLedger(source);
    const card = await source.get<{ id: string }>("SELECT id FROM account WHERE name = '饭卡'");
    // A real category: the detector deliberately never guesses on 未分类.
    const food = await source.get<{ id: string }>("SELECT id FROM category WHERE name = '饮食'");
    if (card === null || card === undefined || food === null || food === undefined) {
      throw new Error('fixture is incomplete');
    }
    const bill = async (date: string) => {
      await createExpense(source, {
        date,
        accountId: card.id,
        amountCents: 5988,
        categoryId: food.id,
      });
    };
    for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) await bill(date);

    const { detectCandidates, dismissCandidate, listCandidates } = await import(
      '../../src/db/repos/fixedCosts'
    );
    const [candidate] = await detectCandidates(source);
    await dismissCandidate(source, candidate.id);
    expect(await listCandidates(source)).toEqual([]);

    const file = await buildBackup(source);
    const target = await createTestDb();
    await restoreBackup(target, file);

    expect(await listCandidates(target)).toEqual([]);
  });
});
