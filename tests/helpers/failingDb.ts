import type { Db, DbParam } from '../../src/db/driver';

/**
 * A Db view that rejects any write whose SQL matches `shouldFail`.
 *
 * Tests use it to prove a multi-statement save is atomic: the failure lands
 * inside the repository's transaction, midway through its statements, exactly
 * where a real driver error would. It has to wrap the callback's transaction
 * view as well, because product code writes through `tx` once a transaction is
 * open — patching the outer object alone no longer reaches those statements.
 *
 * The failure is sticky: every matching statement fails until the test ends.
 * These tests expect the first failure to abort the operation; there is no
 * one-shot retry semantics.
 */
export function failingDb(
  inner: Db,
  shouldFail: (sql: string) => boolean,
  message = 'injected failure'
): Db {
  const wrap = (target: Db): Db => ({
    exec(sql: string): Promise<void> {
      return shouldFail(sql) ? Promise.reject(new Error(message)) : target.exec(sql);
    },
    run(sql: string, params?: readonly DbParam[]): Promise<void> {
      return shouldFail(sql) ? Promise.reject(new Error(message)) : target.run(sql, params);
    },
    all<T>(sql: string, params?: readonly DbParam[]): Promise<T[]> {
      return target.all<T>(sql, params);
    },
    get<T>(sql: string, params?: readonly DbParam[]): Promise<T | undefined> {
      return target.get<T>(sql, params);
    },
    transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return target.transaction(tx => fn(wrap(tx)));
    },
  });
  return wrap(inner);
}
