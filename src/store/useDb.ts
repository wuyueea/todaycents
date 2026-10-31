import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Db } from '../db/driver';
import { getDb } from '../db';

/**
 * A tiny change counter for the whole data layer.
 *
 * Every write path calls bump() after it commits, and every query subscribes
 * through useQuery. There is deliberately no diffing or cache invalidation:
 * the database is small and local, so refetching is cheaper than being wrong.
 */
export interface RevisionStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): number;
  bump(): void;
}

/**
 * Builds an isolated revision store. The app uses one module-level instance
 * shared by every screen; tests build their own so they cannot leak counts.
 */
export function createRevisionStore(): RevisionStore {
  let revision = 0;
  const listeners = new Set<() => void>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      // Set.delete is idempotent, so calling the returned function twice is safe.
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot() {
      return revision;
    },

    bump() {
      // Increment first: a listener that reads getSnapshot() during the
      // notification must already see the new revision, never the old one.
      revision += 1;
      // Copy the set so a listener that unsubscribes (or subscribes) during
      // the loop cannot make the iteration skip another listener.
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The one counter every mounted query listens to. */
const revisionStore = createRevisionStore();

/** Turns a driver rejection (the plugin rejects with plain strings) into Error. */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

export interface UseDbResult {
  /** The open database, or null while opening / when the data layer is unavailable. */
  db: Db | null;
  /** Bumped after every write; pass it to useQuery's dependencies. */
  revision: number;
  /** Call after a successful write to refetch every mounted query. */
  bump(): void;
  /**
   * Why opening the database failed. Not part of the original interface, but
   * the shell needs to tell "still opening" apart from "no native SQLite here"
   * without catching the error itself.
   */
  error: Error | null;
}

/**
 * Opens the singleton database once for the lifetime of the app.
 *
 * Opening is asynchronous (migrate + seed run on the first getDb), so callers
 * see db === null for the first render. A rejected open is remembered as an
 * Error and never retried automatically: on a browser there is no native
 * SQLite to retry against, and the shell shows a plain unavailable state.
 */
export function useDb(): UseDbResult {
  const revision = useSyncExternalStore(
    revisionStore.subscribe,
    revisionStore.getSnapshot,
    revisionStore.getSnapshot
  );
  const [db, setDb] = useState<Db | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    getDb().then(
      opened => {
        if (cancelled) return;
        setDb(opened);
        setError(null);
      },
      reason => {
        if (cancelled) return;
        setDb(null);
        setError(asError(reason));
      }
    );

    return () => {
      cancelled = true;
    };
  }, []);

  return { db, revision, bump: revisionStore.bump, error };
}

export interface UseQueryResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Runs a query against the app database and reruns it whenever deps or the
 * global revision changes.
 *
 * Each run owns a cancelled flag: when deps change (or the component unmounts)
 * the previous run is marked cancelled and its result is dropped, so a slow
 * old query can never overwrite a newer one.
 */
export function useQuery<T>(
  fn: (db: Db) => Promise<T>,
  deps: readonly unknown[]
): UseQueryResult<T> {
  const { db, revision, error: dbError } = useDb();
  const [state, setState] = useState<UseQueryResult<T>>({
    data: null,
    loading: true,
    error: null,
  });

  // A query function is usually an inline closure. Keep the newest one in a
  // ref so a revision-triggered rerun uses current values without making the
  // function itself a dependency (callers express change through deps).
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!db) return;

    let cancelled = false;
    setState(previous => ({ data: previous.data, loading: true, error: null }));

    fnRef.current(db).then(
      data => {
        if (cancelled) return;
        setState({ data, loading: false, error: null });
      },
      reason => {
        if (cancelled) return;
        setState({ data: null, loading: false, error: asError(reason) });
      }
    );

    return () => {
      cancelled = true;
    };
    // deps is intentionally spread: useQuery mirrors useEffect's dependency
    // contract for its callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, revision, ...deps]);

  if (!db) {
    return dbError
      ? { data: null, loading: false, error: dbError }
      : { data: null, loading: true, error: null };
  }

  return state;
}
