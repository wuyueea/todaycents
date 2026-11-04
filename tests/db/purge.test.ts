import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/nodeDb';
import {
  archiveCategory,
  createCategory,
  purgeCategory,
} from '../../src/db/repos/categories';
import { archiveTag, createTag, purgeTag } from '../../src/db/repos/tags';
import {
  PURGE_UNDO_MS,
  readPurgeUndo,
  undoPurge,
  writePurgeUndo,
} from '../../src/db/repos/purge';

async function archivedCategory(db: Awaited<ReturnType<typeof createTestDb>>, name: string) {
  const id = await createCategory(db, { name, kind: 'expense' });
  await archiveCategory(db, id);
  return id;
}

describe('purgeundo: read and write', () => {
  it('stores one record, checks the shape on read and clears it only after a successful undo', async () => {
    const db = await createTestDb();
    const id = await archivedCategory(db, '临时');
    const result = await purgeCategory(db, id);

    const record = await readPurgeUndo(db);
    expect(record).toEqual({
      kind: 'category',
      targetId: id,
      label: '临时',
      expiresAt: result.undo.expiresAt,
    });
    expect(record!.expiresAt).toBeGreaterThan(Date.now());
    expect(record!.expiresAt).toBeLessThanOrEqual(Date.now() + PURGE_UNDO_MS);

    await undoPurge(db, {
      kind: 'category',
      targetId: id,
      expiresAt: result.undo.expiresAt,
    });

    expect(await readPurgeUndo(db)).toBeNull();
    expect(await db.all('SELECT id FROM purge_undo')).toHaveLength(0);
  });

  it('ignores an expired record but leaves it for the next purge to replace', async () => {
    const db = await createTestDb();
    const expireAt = Date.now() - 1;
    await writePurgeUndo(db, {
      kind: 'tag',
      targetId: 't-old',
      label: '旧',
      expiresAt: expireAt,
      payload: { tag: [{ id: 't-old', name: '旧', color: null, archived_at: '2026-01-01T00:00:00.000Z' }] },
    });

    expect(await readPurgeUndo(db)).toBeNull();
    expect(await db.all('SELECT id FROM purge_undo')).toHaveLength(1);
  });

  it('refuses an undo after the window and keeps the stale record', async () => {
    const db = await createTestDb();
    const expiresAt = Date.now() - 1;
    await writePurgeUndo(db, {
      kind: 'tag',
      targetId: 't-old',
      label: '旧',
      expiresAt,
      payload: { tag: [{ id: 't-old', name: '旧', color: null, archived_at: '2026-01-01T00:00:00.000Z' }] },
    });

    await expect(
      undoPurge(db, { kind: 'tag', targetId: 't-old', expiresAt })
    ).rejects.toThrow('撤销窗口已过');
    expect(await db.all('SELECT id FROM purge_undo')).toHaveLength(1);
  });

  it('refuses a record whose payload cannot be parsed', async () => {
    const db = await createTestDb();
    const id = await archivedCategory(db, '临时');
    const result = await purgeCategory(db, id);
    await db.run("UPDATE purge_undo SET payload_json = '{not json' WHERE id = 1");

    expect(await readPurgeUndo(db)).toBeNull();
    await expect(
      undoPurge(db, { kind: 'category', targetId: id, expiresAt: result.undo.expiresAt })
    ).rejects.toThrow('撤销记录已损坏');
    expect(await db.all('SELECT id FROM purge_undo')).toHaveLength(1);
  });

  it('refuses a payload with the wrong shape before inserting anything', async () => {
    const db = await createTestDb();
    const id = await archivedCategory(db, '临时');
    const result = await purgeCategory(db, id);
    await db.run(
      `UPDATE purge_undo SET payload_json = '{"category":[{"id":"x"}],"hints":[]}' WHERE id = 1`
    );

    expect(await readPurgeUndo(db)).toBeNull();
    await expect(
      undoPurge(db, { kind: 'category', targetId: id, expiresAt: result.undo.expiresAt })
    ).rejects.toThrow('撤销记录已损坏');
  });

  it('refuses an empty category payload instead of offering an undo that restores nothing', async () => {
    const db = await createTestDb();
    const id = await archivedCategory(db, '临时');
    const result = await purgeCategory(db, id);
    await db.run(
      `UPDATE purge_undo SET payload_json = '{"category":[],"hints":[]}' WHERE id = 1`
    );

    expect(await readPurgeUndo(db)).toBeNull();
    await expect(
      undoPurge(db, { kind: 'category', targetId: id, expiresAt: result.undo.expiresAt })
    ).rejects.toThrow('撤销记录已损坏');
  });

  it('refuses an empty tag payload instead of offering an undo that restores nothing', async () => {
    const db = await createTestDb();
    const tag = await createTag(db, '夜宵');
    await archiveTag(db, tag);
    const result = await purgeTag(db, tag);
    await db.run(`UPDATE purge_undo SET payload_json = '{"tag":[]}' WHERE id = 1`);

    expect(await readPurgeUndo(db)).toBeNull();
    await expect(
      undoPurge(db, { kind: 'tag', targetId: tag, expiresAt: result.undo.expiresAt })
    ).rejects.toThrow('撤销记录已损坏');
  });

  it('refuses a record that a newer purge replaced', async () => {
    const db = await createTestDb();
    const first = await archivedCategory(db, '甲');
    const second = await archivedCategory(db, '乙');
    const firstResult = await purgeCategory(db, first);
    const secondResult = await purgeCategory(db, second);

    expect(await db.all('SELECT id FROM purge_undo')).toHaveLength(1);
    expect(await readPurgeUndo(db)).toMatchObject({ targetId: second });

    await expect(
      undoPurge(db, { kind: 'category', targetId: first, expiresAt: firstResult.undo.expiresAt })
    ).rejects.toThrow('撤销记录已更新');
    await expect(
      undoPurge(db, {
        kind: 'category',
        targetId: second,
        expiresAt: secondResult.undo.expiresAt + 1,
      })
    ).rejects.toThrow('撤销记录已更新');
  });

  it('refuses a payload whose first object is not the row target', async () => {
    const db = await createTestDb();
    const target = await archivedCategory(db, '甲');
    const other = await archivedCategory(db, '乙');
    const result = await purgeCategory(db, target);
    const row = await db.get<{ payload_json: string }>(
      'SELECT payload_json FROM purge_undo WHERE id = 1'
    );
    const payload = JSON.parse(row!.payload_json) as {
      category: Array<{ id: string }>;
      hints: unknown[];
    };
    payload.category[0].id = other;
    await db.run('UPDATE purge_undo SET payload_json = ? WHERE id = 1', [JSON.stringify(payload)]);

    expect(await readPurgeUndo(db)).toBeNull();
    await expect(
      undoPurge(db, { kind: 'category', targetId: target, expiresAt: result.undo.expiresAt })
    ).rejects.toThrow('撤销记录已损坏');
    expect(await db.all('SELECT id FROM category WHERE id = ?', [other])).toHaveLength(1);
  });

  it('refuses a record whose kind does not match the target', async () => {
    const db = await createTestDb();
    const tag = await createTag(db, '夜宵');
    await archiveTag(db, tag);
    const result = await purgeTag(db, tag);

    await expect(
      undoPurge(db, { kind: 'category', targetId: tag, expiresAt: result.undo.expiresAt })
    ).rejects.toThrow('撤销记录已更新');
  });
});

