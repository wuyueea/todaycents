import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import GlobalPurgeUndo from '../../src/components/GlobalPurgeUndo';
import { purgeUndoKey, selectPurgeUndo } from '../../src/components/PurgeUndoToast';
import { PURGE_UNDO_MS, readPurgeUndo } from '../../src/db/repos/purge';
import type { PurgeUndoRecord } from '../../src/db/repos/purge';
import { createTestDb } from '../helpers/nodeDb';

const store = vi.hoisted(() => ({
  record: null as PurgeUndoRecord | null,
}));

vi.mock('../../src/store/useDb', () => ({
  useDb: () => ({ db: { fake: true }, revision: 0, bump: () => {}, error: null }),
  useQuery: () => ({ data: store.record, loading: false, error: null }),
}));

function record(overrides: Partial<PurgeUndoRecord> = {}): PurgeUndoRecord {
  return {
    kind: 'category',
    targetId: 'c-sport',
    label: '运动',
    expiresAt: Date.now() + PURGE_UNDO_MS,
    ...overrides,
  };
}

function render(): string {
  return renderToString(<GlobalPurgeUndo />).replace(/<!-- -->/g, '');
}

beforeEach(() => {
  store.record = null;
});

describe('GlobalPurgeUndo', () => {
  it('shows a stored category purge on a tab, above the dock, with its 撤销 action', () => {
    store.record = record();
    const html = render();

    expect(html).toContain('「运动」已彻底删除');
    expect(html).toContain('10 秒内可撤销');
    expect(html).toContain('toast--above-dock');
    expect(html).toContain('toast--action');
    expect(html).toContain('撤销');
  });

  it('names a purged tag as a tag', () => {
    store.record = record({ kind: 'tag', targetId: 't-night', label: '夜宵' });
    const html = render();

    expect(html).toContain('标签「夜宵」已彻底删除');
    expect(html).toContain('10 秒内可撤销');
  });

  it('shows nothing when there is no stored purge', () => {
    expect(render()).not.toContain('已彻底删除');
  });

  it('does not resurrect a record whose window closed while the query was idle', () => {
    store.record = record({ expiresAt: Date.now() - 1 });
    expect(render()).not.toContain('已彻底删除');
  });

  it('renders the row read back from SQLite, so a restart has the same text', async () => {
    const db = await createTestDb();
    await db.run(
      `INSERT INTO purge_undo (id, kind, target_id, label, payload_json, expires_at, created_at)
       VALUES (1, 'category', ?, ?, ?, ?, ?)`,
      [
        'c-sport',
        '运动',
        JSON.stringify({
          category: [
            {
              id: 'c-sport',
              parent_id: null,
              name: '运动',
              kind: 'expense',
              sort: 1,
              archived_at: '2026-11-01T00:00:00.000Z',
            },
          ],
          hints: [],
        }),
        Date.now() + PURGE_UNDO_MS,
        new Date().toISOString(),
      ]
    );

    const stored = await readPurgeUndo(db);
    expect(stored).toMatchObject({ kind: 'category', targetId: 'c-sport', label: '运动' });

    store.record = stored;
    const html = render();
    expect(html).toContain('「运动」已彻底删除');
    expect(html).toContain('10 秒内可撤销');
  });
});

describe('selectPurgeUndo', () => {
  it('keeps a live record until it is dismissed', () => {
    const live = record();
    expect(selectPurgeUndo(null, live, null, live.expiresAt - 1)).toBe(live);
    expect(selectPurgeUndo(null, live, purgeUndoKey(live), live.expiresAt - 1)).toBeNull();
  });

  it('hides an expired record even when the query still returns it', () => {
    const live = record();
    expect(selectPurgeUndo(null, live, null, live.expiresAt)).toBeNull();
  });

  it('does not let an old dismissal hide a newer purge', () => {
    const older = record({ expiresAt: 2000 });
    const newer = record({ expiresAt: 3000 });
    expect(selectPurgeUndo(null, newer, purgeUndoKey(older), 1000)).toBe(newer);
  });
});
