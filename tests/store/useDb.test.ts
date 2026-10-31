import { describe, it, expect } from 'vitest';
import { createRevisionStore } from '../../src/store/useDb';

describe('revision store', () => {
  it('notifies subscribers on bump', () => {
    const store = createRevisionStore();
    let seen = 0;
    const off = store.subscribe(() => { seen += 1; });
    store.bump();
    store.bump();
    off();
    store.bump();
    expect(seen).toBe(2);
    expect(store.getSnapshot()).toBe(3);
  });

  it('increments the snapshot before notifying', () => {
    const store = createRevisionStore();
    const snapshots: number[] = [];
    const off = store.subscribe(() => { snapshots.push(store.getSnapshot()); });
    store.bump();
    store.bump();
    off();
    expect(snapshots).toEqual([1, 2]);
  });

  it('tolerates unsubscribing twice and notifies every listener', () => {
    const store = createRevisionStore();
    const calls: string[] = [];
    const offA = store.subscribe(() => { calls.push('a'); });
    const offB = store.subscribe(() => { calls.push('b'); });
    store.bump();
    offA();
    offA();
    store.bump();
    offB();
    expect(calls).toEqual(['a', 'b', 'b']);
  });
});
