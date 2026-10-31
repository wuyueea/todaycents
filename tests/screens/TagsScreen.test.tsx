import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import TagsScreen, {
  TagDeleteSheet,
  TagMenuSheet,
  planTagCreate,
  tagLastUsedLabel,
} from '../../src/screens/TagsScreen';
import type { TagsData } from '../../src/screens/TagsScreen';
import type { Tag } from '../../src/db/repos/tags';

const store = vi.hoisted(() => ({
  data: null as TagsData | null,
  error: null as Error | null,
}));

vi.mock('../../src/store/useDb', () => ({
  useDb: () => ({ db: { fake: true }, revision: 0, bump: () => {}, error: null }),
  useQuery: () => ({
    data: store.data,
    loading: store.data === null,
    error: store.error,
  }),
}));

const NIGHT: Tag = { id: 't-night', name: '夜宵', color: null, archivedAt: null };
const MOVE: Tag = {
  id: 't-move',
  name: '搬家',
  color: null,
  archivedAt: '2026-09-01T00:00:00.000Z',
};

function tagsData(): TagsData {
  return {
    tags: [NIGHT, MOVE],
    usage: [
      { id: NIGHT.id, name: NIGHT.name, count: 38, lastUsedDate: '2026-10-18' },
      { id: MOVE.id, name: MOVE.name, count: 12, lastUsedDate: '2026-08-21' },
    ],
  };
}

function renderScreen(): string {
  return renderToString(
    <MemoryRouter initialEntries={['/settings/tags']}>
      <TagsScreen />
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

function render(node: React.ReactElement): string {
  return renderToString(node).replace(/<!-- -->/g, '');
}

describe('TagsScreen', () => {
  it('shows the create field, usage counts and last use, with archived rows apart', () => {
    store.data = tagsData();
    const html = renderScreen();

    expect(html).toContain('<h1>标签</h1>');
    expect(html).toContain('新建标签');
    expect(html).toContain('夜宵');
    expect(html).toContain('38 次');
    expect(html).toContain('最近 10月18日');
    expect(html).toContain('已归档');
    expect(html).toContain('搬家');
    expect(html).toContain('data-tag-id="t-night"');
    expect(html).toContain('aria-label="夜宵的菜单"');
    expect(html).toContain('aria-label="搬家的菜单"');
    expect(html).toContain('href="/settings"');
  });

  it('says only 还没有标签 in the empty state, with the same create field', () => {
    store.data = { tags: [], usage: [] };
    const html = renderScreen();

    expect(html).toContain('还没有标签');
    // The how-to paragraph was removed; the create field is the instruction.
    expect(html).not.toContain('不用先想好体系');
    expect(html).toContain('新建标签');
  });

  it('survives a missing database with a readable line, not a crash', () => {
    store.data = null;
    store.error = new Error('no native sqlite');
    const html = renderScreen();

    expect(html).toContain('<h1>标签</h1>');
    expect(html).toContain('标签暂时打不开');
    store.error = null;
  });
});

describe('tag copy helpers', () => {
  it('trims a create draft and refuses blank or over-12-codepoint names', () => {
    expect(planTagCreate('  夜宵  ')).toEqual({ name: '夜宵', error: null });
    expect(planTagCreate('   ').name).toBeNull();
    expect(planTagCreate('   ').error).toContain('不能为空');
    expect(planTagCreate('字'.repeat(13)).name).toBeNull();
    expect(planTagCreate('字'.repeat(13)).error).toContain('12');
    expect(planTagCreate('字'.repeat(12)).name).toBe('字'.repeat(12));
  });

  it('says 今天 for today and a month-day for older use, or 还没用过', () => {
    expect(tagLastUsedLabel('2026-10-23', '2026-10-23')).toBe('最近 今天');
    expect(tagLastUsedLabel('2026-10-18', '2026-10-23')).toBe('最近 10月18日');
    expect(tagLastUsedLabel(null, '2026-10-23')).toBe('还没用过');
  });
});

describe('TagMenuSheet / TagDeleteSheet', () => {
  it('offers 改名 / 归档 / 删除关联 and says deletion only removes links', () => {
    const html = render(
      <TagMenuSheet tag={NIGHT} count={38} onRename={() => {}} onArchive={() => {}} onDelete={() => {}} onCancel={() => {}} />
    );

    expect(html).toContain('改名');
    expect(html).toContain('归档');
    expect(html).toContain('删除关联');
    expect(html).toContain('只删关联，不删流水');
    expect(html).toMatch(/role="dialog"/);
  });

  it('offers 恢复 instead of 归档 for an archived tag', () => {
    const html = render(
      <TagMenuSheet tag={MOVE} count={12} onRename={() => {}} onUnarchive={() => {}} onDelete={() => {}} onCancel={() => {}} />
    );

    expect(html).toContain('恢复');
    expect(html).not.toContain('>归档<');
  });

  it('confirms that the transactions themselves stay', () => {
    const html = render(
      <TagDeleteSheet tag={NIGHT} linkCount={38} busy={false} onConfirm={() => {}} onCancel={() => {}} />
    );

    expect(html).toContain('删除关联');
    expect(html).toContain('38 笔流水的关联会被删除');
    expect(html).toContain('流水本身一笔都不会少');
    expect(html).toContain('金额和日期都不变');
    expect(html).toContain('sheet__danger');
  });
});
