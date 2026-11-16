import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import { buildBackup, parseBackup, restoreBackup, serializeBackup } from '../../src/db/backup';
import { createAccount, accountBalance } from '../../src/db/repos/accounts';
import {
  archiveCategory,
  createCategory,
  inspectCategoryPurge,
  purgeCategory,
} from '../../src/db/repos/categories';
import { createExpense } from '../../src/db/repos/txns';
import { resetLedger } from '../../src/db/reset';
import { migrate } from '../../src/db/migrate';
import { seedDefaults } from '../../src/db/seed';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

// Synthetic historical rows, not a supported template authoring API.
async function legacyFixture() {
  const db = await createTestDb();
  const account = await createAccount(db, {
    name: '合成旧账户', type: 'cash', initialBalanceCents: 10000,
  });
  const category = await createCategory(db, { name: '模板专用分类', kind: 'expense' });
  await db.run(
    `INSERT INTO template
      (id, slot_key, label, category_id, default_account_id, default_amount_cents, sort, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['legacy-inactive', 'lunch', '旧午餐', category, account, 1230, 7, 0]
  );
  await db.run(
    `INSERT INTO template
      (id, slot_key, label, category_id, default_account_id, default_amount_cents, sort, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['legacy-active', 'shower', '旧洗浴', null, null, null, 2, 1]
  );
  await createExpense(db, {
    date: '2000-01-02', accountId: account, amountCents: 1230,
    categoryId: null, slotKey: 'lunch',
  });
  return { db, account, category };
}

const migrations = (db: TestDb) => db.all('SELECT * FROM schema_migrations ORDER BY version');

describe('retired template data compatibility', () => {
  it('round-trips all legacy columns and replaces the target without changing schema 6', async () => {
    const { db: source, account } = await legacyFixture();
    const original = await buildBackup(source);
    expect(original.schemaVersion).toBe(6);
    expect(original.counts.template).toBe(2);

    const { db: target, account: replacedAccount } = await legacyFixture();
    const schemaBefore = await migrations(target);
    await restoreBackup(target, parseBackup(serializeBackup(original)));
    // Reopening an already-current database must not erase imported legacy rows.
    await migrate(target);
    await seedDefaults(target);
    const exported = await buildBackup(target);
    expect(exported.schemaVersion).toBe(6);
    expect(exported.counts).toEqual(original.counts);
    expect(exported.tables).toEqual(original.tables);
    expect(await migrations(target)).toEqual(schemaBefore);
    expect(await target.get('SELECT id FROM account WHERE id = ?', [replacedAccount])).toBeUndefined();
    expect(await accountBalance(target, account)).toBe(8770);
  });

  it('imports a synthetic v1-format file with nonempty templates and no later optional tables', async () => {
    const { db, account } = await legacyFixture();
    // This is a format fixture, not an archived file from a real installation.
    const raw = JSON.parse(serializeBackup(await buildBackup(db)));
    raw.schemaVersion = 1;
    for (const table of ['project', 'recurring_hint']) {
      delete raw.tables[table];
      delete raw.counts[table];
    }
    const target = await createTestDb();
    const schemaBefore = await migrations(target);
    await restoreBackup(target, parseBackup(JSON.stringify(raw)));
    const exported = await buildBackup(target);
    expect(exported.tables.template).toEqual(raw.tables.template);
    expect(exported.tables.txn).toEqual(raw.tables.txn);
    expect(exported.counts.template).toBe(2);
    expect(exported.schemaVersion).toBe(6);
    expect(await migrations(target)).toEqual(schemaBefore);
    expect(await accountBalance(target, account)).toBe(8770);
  });

  it('preserves a transaction slot_key even when no template matches it', async () => {
    const source = await createTestDb();
    const account = await createAccount(source, { name: '旧账户', type: 'cash' });
    await createExpense(source, {
      date: '2000-01-02', accountId: account, amountCents: 425,
      categoryId: null, slotKey: 'removed-slot',
    });
    const target = await createTestDb();
    await restoreBackup(target, parseBackup(serializeBackup(await buildBackup(source))));
    expect(await target.all('SELECT slot_key, amount_cents FROM txn')).toEqual([
      { slot_key: 'removed-slot', amount_cents: -425 },
    ]);
    expect((await buildBackup(target)).tables.template).toEqual([]);
    expect(await accountBalance(target, account)).toBe(-425);
  });

  it.each([0, 1])('a template-only reference with active=%i still blocks category purge', async active => {
    const { db, account, category } = await legacyFixture();
    await db.run('UPDATE template SET active = ? WHERE id = ?', [active, 'legacy-inactive']);
    await archiveCategory(db, category);
    const before = await buildBackup(db);
    expect(await inspectCategoryPurge(db, category)).toMatchObject({
      archived: true, templateCount: 1, txnCount: 0, purgeable: false,
    });
    await expect(purgeCategory(db, category)).rejects.toThrow(/历史/);
    expect((await buildBackup(db)).tables).toEqual(before.tables);
    expect(await accountBalance(db, account)).toBe(8770);
  });

  it('rejects a missing required template table or count in old and current files', async () => {
    const { db } = await legacyFixture();
    const backup = await buildBackup(db);
    for (const schemaVersion of [1, 6]) {
      for (const envelope of ['counts', 'tables']) {
        const raw = JSON.parse(serializeBackup(backup));
        raw.schemaVersion = schemaVersion;
        delete raw[envelope].template;
        expect(() => parseBackup(JSON.stringify(raw))).toThrow(/template/);
      }
    }
  });

  it('clears nonempty legacy templates only on explicit reset and keeps migration history', async () => {
    const { db } = await legacyFixture();
    const schemaBefore = await migrations(db);
    expect((await buildBackup(db)).counts.template).toBe(2);
    await resetLedger(db);
    const exported = await buildBackup(db);
    expect(exported.counts.template).toBe(0);
    expect(exported.tables.template).toEqual([]);
    expect(exported.tables.txn).toEqual([]);
    expect(exported.tables.account.length).toBeGreaterThan(0);
    expect(exported.tables.category.some(row => row.id === 'uncategorized')).toBe(true);
    expect(exported.schemaVersion).toBe(6);
    expect(await migrations(db)).toEqual(schemaBefore);
  });

  it('rolls back the target ledger if a legacy template has a broken foreign key', async () => {
    const { db: source } = await legacyFixture();
    const original = await buildBackup(source);
    const { db: target, account } = await legacyFixture();
    const before = await buildBackup(target);
    const schemaBefore = await migrations(target);
    for (const column of ['category_id', 'default_account_id']) {
      const raw = JSON.parse(serializeBackup(original));
      for (const row of raw.tables.template) row[column] = 'missing-reference';
      const parsed = parseBackup(JSON.stringify(raw));
      await expect(restoreBackup(target, parsed)).rejects.toThrow();
      const after = await buildBackup(target);
      expect(after.tables).toEqual(before.tables);
      expect(after.counts).toEqual(before.counts);
      expect(await migrations(target)).toEqual(schemaBefore);
      expect(await accountBalance(target, account)).toBe(8770);
    }
  });
});

