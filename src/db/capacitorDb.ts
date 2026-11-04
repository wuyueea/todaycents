/**
 * The on-device Db, mapped onto one SQLite connection.
 *
 * This lives apart from capacitorDriver.ts on purpose: the class must be
 * loadable in a Node test process, where no Capacitor plugin exists. It
 * therefore imports no plugin at runtime — the connection arrives as the narrow
 * port below, so a fake connection can exercise the transaction wiring that
 * production actually uses.
 */
import type { Db, DbParam } from './driver';
import { TransactionRunner } from './transaction';

/**
 * The slice of @capacitor-community/sqlite's SQLiteDBConnection this adapter
 * uses. The real connection satisfies it structurally; declaring it here is
 * what keeps the plugin out of the import graph.
 */
export interface SQLiteConnectionPort {
  execute(sql: string, transaction?: boolean): Promise<unknown>;
  run(sql: string, values?: unknown[], transaction?: boolean): Promise<unknown>;
  query(sql: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
  beginTransaction(): Promise<unknown>;
  commitTransaction(): Promise<unknown>;
  rollbackTransaction(): Promise<unknown>;
}

/**
 * The plugin's bridge is JSON-based and has no bigint representation. The app
 * only binds strings and safe integer cents, so widening to number is lossless
 * for every value this codebase can produce.
 */
function bindableValues(params: readonly DbParam[]): unknown[] {
  return params.map(param => (typeof param === 'bigint' ? Number(param) : param));
}

/** The app-wide Db, mapped onto one open SQLite connection. */
export class CapacitorDb implements Db {
  private readonly transactions: TransactionRunner;

  constructor(private readonly connection: SQLiteConnectionPort) {
    this.transactions = new TransactionRunner({
      begin: () => this.connection.beginTransaction(),
      commit: () => this.connection.commitTransaction(),
      rollback: () => this.connection.rollbackTransaction(),
    });
  }

  async exec(sql: string): Promise<void> {
    // Outside a transaction the plugin wraps the batch atomically; inside one
    // it must stay in the caller's transaction.
    await this.connection.execute(sql, !this.transactions.isOpen);
  }

  async run(sql: string, params: readonly DbParam[] = []): Promise<void> {
    // execute() has no parameter binding, so parameterized statements use
    // run(); both go through the same SQLite engine.
    await this.connection.run(sql, bindableValues(params), !this.transactions.isOpen);
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
    return this.transactions.run(this, fn);
  }
}
