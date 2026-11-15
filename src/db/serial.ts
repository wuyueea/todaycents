/**
 * Serializes writes on a single database connection.
 *
 * Everything in the app shares one SQLite connection. `TransactionRunner`
 * tracks "a transaction is open" per connection, not per call chain, so two
 * top-level `transaction()` calls running at once would join the same
 * transaction: the first COMMIT would carry the second call's writes with it,
 * and a failure in one would roll back the other. Reads are unaffected because
 * they never open a transaction.
 *
 * This decorator puts every write (single-statement `run`/`exec` and whole
 * `transaction` blocks) in one FIFO queue, so a transaction sees the database
 * exactly as its caller left it and the next write starts only after it is
 * over. `all`/`get` pass straight through: a read cannot join a transaction it
 * did not open, and keeping reads unqueued means a slow import does not freeze
 * the lists. Reads are therefore not snapshot-protected themselves: a read
 * issued while a write transaction is open on this same connection can see
 * that transaction's uncommitted rows. That is the single-connection behavior
 * the app already had; the queue only orders writes.
 *
 * The callback of `transaction()` receives the inner driver, not this wrapper.
 * That is the point: statements issued through `tx` belong to the transaction
 * and must not queue behind it. Code inside a transaction body must therefore
 * write through `tx`; reaching back to the outer `db` would wait for the
 * transaction to finish and dead-lock. Nested `tx.transaction(...)` calls are
 * still merged by the inner driver's own runner.
 */
import type { Db, DbParam } from './driver';

export class SerialDb implements Db {
  /** Resolves when the latest queued write has settled; never rejects. */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly inner: Db) {}

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    // A failed write must not poison the queue for every later one.
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  exec(sql: string): Promise<void> {
    return this.enqueue(() => this.inner.exec(sql));
  }

  run(sql: string, params?: readonly DbParam[]): Promise<void> {
    return this.enqueue(() => this.inner.run(sql, params));
  }

  all<T>(sql: string, params?: readonly DbParam[]): Promise<T[]> {
    return this.inner.all<T>(sql, params);
  }

  get<T>(sql: string, params?: readonly DbParam[]): Promise<T | undefined> {
    return this.inner.get<T>(sql, params);
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.enqueue(() => this.inner.transaction(fn));
  }
}
