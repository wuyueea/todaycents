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
   * Runs `fn` inside a transaction. The outermost call owns BEGIN / COMMIT.
   *
   * A call made while a transaction is already open joins that transaction
   * instead of beginning a second one, so a save that writes several tables
   * can be composed from helpers that each open their own transaction. If any
   * call in the chain rejects, the whole transaction is rolled back and the
   * original error is rethrown: either all of it lands, or none of it does.
   *
   * Two limits worth knowing. There are no savepoints, so a nested call whose
   * error its caller catches does not undo itself — the outer transaction then
   * commits what that call had already written. And "already open" is tracked
   * per connection, not per call chain: for a raw driver, two top-level saves
   * started at once would share one transaction. Application code hands the
   * driver to SerialDb, which serializes top-level writes so that no longer
   * happens.
   *
   * The callback receives the Db handle for this transaction. Write through
   * `tx` only: a decorating driver such as SerialDb passes its inner driver
   * here, and a write sent through the outer `db` from inside the body would
   * queue behind the transaction it is part of and never return. Callbacks
   * that ignore the handle (`() => ...`) are still valid as long as they do
   * not write through an outer Db this way.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}
