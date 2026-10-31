import type { Db } from './driver';
import { migrate } from './migrate';
import { seedDefaults } from './seed';

/**
 * The app-wide database singleton. The first call opens the on-device
 * database, brings the schema up to date and writes the starter accounts and
 * taxonomy; every later call returns the same promise.
 *
 * The driver is imported dynamically on purpose: a static import would pull
 * @capacitor-community/sqlite into the Vitest (Node) process and into the
 * initial web bundle, even though only a native shell can use it.
 */
let opening: Promise<Db> | null = null;

async function openLedger(): Promise<Db> {
  const { openCapacitorDb } = await import('./capacitorDriver');
  const db = await openCapacitorDb();
  await migrate(db);
  await seedDefaults(db);
  return db;
}

/**
 * Returns the singleton database, opening it on first use.
 *
 * A failed open stays cached: on the web there is nothing to retry against,
 * and on a device a transient failure is better surfaced than hammered. The
 * shell turns the rejection into a plain unavailable state.
 */
export function getDb(): Promise<Db> {
  if (opening === null) {
    opening = openLedger();
  }
  return opening;
}
