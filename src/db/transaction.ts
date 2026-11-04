import type { Db } from './driver';

/**
 * The three statements a driver has to issue to bracket a transaction.
 *
 * Return values are ignored: SQLite answers BEGIN/COMMIT with a changes object
 * while node:sqlite returns nothing, and neither is this layer's business.
 */
export interface TransactionControls {
  begin(): Promise<unknown>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
}

/**
 * The one implementation of the Db.transaction contract.
 *
 * Every driver owns one runner per connection. The outermost call brackets the
 * work with begin/commit; a call made while a transaction is already open joins
 * it, because SQLite rejects a nested BEGIN and because a composite save (a row
 * plus its tags plus its project) has to be one unit of work.
 *
 * Any rejection rolls the whole thing back and rethrows the original error; a
 * failing rollback never masks it. Depth is per connection, not per call chain:
 * this is for nesting inside one logical save, never for two saves at once.
 *
 * The drivers share this class rather than each carrying a copy, so the rules
 * above — begin before counting, depth restored in finally, rollback that
 * cannot throw — are written and tested exactly once.
 */
export class TransactionRunner {
  private depth = 0;

  constructor(private readonly controls: TransactionControls) {}

  /**
   * True while a transaction is open.
   *
   * A driver whose engine can wrap a statement in its own transaction (the
   * Capacitor plugin can) asks this before every statement: inside a
   * transaction the statement must not open a second one.
   */
  get isOpen(): boolean {
    return this.depth > 0;
  }

  async run<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn(db);

    // Begin first: if it throws, nothing was opened and the depth stays 0, so
    // the next attempt still begins a real transaction.
    await this.controls.begin();
    this.depth += 1;
    try {
      const result = await fn(db);
      await this.controls.commit();
      return result;
    } catch (error) {
      try {
        await this.controls.rollback();
      } catch {
        // Keep the callback's error; a failed ROLLBACK must not mask it.
      }
      throw error;
    } finally {
      this.depth -= 1;
    }
  }
}
