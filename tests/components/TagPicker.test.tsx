import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { TagPicker, TagSheet, createTagForPicker } from '../../src/components/TagPicker';
import { createTestDb } from '../helpers/nodeDb';
import { archiveTag, createTag, listTags } from '../../src/db/repos/tags';
import type { Tag } from '../../src/db/repos/tags';

/**
 * TagPicker is a pure render component for the 记账/编辑 screens: the caller
 * owns the selected ids, the sheet only renders live tags and reports taps.
 * SSR therefore covers the row's three display states and the sheet's content
 * without a browser.
 */

const NIGHT: Tag = { id: 'tag-night', name: '夜宵', color: null, archivedAt: null };
const ROOMMATE: Tag = { id: 'tag-roommate', name: '和室友', color: null, archivedAt: null };
const ARCHIVED: Tag = {
  id: 'tag-move',
  name: '搬家',
  color: null,
  archivedAt: '2026-10-01T00:00:00.000Z',
};

function renderRow(value: string[], tags: Tag[] = [NIGHT, ROOMMATE, ARCHIVED]): string {
  return renderToString(
    <TagPicker db={null} tags={tags} value={value} onChange={() => {}} />
  ).replace(/<!-- -->/g, '');
}

describe('TagPicker row', () => {
  it('says 添加标签 when nothing is chosen', () => {
    const html = renderRow([]);
    expect(html).toContain('data-tag-trigger');
    expect(html).toContain('添加标签');
  });

  it('shows the name when exactly one tag is chosen', () => {
    const html = renderRow([NIGHT.id]);
    expect(html).toContain('夜宵');
    expect(html).not.toContain('等');
  });

  it('summarizes two or more as 名字 等 N 个', () => {
    const html = renderRow([NIGHT.id, ROOMMATE.id]);
    expect(html).toContain('夜宵 等 2 个');
    // The row is a summary, not the full list.
    expect(html).not.toContain('和室友');
  });

  it('does not open the sheet on first render', () => {
    const html = renderRow([]);
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('选标签');
  });
});

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

describe('TagSheet', () => {
  it('offers live tags as multi-select chips and never offers archived tags', () => {
    const html = renderToString(
      <TagSheet
        tags={[NIGHT, ROOMMATE, ARCHIVED]}
        selectedIds={[NIGHT.id]}
        onToggle={() => {}}
        onCreate={async () => null}
        onClose={() => {}}
      />
    ).replace(/<!-- -->/g, '');

    expect(html).toMatch(/role="dialog"/);
    expect(html).toContain('选标签');
    expect(html).toContain('夜宵');
    expect(html).toContain('和室友');
    expect(html).not.toContain('搬家');
    expect(html).toContain('aria-pressed="true"');
  });

  // A retired tag already on the row must stay removable: hiding it would
  // leave the mistake permanent and unexplainable.
  it('keeps an attached archived tag visible so it can be taken off', () => {
    const html = renderToString(
      <TagSheet
        tags={[NIGHT, ARCHIVED]}
        selectedIds={[ARCHIVED.id]}
        onToggle={() => {}}
        onCreate={async () => null}
        onClose={() => {}}
      />
    ).replace(/<!-- -->/g, '');

    expect(html).toContain('搬家');
    expect(html).toContain('已归档');
    expect(html).toMatch(/data-tag-id="tag-move"[^>]*aria-pressed="true"/);
  });

  it('has an inline create field and no usage counts', () => {
    const html = renderToString(
      <TagSheet
        tags={[NIGHT]}
        selectedIds={[]}
        onToggle={() => {}}
        onCreate={async () => null}
        onClose={() => {}}
      />
    );
    expect(html).toContain('新建标签');
    expect(html).toContain('<input');
    expect(html).not.toMatch(/\d+\s*次/);
  });
});
