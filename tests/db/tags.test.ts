import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import { createAccount } from '../../src/db/repos/accounts';
import { createCategory } from '../../src/db/repos/categories';
import { createExpense, listTxnsByMonth, softDeleteTxn } from '../../src/db/repos/txns';
import {
  archiveTag,
  createTag,
  deleteTag,
  getTxnTags,
  listTags,
  listTagsForTxns,
  renameTag,
  setTxnTags,
  tagUsage,
  unarchiveTag,
} from '../../src/db/repos/tags';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

/** A migrated database with one account, one category and a helper to spend. */
async function fixture(): Promise<{
  db: TestDb;
  card: string;
  food: string;
  spend: (date: string) => Promise<string>;
}> {
  const db = await createTestDb();
  const card = await createAccount(db, { name: '饭卡', type: 'prepaid' });
  const food = await createCategory(db, { name: '饮食', kind: 'expense' });
  const spend = (date: string) =>
    createExpense(db, { date, accountId: card, amountCents: 1230, categoryId: food });
  return { db, card, food, spend };
}

describe('createTag', () => {
  it('trims the name and stores a live tag with no colour', async () => {
    const db = await createTestDb();
    const id = await createTag(db, '  夜宵  ');

    expect(await listTags(db)).toEqual([{ id, name: '夜宵', color: null, archivedAt: null }]);
  });

  it('rejects an empty or whitespace-only name and writes nothing', async () => {
    const db = await createTestDb();
    for (const name of ['', '   ', '\t\n']) {
      await expect(createTag(db, name)).rejects.toThrow(/不能为空/);
    }
    expect(await db.all('SELECT id FROM tag')).toHaveLength(0);
  });

  it('accepts 12 characters and rejects 13', async () => {
    const db = await createTestDb();
    const twelve = '字'.repeat(12);
    const id = await createTag(db, twelve);
    expect((await listTags(db)).find(tag => tag.id === id)?.name).toBe(twelve);

    await expect(createTag(db, '字'.repeat(13))).rejects.toThrow(/12/);
    expect(await db.all('SELECT id FROM tag')).toHaveLength(1);
  });

  it('returns the existing id for the same trimmed, case-insensitive name', async () => {
    const db = await createTestDb();
    const first = await createTag(db, 'Night');

    expect(await createTag(db, '  nIGHT ')).toBe(first);
    expect(await db.all('SELECT id FROM tag')).toHaveLength(1);
  });

  it('reuses an archived tag id without unarchiving it', async () => {
    const db = await createTestDb();
    const id = await createTag(db, '旧标签');
    await archiveTag(db, id);

    expect(await createTag(db, '旧标签')).toBe(id);
    expect(await listTags(db)).toEqual([]);
    expect(await listTags(db, { includeArchived: true })).toHaveLength(1);
  });
});

describe('listTags', () => {
  it('lists live tags in name order and includes archived only when asked', async () => {
    const db = await createTestDb();
    await createTag(db, 'beta');
    const alpha = await createTag(db, 'alpha');
    await archiveTag(db, alpha);

    expect((await listTags(db)).map(tag => tag.name)).toEqual(['beta']);

    const all = await listTags(db, { includeArchived: true });
    expect(all.map(tag => tag.name)).toEqual(['alpha', 'beta']);
    expect(all[0].archivedAt).not.toBeNull();
  });
});

describe('renameTag', () => {
  it('renames with the same trim rule and keeps the id', async () => {
    const db = await createTestDb();
    const id = await createTag(db, '旧名');

    await renameTag(db, id, '  新名  ');
    expect(await listTags(db)).toEqual([{ id, name: '新名', color: null, archivedAt: null }]);
  });

  it('rejects a blank name, a missing tag and a name already taken by another tag', async () => {
    const db = await createTestDb();
    const id = await createTag(db, 'a');
    await createTag(db, 'b');

    await expect(renameTag(db, id, '   ')).rejects.toThrow(/不能为空/);
    await expect(renameTag(db, 'missing-tag', 'x')).rejects.toThrow(/不存在/);
    await expect(renameTag(db, id, ' B ')).rejects.toThrow(/同名/);

    expect((await listTags(db)).map(tag => tag.name)).toEqual(['a', 'b']);
  });
});

