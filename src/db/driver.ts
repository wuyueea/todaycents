/**
 * Storage boundary for the whole app.
 *
 * Product code only ever sees a Db. Concrete drivers live outside it: the
 * Node test driver in tests/helpers/nodeDb.ts, the on-device Capacitor
 * driver in a later task. Nothing here may name a specific engine.
 */

/** A value a database driver can bind to a statement parameter. */
export type DbParam = string | number | bigint | null | Uint8Array;

/**
 * Async by contract even where the engine underneath is synchronous: the
 * on-device driver is genuinely async, so every caller awaits from day one
 * and no call site changes when the driver swaps.
 */
export interface Db {
  /** Runs one or more statements for their side effects. */
  exec(sql: string): Promise<void>;

  /** Executes one statement and discards any result rows. */
  run(sql: string, params?: readonly DbParam[]): Promise<void>;

  /** Executes one statement and returns every row it produced. */
  all<T>(sql: string, params?: readonly DbParam[]): Promise<T[]>;

  /** Executes one statement and returns its first row, if any. */
  get<T>(sql: string, params?: readonly DbParam[]): Promise<T | undefined>;

  /**
   * Runs `fn` inside BEGIN / COMMIT. If `fn` rejects, issues ROLLBACK and
   * rethrows the original error. Nested transactions are not supported.
   *
   * The callback receives the same Db so a transaction body can be written
   * explicitly against its scope; `() => ...` callbacks are equally valid.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}
