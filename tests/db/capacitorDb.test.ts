import { describe, expect, it } from 'vitest';
import { CapacitorDb } from '../../src/db/capacitorDb';
import type { SQLiteConnectionPort } from '../../src/db/capacitorDb';

/** One recorded call on the fake connection. */
interface Call {
  op: 'execute' | 'run' | 'query' | 'begin' | 'commit' | 'rollback';
  args: readonly unknown[];
}

interface FakeFaults {
  /** Throw from BEGIN this many times before it starts succeeding. */
  beginFailures?: number;
  /** Throw from COMMIT. */
  commitThrows?: boolean;
  /** Throw from ROLLBACK. */
  rollbackThrows?: boolean;
  /** Answer queries with no rows at all, as an empty table does. */
  emptyRows?: boolean;
}

/**
 * A stand-in for the plugin's SQLiteDBConnection.
 *
 * The device adapter had no test coverage: every database test ran against the
 * Node driver, so the plugin flag and the BEGIN/COMMIT wiring were only ever
 * exercised on the phone. This fake records exactly the calls the adapter makes.
 */
function fakeConnection(faults: FakeFaults = {}) {
  const calls: Call[] = [];
  let beginFailures = faults.beginFailures ?? 0;

  const connection: SQLiteConnectionPort = {
    async execute(sql, transaction) {
      calls.push({ op: 'execute', args: [sql, transaction] });
    },
    async run(sql, values, transaction) {
      calls.push({ op: 'run', args: [sql, values, transaction] });
    },
    async query(sql, values) {
      calls.push({ op: 'query', args: [sql, values] });
      return faults.emptyRows ? {} : { values: [{ id: 'row-1' }] };
    },
    async beginTransaction() {
      calls.push({ op: 'begin', args: [] });
      if (beginFailures > 0) {
        beginFailures -= 1;
        throw new Error('begin failed');
      }
    },
    async commitTransaction() {
      calls.push({ op: 'commit', args: [] });
      if (faults.commitThrows) throw new Error('commit failed');
    },
    async rollbackTransaction() {
      calls.push({ op: 'rollback', args: [] });
      if (faults.rollbackThrows) throw new Error('rollback failed');
    },
  };

  return { connection, calls };
}

