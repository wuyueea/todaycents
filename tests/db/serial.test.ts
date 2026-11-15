import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/driver';
import { SerialDb } from '../../src/db/serial';
import { createTestDb } from '../helpers/nodeDb';

/** Resolves when the test says so, so a transaction can be held open on purpose. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every already-queued microtask run before an assertion. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Minimal Db that records what reached the wrapped driver. Transactions do not
 * begin real SQL; they only bracket the callback, which is enough to observe
 * the queue's ordering from the outside.
 */
class RecordingDb implements Db {
  readonly log: string[] = [];

  async exec(sql: string): Promise<void> {
    this.log.push(`exec:${sql}`);
  }

  async run(sql: string): Promise<void> {
    this.log.push(`run:${sql}`);
  }

  async all<T>(sql: string): Promise<T[]> {
    this.log.push(`all:${sql}`);
    return [];
  }

  async get<T>(sql: string): Promise<T | undefined> {
    this.log.push(`get:${sql}`);
    return undefined;
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    this.log.push('begin');
    try {
      return await fn(this);
    } finally {
      this.log.push('end');
    }
  }
}

describe('SerialDb', () => {
  it('holds queued writes until an open transaction commits', async () => {
    const inner = new RecordingDb();
    const db = new SerialDb(inner);
    const started = deferred();
    const release = deferred();

    const transaction = db.transaction(async () => {
      started.resolve();
      await release.promise;
    });

    await started.promise;
    const write = db.run('INSERT INTO txn');
    await flush();
    // The transaction is still open, so the write has reached nothing yet.
    expect(inner.log).toEqual(['begin']);

    release.resolve();
    await transaction;
    await write;
    expect(inner.log).toEqual(['begin', 'end', 'run:INSERT INTO txn']);
  });

  it('keeps queued writes and execs in the order they were issued', async () => {
    const inner = new RecordingDb();
    const db = new SerialDb(inner);
    const started = deferred();
    const release = deferred();

    const transaction = db.transaction(async () => {
      started.resolve();
      await release.promise;
    });

    await started.promise;
    const first = db.run('first');
    const second = db.exec('second');
    const third = db.run('third');

    release.resolve();
    await Promise.all([transaction, first, second, third]);

    expect(inner.log).toEqual(['begin', 'end', 'run:first', 'exec:second', 'run:third']);
  });

  it('releases the queue after a transaction rejects', async () => {
    const inner = new RecordingDb();
    const db = new SerialDb(inner);

    const failing = db.transaction(async () => {
      throw new Error('写入失败');
    });
    await expect(failing).rejects.toThrow('写入失败');

    await db.run('INSERT INTO txn');
    expect(inner.log).toEqual(['begin', 'end', 'run:INSERT INTO txn']);
  });

  it('lets reads run while a transaction is open', async () => {
    const inner = new RecordingDb();
    const db = new SerialDb(inner);
    const started = deferred();
    const release = deferred();

    const transaction = db.transaction(async () => {
      started.resolve();
      await release.promise;
    });

    await started.promise;
    await expect(db.get('SELECT 1')).resolves.toBeUndefined();
    expect(inner.log).toEqual(['begin', 'get:SELECT 1']);

    release.resolve();
    await transaction;
  });

  it('runs writes through the transaction view without waiting on the queue', async () => {
    // If the callback received this SerialDb instead of the inner driver, the
    // run below would queue behind its own transaction and the test would hang.
    const db = await createTestDb();

    await db.transaction(async tx => {
      await tx.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', ['serial-write', '1']);
    });

    await expect(
      db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', ['serial-write'])
    ).resolves.toEqual({ value: '1' });
  });

  it('keeps nested transactions working', async () => {
    const db = await createTestDb();

    await db.transaction(async tx => {
      await tx.transaction(async inner => {
        await inner.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', ['nested', 'ok']);
      });
    });

    await expect(
      db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', ['nested'])
    ).resolves.toEqual({ value: 'ok' });
  });

  it('serializes concurrent top-level transactions and rolls back only the failing one', async () => {
    const db = await createTestDb();
    const started = deferred();
    const release = deferred();

    const first = db.transaction(async tx => {
      await tx.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', ['tx-first', '1']);
      started.resolve();
      await release.promise;
      throw new Error('first failed');
    });

    await started.promise;
    const second = db.transaction(async tx => {
      await tx.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', ['tx-second', '2']);
    });

    release.resolve();
    await expect(first).rejects.toThrow('first failed');
    await second;

    await expect(
      db.get('SELECT value FROM app_meta WHERE key = ?', ['tx-first'])
    ).resolves.toBeUndefined();
    await expect(
      db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', ['tx-second'])
    ).resolves.toEqual({ value: '2' });
  });

  it('starts a queued transaction only after an earlier write has finished', async () => {
    const inner = new RecordingDb();
    const gate = deferred();
    const originalRun = inner.run.bind(inner);
    inner.run = async (sql: string) => {
      await gate.promise;
      return originalRun(sql);
    };
    const db = new SerialDb(inner);

    const write = db.run('INSERT INTO app_meta');
    const transaction = db.transaction(async () => {
      inner.log.push('tx-body');
    });

    gate.resolve();
    await Promise.all([write, transaction]);

    expect(inner.log).toEqual(['run:INSERT INTO app_meta', 'begin', 'tx-body', 'end']);
  });

  it('releases the queue after a non-transactional write fails', async () => {
    const inner = new RecordingDb();
    const originalRun = inner.run.bind(inner);
    let attempts = 0;
    inner.run = async (sql: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error('disk full');
      return originalRun(sql);
    };
    const db = new SerialDb(inner);

    await expect(db.run('INSERT INTO txn')).rejects.toThrow('disk full');
    await db.run('INSERT INTO account');

    expect(inner.log).toEqual(['run:INSERT INTO account']);
  });
});
