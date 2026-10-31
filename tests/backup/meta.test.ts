import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import {
  countTxnRows,
  readBackupMeta,
  recordBackupMeta,
} from '../../src/backup/meta';
import { seedDefaults } from '../../src/db/seed';
import { listAccounts } from '../../src/db/repos/accounts';
import { listCategories } from '../../src/db/repos/categories';
import { createExpense } from '../../src/db/repos/txns';

const NOW = new Date(2026, 9, 23, 13, 5, 7);

describe('backup meta', () => {
  it('overwrites the previous backup instead of accumulating rows', async () => {
    const db = await createTestDb();
    await recordBackupMeta(db, { at: NOW.toISOString(), rows: 1, bytes: 10 });
    await recordBackupMeta(db, {
      at: new Date(2026, 9, 24, 8, 0).toISOString(),
      rows: 2,
      bytes: 20,
    });

    expect(await readBackupMeta(db)).toEqual({
      at: new Date(2026, 9, 24, 8, 0).toISOString(),
      rows: 2,
      bytes: 20,
    });
    const rows = await db.all<{ key: string }>('SELECT key FROM app_meta');
    expect(rows).toHaveLength(3);
  });

  it('treats a half-written or unreadable record as no backup at all', async () => {
    const db = await createTestDb();
    await db.run("INSERT INTO app_meta (key, value) VALUES ('last_backup_at', ?)", [
      NOW.toISOString(),
    ]);
    expect(await readBackupMeta(db)).toBeNull();

    await db.run("INSERT INTO app_meta (key, value) VALUES ('last_backup_rows', 'many')");
    await db.run("INSERT INTO app_meta (key, value) VALUES ('last_backup_bytes', '1024')");
    expect(await readBackupMeta(db)).toBeNull();
  });

  it('counts every txn row, including soft-deleted ones, as the file does', async () => {
    const db = await createTestDb();
    await seedDefaults(db);
    const account = (await listAccounts(db))[0];
    const category = (await listCategories(db)).find(candidate => candidate.name === '饮食');
    if (account === undefined || category === undefined) throw new Error('seed is incomplete');

    await createExpense(db, {
      date: '2026-10-20',
      accountId: account.id,
      amountCents: 100,
      categoryId: category.id,
    });
    await db.run('UPDATE txn SET deleted_at = ?', ['2026-10-21T00:00:00.000Z']);

    expect(await countTxnRows(db)).toBe(1);
  });
});
