import { describe, it, expect } from 'vitest';
import { createTagForPicker } from '../../src/components/createTagForPicker';
import { createTestDb } from '../helpers/nodeDb';
import { archiveTag, createTag, listTags } from '../../src/db/repos/tags';

describe('createTagForPicker', () => {
  it('returns a live tag after the repository trims the name', async () => {
    const db = await createTestDb();
    const result = await createTagForPicker(db, '  夜宵  ');

    expect(result.error).toBeNull();
    expect(result.tag).toMatchObject({ name: '夜宵', archivedAt: null });
    expect((await listTags(db)).map(tag => tag.name)).toEqual(['夜宵']);
  });

  it('refuses an archived duplicate so an invisible tag is never attached', async () => {
    const db = await createTestDb();
    const id = await createTag(db, '搬家');
    await archiveTag(db, id);

    const result = await createTagForPicker(db, ' 搬家 ');

    expect(result.tag).toBeNull();
    expect(result.error).toContain('已归档');
    expect(await listTags(db)).toEqual([]);
  });

  it('surfaces the repository rule for a blank name', async () => {
    const db = await createTestDb();
    const result = await createTagForPicker(db, '   ');

    expect(result.tag).toBeNull();
    expect(result.error).toContain('不能为空');
    expect(await listTags(db)).toEqual([]);
  });
});
