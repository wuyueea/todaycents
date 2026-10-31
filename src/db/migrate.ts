import type { Db } from './driver';
import { MIGRATIONS } from './schema';

const CREATE_SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT
);
`;

/**
 * Brings a database up to date. Idempotent: a second run finds every
 * migration already recorded and changes nothing.
 *
 * Creating schema_migrations, reading MAX(version) and applying the pending
 * migrations all happen inside one transaction, so a failed upgrade leaves
 * the schema exactly as it was.
 */
export async function migrate(db: Db): Promise<void> {
  await db.transaction(async tx => {
    await tx.exec(CREATE_SCHEMA_MIGRATIONS);

    const row = await tx.get<{ version: number | null }>(
      'SELECT MAX(version) AS version FROM schema_migrations'
    );
    const currentVersion = row?.version ?? 0;

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue;
      await tx.exec(migration.sql);
      await tx.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [
        migration.version,
        new Date().toISOString(),
      ]);
    }
  });
}
