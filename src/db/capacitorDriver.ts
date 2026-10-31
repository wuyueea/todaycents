/**
 * On-device Db driver.
 *
 * This module is loaded with a dynamic import() from src/db/index.ts. Keeping
 * it out of the static graph matters for two reasons: Vitest runs on Node,
 * where a native Capacitor plugin has no business being loaded, and the web
 * preview must still render when the native layer is absent.
 */
import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';
import type { Db, DbParam } from './driver';

/** One database per install; there is no account or profile concept. */
const DATABASE_NAME = 'ledger';

/** Introduced with the v1 schema; the plugin needs a version per connection. */
const DATABASE_VERSION = 1;

/**
 * The plugin's bridge is JSON-based and has no bigint representation. The app
 * only binds strings and safe integer cents, so widening to number is lossless
 * for every value this codebase can produce.
 */
function bindableValues(params: readonly DbParam[]): unknown[] {
  return params.map(param => (typeof param === 'bigint' ? Number(param) : param));
}

/**
 * Maps the app's Db contract onto one SQLiteConnection.
 *
 * Transactions are tracked with a depth counter because the plugin rejects
 * nested BEGINs and because statements issued inside an explicit transaction
 * must tell the plugin not to open (and commit) a transaction of their own.
 */
class CapacitorDb implements Db {
  private depth = 0;
  private readonly connection: SQLiteDBConnection;

  constructor(connection: SQLiteDBConnection) {
    this.connection = connection;
  }

  async exec(sql: string): Promise<void> {
    // Outside a transaction the plugin wraps the batch atomically; inside one
    // it must stay in the caller's transaction.
    await this.connection.execute(sql, this.depth === 0);
  }

  async run(sql: string, params: readonly DbParam[] = []): Promise<void> {
    // execute() has no parameter binding, so parameterized statements use
    // run(); both go through the same SQLite engine.
    await this.connection.run(sql, bindableValues(params), this.depth === 0);
  }

  async all<T>(sql: string, params: readonly DbParam[] = []): Promise<T[]> {
    const result = await this.connection.query(sql, bindableValues(params));
    return (result.values ?? []) as T[];
  }

  async get<T>(sql: string, params: readonly DbParam[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.depth > 0) {
      throw new Error('nested transactions are not supported');
    }

    // Begin first: if the plugin refuses, nothing was opened and the depth
    // counter must stay untouched for the next attempt.
    await this.connection.beginTransaction();
    this.depth += 1;
    try {
      const result = await fn(this);
      await this.connection.commitTransaction();
      return result;
    } catch (error) {
      try {
        await this.connection.rollbackTransaction();
      } catch {
        // Keep the callback's error; a failed ROLLBACK must not mask it.
      }
      throw error;
    } finally {
      this.depth -= 1;
    }
  }
}

/**
 * Opens the on-device database and returns it as a Db.
 *
 * Throws a single, explicit error when there is no native layer, so the shell
 * can render "数据层未就绪" instead of an unhandled plugin rejection.
 */
export async function openCapacitorDb(): Promise<Db> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('数据层未就绪：当前环境没有 Capacitor 原生 SQLite');
  }

  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const connection = await sqlite.createConnection(
    DATABASE_NAME,
    false,
    'no-encryption',
    DATABASE_VERSION,
    false
  );

  await connection.open();

  // SQLite leaves foreign keys off per connection, and PRAGMA statements are
  // no-ops inside a transaction, so run this on its own.
  await connection.execute('PRAGMA foreign_keys = ON;', false);

  return new CapacitorDb(connection);
}
