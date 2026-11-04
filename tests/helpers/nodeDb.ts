import { DatabaseSync } from 'node:sqlite';
import type { Db, DbParam } from '../../src/db/driver';
import { TransactionRunner } from '../../src/db/transaction';
import { migrate } from '../../src/db/migrate';

/**
 * Node-side Db driver. Test-only: product code must never import
 * node:sqlite.
 *
 * Transactions come from the same TransactionRunner the device driver uses, so
 * the tests exercise the code that actually runs on the phone instead of a
 * second, hand-copied bracketing rule.
 */
class NodeDb implements Db {
  private readonly transactions: TransactionRunner;

  constructor(private readonly raw: DatabaseSync) {
    this.transactions = new TransactionRunner({
      begin: async () => {
        this.raw.exec('BEGIN');
      },
      commit: async () => {
        this.raw.exec('COMMIT');
      },
      rollback: async () => {
        this.raw.exec('ROLLBACK');
      },
    });
  }

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
    return this.transactions.run(this, fn);
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