describe('archiveTag / unarchiveTag', () => {
  it('archives idempotently, keeping the first timestamp, and unarchives', async () => {
    const db = await createTestDb();
    const id = await createTag(db, '夜宵');

    await archiveTag(db, id);
    const first = await db.get<{ archived_at: string }>('SELECT archived_at FROM tag WHERE id = ?', [id]);
    await archiveTag(db, id);
    const second = await db.get<{ archived_at: string }>('SELECT archived_at FROM tag WHERE id = ?', [id]);
    expect(second?.archived_at).toBe(first?.archived_at);

    await unarchiveTag(db, id);
    expect((await listTags(db)).map(tag => tag.name)).toEqual(['夜宵']);
  });
});

describe('deleteTag', () => {
  it('removes only the tag links and soft-deletes the tag, leaving transactions intact', async () => {
    const { db, spend } = await fixture();
    const txn = await spend('2026-10-01');
    const tag = await createTag(db, '夜宵');
    await setTxnTags(db, txn, [tag]);

    await deleteTag(db, tag);

    expect(await listTxnsByMonth(db, '2026-10')).toHaveLength(1);
    expect((await listTxnsByMonth(db, '2026-10'))[0].id).toBe(txn);
    expect(await db.all('SELECT txn_id, tag_id FROM txn_tag')).toHaveLength(0);
    expect(await getTxnTags(db, txn)).toEqual([]);

    const row = await db.get<{ archived_at: string | null }>(
      'SELECT archived_at FROM tag WHERE id = ?',
      [tag]
    );
    expect(row?.archived_at).not.toBeNull();
  });

  it('keeps the first deletion timestamp and never removes the tag row', async () => {
    const db = await createTestDb();
    const tag = await createTag(db, '夜宵');

    await deleteTag(db, tag);
    const first = await db.get<{ archived_at: string }>('SELECT archived_at FROM tag WHERE id = ?', [tag]);
    await deleteTag(db, tag);
    const second = await db.get<{ archived_at: string }>('SELECT archived_at FROM tag WHERE id = ?', [tag]);

    expect(second?.archived_at).toBe(first?.archived_at);
    expect(await db.all('SELECT id FROM tag')).toHaveLength(1);
  });
});

describe('tagUsage', () => {
  it('counts live transactions only and reports the latest occurred date', async () => {
    const { db, spend } = await fixture();
    const used = await createTag(db, 'a');
    const deletedOnly = await createTag(db, 'b');
    const never = await createTag(db, 'c');

    const first = await spend('2026-10-01');
    const latest = await spend('2026-10-05');
    const deleted = await spend('2026-10-09');
    await setTxnTags(db, first, [used]);
    await setTxnTags(db, latest, [used]);
    await setTxnTags(db, deleted, [deletedOnly]);
    await softDeleteTxn(db, deleted);

    expect(await tagUsage(db)).toEqual([
      { id: used, name: 'a', count: 2, lastUsedDate: '2026-10-05' },
      { id: deletedOnly, name: 'b', count: 0, lastUsedDate: null },
      { id: never, name: 'c', count: 0, lastUsedDate: null },
    ]);
  });

  it('still reports an archived tag so the management screen can show it', async () => {
    const db = await createTestDb();
    const tag = await createTag(db, '归档前用过');
    await archiveTag(db, tag);

    expect(await tagUsage(db)).toEqual([
      { id: tag, name: '归档前用过', count: 0, lastUsedDate: null },
    ]);
  });
});