describe('purgeundo: rollback', () => {
  it('keeps the undo record when a tag name was taken while the bar was showing', async () => {
    const db = await createTestDb();
    const tag = await createTag(db, '夜宵');
    await archiveTag(db, tag);
    const result = await purgeTag(db, tag);

    await createTag(db, '夜宵');

    await expect(
      undoPurge(db, { kind: 'tag', targetId: tag, expiresAt: result.undo.expiresAt })
    ).rejects.toThrow('已有同名标签，请换一个名字');

    expect(await db.all('SELECT id FROM tag WHERE id = ?', [tag])).toHaveLength(0);
    expect(await readPurgeUndo(db)).toMatchObject({ kind: 'tag', targetId: tag });
  });
});

describe('purgeundo: a second purge replaces the first', () => {
  it('keeps only the latest record and the older target stays deleted', async () => {
    const db = await createTestDb();
    const category = await archivedCategory(db, '分类');
    const tag = await createTag(db, '标签');
    await archiveTag(db, tag);

    await purgeCategory(db, category);
    const latest = await purgeTag(db, tag);

    expect(await db.all('SELECT id FROM purge_undo')).toHaveLength(1);
    expect(await readPurgeUndo(db)).toMatchObject({ kind: 'tag', targetId: tag });
    expect(await db.all('SELECT id FROM category WHERE id = ?', [category])).toHaveLength(0);

    await undoPurge(db, { kind: 'tag', targetId: tag, expiresAt: latest.undo.expiresAt });
    expect(await db.all('SELECT id FROM tag WHERE id = ?', [tag])).toHaveLength(1);
  });
});
