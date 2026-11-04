import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import TagsScreen, {
  TagMenuSheet,
  TagPurgeBlockedSheet,
  TagPurgeSheet,
  TagRetireSheet,
  planTagCreate,
  tagLastUsedLabel,
} from '../../src/screens/TagsScreen';
import type { TagsData } from '../../src/screens/TagsScreen';
import { PURGE_UNDO_MS } from '../../src/db/repos/purge';
import type { Tag, TagPurgeInspection } from '../../src/db/repos/tags';

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

function inspection(overrides: Partial<TagPurgeInspection> = {}): TagPurgeInspection {
  return {
    purgeable: true,
    archived: true,
    linkCount: 0,
    deletedLinkCount: 0,
    ...overrides,
  };
}

function tagsData(): TagsData {
  return {
    tags: [NIGHT, MOVE],
    usage: [
      { id: NIGHT.id, name: NIGHT.name, count: 38, lastUsedDate: '2026-10-18' },
      { id: MOVE.id, name: MOVE.name, count: 12, lastUsedDate: '2026-08-21' },
    ],
    undo: null,
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
    store.data = { tags: [], usage: [], undo: null };
    const html = renderScreen();

    expect(html).toContain('还没有标签');
    // The how-to paragraph was removed; the create field is the instruction.
    expect(html).not.toContain('不用先想好体系');
    expect(html).toContain('新建标签');
  });

  it('restores the purge undo toast saved before the app restarted', () => {
    store.data = {
      ...tagsData(),
      undo: {
        kind: 'tag',
        targetId: NIGHT.id,
        label: NIGHT.name,
        expiresAt: Date.now() + PURGE_UNDO_MS,
      },
    };
    const html = renderScreen();

    expect(html).toContain('标签「夜宵」已彻底删除');
    expect(html).toContain('10 秒内可撤销');
    expect(html).toContain('撤销');
    store.data = tagsData();
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

describe('TagMenuSheet', () => {
  it('offers 断联并归档 for a live tag instead of a delete action', () => {
    const html = render(
      <TagMenuSheet
        tag={NIGHT}
        count={38}
        inspection={inspection({ archived: false, linkCount: 38 })}
        onRename={() => {}}
        onArchive={() => {}}
        onRetire={() => {}}
        onPurge={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain('改名');
    expect(html).toContain('归档');
    expect(html).toContain('断联并归档');
    expect(html).toContain('删掉全部关联，标签收进已归档');
    expect(html).toContain('38 次');
    expect(html).not.toContain('删除关联');
    expect(html).not.toContain('彻底删除');
    expect(html).toMatch(/role="dialog"/);
  });

  it('disables 断联并归档 while the links are still being read', () => {
    const html = render(
      <TagMenuSheet
        tag={NIGHT}
        count={38}
        inspection={null}
        onRename={() => {}}
        onArchive={() => {}}
        onRetire={() => {}}
        onPurge={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain('disabled');
  });

  it('offers 恢复 and 彻底删除 for an archived tag, and says it is archived', () => {
    const html = render(
      <TagMenuSheet
        tag={MOVE}
        count={12}
        inspection={inspection({ linkCount: 12 })}
        onRename={() => {}}
        onUnarchive={() => {}}
        onRetire={() => {}}
        onPurge={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain('已归档');
    expect(html).toContain('恢复');
    expect(html).toContain('彻底删除');
    expect(html).toContain('只对没有关联的归档标签可用');
    expect(html).not.toContain('删除关联');
    expect(html).not.toContain('断联并归档');
  });
});

describe('TagRetireSheet', () => {
  it('confirms that the transactions stay and 恢复 will not bring the links back', () => {
    const html = render(
      <TagRetireSheet
        tagName="夜宵"
        inspection={inspection({ archived: false, linkCount: 38, deletedLinkCount: 2 })}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain('断联并归档');
    expect(html).toContain(
      '「夜宵」的 38 条流水关联会被删除（其中 2 条在已删除流水上）；流水本身一笔都不会少，金额和日期都不变。标签会收进「已归档」。'
    );
    expect(html).toContain('这个操作不能撤销');
    expect(html).toContain('恢复标签，也不会恢复这些关联');
    expect(html).toContain('38 条关联');
    expect(html).toContain('sheet__danger');
  });

  it('omits the deleted-link parenthesis when nothing is deleted', () => {
    const html = render(
      <TagRetireSheet
        tagName="夜宵"
        inspection={inspection({ archived: false, linkCount: 38 })}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).not.toContain('在已删除流水上');
  });
});

describe('TagPurgeBlockedSheet', () => {
  it('names the links, including the ones on deleted transactions', () => {
    const html = render(
      <TagPurgeBlockedSheet
        tagName="搬家"
        inspection={inspection({ linkCount: 12, deletedLinkCount: 3 })}
        onClose={() => {}}
      />
    );

    expect(html).toContain('不能彻底删除');
    expect(html).toContain('「搬家」还关联着 12 笔流水（其中 3 笔已删除）。');
    expect(html).toContain('有历史的标签只能保持归档');
    expect(html).toContain('彻底删除只适用于没有任何关联的归档标签。');
    expect(html).toContain('知道了');
  });
});

describe('TagPurgeSheet', () => {
  it('says the deletion affects no entry and offers a ten-second undo', () => {
    const html = render(
      <TagPurgeSheet tagName="搬家" busy={false} onConfirm={() => {}} onCancel={() => {}} />
    );

    expect(html).toContain('彻底删除');
    expect(html).toContain('已归档');
    expect(html).toContain('「搬家」没有任何流水关联，会从数据库里删除。删除不会影响任何一笔账。');
    expect(html).toContain('10 秒内可以撤销');
    expect(html).toContain('同时只保留最近一次彻底删除的撤销');
    expect(html).toContain('sheet__danger');
  });
});
