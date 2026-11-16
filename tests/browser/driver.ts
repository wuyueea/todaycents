import type { Db, DbParam } from '../../src/db/driver';
import { TransactionRunner } from '../../src/db/transaction';
import { SerialDb } from '../../src/db/serial';

// Only the browser-test build aliases capacitorDriver to this file.
// Reloads share a DB; a new Playwright context receives a fresh in-memory DB.
const sessionKey = 'todaycents-e2e-session';
let session = sessionStorage.getItem(sessionKey);
if (!session) {
  session = crypto.randomUUID();
  sessionStorage.setItem(sessionKey, session);
}

class BrowserTestDb implements Db {
  private readonly transactions = new TransactionRunner({
    begin: () => this.exec('BEGIN'),
    commit: () => this.exec('COMMIT'),
    rollback: () => this.exec('ROLLBACK'),
  });

  private async call<T>(op: string, sql: string, params: readonly DbParam[] = []): Promise<T> {
    const response = await fetch('/__e2e/sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Session': session! },
      body: JSON.stringify({ op, sql, params: params.map(p => typeof p === 'bigint' ? Number(p) : p) }),
    });
    const result = await response.json() as { value: T; error?: string };
    if (!response.ok) throw new Error(result.error ?? 'Browser test database failed');
    return result.value;
  }

  async exec(sql: string): Promise<void> { await this.call('exec', sql); }
  async run(sql: string, params?: readonly DbParam[]): Promise<void> { await this.call('run', sql, params); }
  all<T>(sql: string, params?: readonly DbParam[]): Promise<T[]> { return this.call('all', sql, params); }
  async get<T>(sql: string, params?: readonly DbParam[]): Promise<T | undefined> {
    return (await this.call<T | null>('get', sql, params)) ?? undefined;
  }
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> { return this.transactions.run(this, fn); }
}

export async function openCapacitorDb(): Promise<Db> {
  return new SerialDb(new BrowserTestDb());
}
