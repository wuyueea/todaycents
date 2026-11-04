import { afterAll, beforeAll, vi } from 'vitest';

/**
 * Pins the app clock for one suite, so a fixture written for a calendar day
 * means the same thing on every run.
 *
 * The screens ask the real clock what "today" is (`todayLocalISO` in
 * `LedgerScreen` / `ReportsScreen`), and several suites describe one concrete
 * month. Without this, a suite that passed on 2026-10-31 starts failing on
 * 2026-11-01 even though the app is right and only the expectation is stale.
 *
 * `vi.useFakeTimers` also replaces `Date`, which is what the screens read.
 * Call this at the top level of a test file: the hooks cover every test in it.
 */
export function freezeToday(at: Date): void {
  beforeAll(() => {
    vi.useFakeTimers({ now: at });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
}