describe('setTxnTags', () => {
  it('replaces the previous set instead of appending to it', async () => {
    const { db, spend } = await fixture();
    const txn = await spend('2026-10-01');
    const a = await createTag(db, 'a');
    const b = await createTag(db, 'b');

    await setTxnTags(db, txn, [a, b]);
    expect((await getTxnTags(db, txn)).map(tag => tag.name)).toEqual(['a', 'b']);

    await setTxnTags(db, txn, [b]);
    expect((await getTxnTags(db, txn)).map(tag => tag.name)).toEqual(['b']);
    expect(await db.all('SELECT tag_id FROM txn_tag')).toEqual([{ tag_id: b }]);
  });

  it('collapses duplicates and ignores unknown tag ids', async () => {
    const { db, spend } = await fixture();
    const txn = await spend('2026-10-01');
    const a = await createTag(db, 'a');

    await setTxnTags(db, txn, [a, a, 'no-such-tag', a]);

    expect((await getTxnTags(db, txn)).map(tag => tag.name)).toEqual(['a']);
    expect(await db.all('SELECT tag_id FROM txn_tag')).toEqual([{ tag_id: a }]);
  });

  it('keeps an archived tag that was already attached but never adds one anew', async () => {
    const { db, spend } = await fixture();
    const first = await spend('2026-10-01');
    const second = await spend('2026-10-02');
    const live = await createTag(db, 'a');
    const archived = await createTag(db, 'b');

    await setTxnTags(db, first, [live, archived]);
    await archiveTag(db, archived);

    // Still listed by the caller: the historical link survives.
    await setTxnTags(db, first, [live, archived]);
    expect((await getTxnTags(db, first)).map(tag => tag.name)).toEqual(['a', 'b']);

    // Newly requested on another row: not added.
    await setTxnTags(db, second, [archived]);
    expect(await getTxnTags(db, second)).toEqual([]);

    // Omitted on a replacement: removed, like any other dropped tag.
    await setTxnTags(db, first, [live]);
    expect((await getTxnTags(db, first)).map(tag => tag.name)).toEqual(['a']);
  });

  it('clears every tag when given an empty list', async () => {
    const { db, spend } = await fixture();
    const txn = await spend('2026-10-01');
    const a = await createTag(db, 'a');
    await setTxnTags(db, txn, [a]);

    await setTxnTags(db, txn, []);

    expect(await getTxnTags(db, txn)).toEqual([]);
    expect(await db.all('SELECT tag_id FROM txn_tag')).toHaveLength(0);
  });

  it('rolls the whole replacement back when a write fails inside its transaction', async () => {
    const { db, spend } = await fixture();
    const txn = await spend('2026-10-01');
    const a = await createTag(db, 'a');
    const b = await createTag(db, 'b');
    await setTxnTags(db, txn, [a]);

    // Fail the INSERT after the DELETE has already run. Only a real
    // transaction restores the old link; an autocommit pair would lose it.
    const originalRun = db.run.bind(db);
    let injected = false;
    db.run = async (sql, params = []) => {
      if (injected && sql.includes('INSERT INTO txn_tag')) {
        injected = false;
        throw new Error('injected failure');
      }
      return originalRun(sql, params);
    };

    try {
      injected = true;
      await expect(setTxnTags(db, txn, [b])).rejects.toThrow('injected failure');
      expect((await getTxnTags(db, txn)).map(tag => tag.name)).toEqual(['a']);
    } finally {
      db.run = originalRun;
    }
  });

  it('rejects a missing or soft-deleted transaction and writes nothing', async () => {
    const { db, spend } = await fixture();
    const a = await createTag(db, 'a');
    const deleted = await spend('2026-10-01');
    await softDeleteTxn(db, deleted);

    await expect(setTxnTags(db, 'missing-txn', [a])).rejects.toThrow(/流水/);
    await expect(setTxnTags(db, deleted, [a])).rejects.toThrow(/流水/);
    expect(await db.all('SELECT tag_id FROM txn_tag')).toHaveLength(0);
  });
});

describe('getTxnTags / listTagsForTxns', () => {
  it('returns an empty list for a transaction with no tags', async () => {
    const { db, spend } = await fixture();
    const txn = await spend('2026-10-01');

    expect(await getTxnTags(db, txn)).toEqual([]);
    expect(await getTxnTags(db, 'missing-txn')).toEqual([]);
  });

  it('groups tags by transaction, keeps archived history and answers every requested id', async () => {
    const { db, spend } = await fixture();
    const first = await spend('2026-10-01');
    const second = await spend('2026-10-02');
    const bare = await spend('2026-10-03');
    const a = await createTag(db, 'a');
    const b = await createTag(db, 'b');

    await setTxnTags(db, first, [a]);
    await setTxnTags(db, second, [b]);
    await archiveTag(db, b);

    const byTxn = await listTagsForTxns(db, [first, second, bare, first]);

    expect(byTxn.size).toBe(3);
    expect(byTxn.get(first)?.map(tag => tag.name)).toEqual(['a']);
    expect(byTxn.get(second)?.map(tag => tag.name)).toEqual(['b']);
    expect(byTxn.get(bare)).toEqual([]);
    expect((await listTagsForTxns(db, [])).size).toBe(0);
  });
});
