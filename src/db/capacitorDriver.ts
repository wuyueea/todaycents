/**
 * On-device Db driver: the one place that talks to Capacitor.
 *
 * This module is loaded with a dynamic import() from src/db/index.ts. Keeping
 * it out of the static graph matters for two reasons: Vitest runs on Node,
 * where a native Capacitor plugin has no business being loaded, and the web
 * preview must still render when the native layer is absent.
 *
 * The adapter itself lives in capacitorDb.ts so its transaction wiring can be
 * tested against a fake connection; this file only opens the real one.
 */
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import type { Db } from './driver';
import { CapacitorDb } from './capacitorDb';

/** One database per install; there is no account or profile concept. */
const DATABASE_NAME = 'ledger';

/** Introduced with the v1 schema; the plugin needs a version per connection. */
const DATABASE_VERSION = 1;

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

  // Passing the plugin's own connection is also the compile-time check that
  // it still fits SQLiteConnectionPort: a signature drift fails the build here.
  return new CapacitorDb(connection);
}