describe('CapacitorDb', () => {
  it('binds parameters, widens bigint cents, and maps rows for all/get', async () => {
    const { connection, calls } = fakeConnection();
    const db = new CapacitorDb(connection);

    expect(await db.get('SELECT 1', ['a', 5n])).toEqual({ id: 'row-1' });
    expect(await db.all('SELECT 2')).toEqual([{ id: 'row-1' }]);
    // Money is written, not read: the run path has to widen bigint cents too.
    await db.run('INSERT INTO t VALUES (?)', [7n]);
    expect(calls).toEqual([
      { op: 'query', args: ['SELECT 1', ['a', 5]] },
      { op: 'query', args: ['SELECT 2', []] },
      { op: 'run', args: ['INSERT INTO t VALUES (?)', [7], true] },
    ]);
  });

  // The plugin wraps a statement in its own transaction unless it is told not
  // to; inside ours it must be told not to, or the write would commit on its own.
  it('asks the plugin to wrap statements outside a transaction and not inside', async () => {
    const { connection, calls } = fakeConnection();
    const db = new CapacitorDb(connection);

    await db.exec('CREATE TABLE t (id TEXT)');
    expect(calls.at(-1)).toEqual({ op: 'execute', args: ['CREATE TABLE t (id TEXT)', true] });

    await db.run('INSERT INTO t VALUES (?)', ['a']);
    expect(calls.at(-1)).toEqual({ op: 'run', args: ['INSERT INTO t VALUES (?)', ['a'], true] });

    await db.transaction(async tx => {
      await tx.exec('INSERT INTO t VALUES (b)');
      await tx.run('INSERT INTO t VALUES (?)', ['c']);
    });
    // execute(sql, transaction) and run(sql, values, transaction) carry the
    // flag in different positions; both must be false inside the transaction.
    const inside = calls.filter(call => call.op === 'execute' || call.op === 'run').slice(2);
    expect(inside.map(call => (call.op === 'execute' ? call.args[1] : call.args[2]))).toEqual([
      false,
      false,
    ]);
  });

  it('brackets one save with a single begin and a single commit', async () => {
    const { connection, calls } = fakeConnection();
    const db = new CapacitorDb(connection);

    const result = await db.transaction(async tx => {
      await tx.run('INSERT INTO t VALUES (?)', ['a']);
      return 7;
    });

    expect(result).toBe(7);
    // Order matters, not just counts: a COMMIT that ran before the write would
    // pass a count-only assertion while saving nothing.
    expect(calls.map(call => call.op)).toEqual(['begin', 'run', 'commit']);
  });

  // If the depth failed to return to zero, every later write would run without
  // a transaction and nothing would fail loudly — the worst failure mode here.
  it('returns the depth to zero after a successful save', async () => {
    const { connection, calls } = fakeConnection();
    const db = new CapacitorDb(connection);

    await db.transaction(async tx => {
      await tx.run('INSERT INTO t VALUES (?)', ['a']);
    });
    await db.exec('CREATE TABLE t2 (id TEXT)');

    expect(calls.at(-1)).toEqual({ op: 'execute', args: ['CREATE TABLE t2 (id TEXT)', true] });
  });

  it('rolls back and rethrows when COMMIT itself fails', async () => {
    const { connection, calls } = fakeConnection({ commitThrows: true });
    const db = new CapacitorDb(connection);

    await expect(
      db.transaction(async tx => {
        await tx.run('INSERT INTO t VALUES (?)', ['a']);
      })
    ).rejects.toThrow('commit failed');

    expect(calls.filter(call => call.op === 'rollback')).toHaveLength(1);
  });

  it('answers an empty table with an empty array', async () => {
    const { connection } = fakeConnection({ emptyRows: true });
    const db = new CapacitorDb(connection);

    expect(await db.all('SELECT 1')).toEqual([]);
    expect(await db.get('SELECT 1')).toBeUndefined();
  });

  it('joins an open transaction instead of beginning a second one', async () => {
    const { connection, calls } = fakeConnection();
    const db = new CapacitorDb(connection);

    const inner = await db.transaction(async tx =>
      tx.transaction(async nested => {
        await nested.run('INSERT INTO t VALUES (?)', ['a']);
        return 'from inner';
      })
    );

    expect(inner).toBe('from inner');
    expect(calls.filter(call => call.op === 'begin')).toHaveLength(1);
    expect(calls.filter(call => call.op === 'commit')).toHaveLength(1);
  });

  it('rolls back once and rethrows the original error', async () => {
    const { connection, calls } = fakeConnection();
    const db = new CapacitorDb(connection);
    const boom = new Error('boom');

    await expect(
      db.transaction(async tx => {
        await tx.run('INSERT INTO t VALUES (?)', ['a']);
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(calls.filter(call => call.op === 'rollback')).toHaveLength(1);
    expect(calls.filter(call => call.op === 'commit')).toHaveLength(0);
  });

  // A failed ROLLBACK must not replace the reason the save failed.
  it('rethrows the callback error even when ROLLBACK itself fails', async () => {
    const { connection, calls } = fakeConnection({ rollbackThrows: true });
    const db = new CapacitorDb(connection);
    const boom = new Error('boom');

    await expect(
      db.transaction(async () => {
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(calls.filter(call => call.op === 'rollback')).toHaveLength(1);
  });

  // If BEGIN fails, the depth counter must stay at zero: counting a transaction
  // that never opened would make every later save join nothing at all.
  it('still begins a real transaction after a failed BEGIN', async () => {
    const { connection, calls } = fakeConnection({ beginFailures: 1 });
    const db = new CapacitorDb(connection);

    await expect(db.transaction(async () => 1)).rejects.toThrow('begin failed');

    const result = await db.transaction(async tx => {
      await tx.run('INSERT INTO t VALUES (?)', ['a']);
      return 2;
    });

    expect(result).toBe(2);
    expect(calls.filter(call => call.op === 'begin')).toHaveLength(2);
    expect(calls.filter(call => call.op === 'commit')).toHaveLength(1);
    const insert = calls.find(call => call.op === 'run');
    expect(insert?.args[2]).toBe(false);
  });
});
