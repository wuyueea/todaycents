import { DatabaseSync } from 'node:sqlite';
import type { Db, DbParam } from '../../src/db/driver';
import { migrate } from '../../src/db/migrate';

/**
 * Node-side Db driver. Test-only: product code must never import
 * node:sqlite. The on-device driver arrives in a later task.
 */
class NodeDb implements Db {
  constructor(private readonly raw: DatabaseSync) {}

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  async run(sql: string, params: readonly DbParam[] = []): Promise<void> {
    this.raw.prepare(sql).run(...params);
  }

  async all<T>(sql: string, params: readonly DbParam[] = []): Promise<T[]> {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  async get<T>(sql: string, params: readonly DbParam[] = []): Promise<T | undefined> {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    this.raw.exec('BEGIN');
    try {
      const result = await fn(this);
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // Keep the callback's error; a failed ROLLBACK must not mask it.
      }
      throw error;
    }
  }
}

/** A migrated in-memory database for tests. */
export async function createTestDb(): Promise<Db> {
  const raw = new DatabaseSync(':memory:');
  // SQLite leaves foreign keys off per connection by default. Turn them on
  // before migrating so every REFERENCES in the schema is enforced here,
  // matching the on-device driver instead of accepting dangling ids.
  raw.exec('PRAGMA foreign_keys = ON');
  const db = new NodeDb(raw);
  await migrate(db);
  return db;
}
