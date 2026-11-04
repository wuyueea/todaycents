import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import CategoriesScreen, {
  CategoryMenuSheet,
  CategoryPurgeBlockedSheet,
  CategoryPurgeSheet,
  CategoryRetireSheet,
  buildCategoryRows,
  loadCategoriesData,
  selectActiveUndo,
} from '../../src/screens/CategoriesScreen';
import type { CategoriesData } from '../../src/screens/CategoriesScreen';
import { PURGE_UNDO_MS } from '../../src/db/repos/purge';
import type { PurgeUndoRecord } from '../../src/db/repos/purge';
import type { Category, CategoryPurgeInspection } from '../../src/db/repos/categories';
import { createTestDb } from '../helpers/nodeDb';

const store = vi.hoisted(() => ({
  data: null as CategoriesData | null,
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

function category(overrides: Partial<Category> & Pick<Category, 'id' | 'name'>): Category {
  return {
    parentId: null,
    kind: 'expense',
    sort: 0,
    archivedAt: null,
    ...overrides,
  };
}

const SYSTEM = category({ id: 'uncategorized', name: '未分类', sort: 9999 });
const SPORT = category({ id: 'c-sport', name: '运动', sort: 3 });
const BADMINTON = category({
  id: 'c-badminton',
  name: '羽毛球',
  sort: 4,
  parentId: SPORT.id,
});
const FOOD = category({ id: 'c-food', name: '饮食', sort: 0 });
const SALARY = category({ id: 'c-salary', name: '生活费', sort: 0, kind: 'income' });
const OLD = category({
  id: 'c-old',
  name: '娱乐',
  sort: 6,
  archivedAt: '2026-09-01T00:00:00.000Z',
});

function inspection(overrides: Partial<CategoryPurgeInspection> = {}): CategoryPurgeInspection {
  return {
    purgeable: true,
    archived: true,
    liveTxnCount: 0,
    txnCount: 0,
    deletedTxnCount: 0,
    templateCount: 0,
    liveChildCount: 0,
    childCount: 0,
    hintCount: 0,
    ...overrides,
  };
}

function categoriesData(): CategoriesData {
  return { categories: [FOOD, SPORT, BADMINTON, SALARY, OLD, SYSTEM], undo: null };
}

function renderScreen(): string {
  return renderToString(
    <MemoryRouter initialEntries={['/settings/categories']}>
      <CategoriesScreen />
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

function render(node: React.ReactElement): string {
  return renderToString(node).replace(/<!-- -->/g, '');
}

describe('CategoriesScreen', () => {
  it('renders two levels with indented children and both kinds', () => {
    store.data = categoriesData();
    const html = renderScreen();

    expect(html).toContain('<h1>分类</h1>');
    expect(html).toContain('data-category-id="c-sport"');
    expect(html).toContain('data-category-id="c-badminton"');
    expect(html).toContain('data-depth="1"');
    expect(html).toContain('生活费');
    expect(html).toContain('新增分类');
    expect(html).toContain('href="/settings"');
  });

  it('puts the system 未分类 row last, marks it 系统 and gives it no menu', () => {
    store.data = categoriesData();
    const html = renderScreen();

    const systemAt = html.indexOf('data-category-id="uncategorized"');
    expect(systemAt).toBeGreaterThan(-1);
    expect(systemAt).toBeGreaterThan(html.indexOf('data-category-id="c-old"'));
    expect(systemAt).toBeGreaterThan(html.indexOf('data-category-id="c-salary"'));
    expect(html).toContain('系统');
    expect(html).not.toContain('aria-label="未分类的菜单"');
  });

  it('shows an archived category with its kind, 恢复 and 彻底删除', () => {
    store.data = categoriesData();
    const html = renderScreen();

    expect(html).toContain('娱乐');
    expect(html).toContain('支出 · 已归档');
    expect(html).toContain('恢复');
    expect(html).toContain('aria-label="娱乐的菜单"');
    expect(html).not.toContain('历史流水还在');
  });

  it('restores the purge undo toast saved before the app restarted', () => {
    store.data = {
      categories: categoriesData().categories,
      undo: {
        kind: 'category',
        targetId: SPORT.id,
        label: SPORT.name,
        expiresAt: Date.now() + PURGE_UNDO_MS,
      },
    };
    const html = renderScreen();

    expect(html).toContain('「运动」已彻底删除');
    expect(html).toContain('10 秒内可撤销');
    expect(html).toContain('撤销');
    store.data = categoriesData();
  });

  it('loads a pending purge undo together with the categories', async () => {
    const db = await createTestDb();
    await db.run(
      `INSERT INTO purge_undo (id, kind, target_id, label, payload_json, expires_at, created_at)
       VALUES (1, 'category', ?, ?, ?, ?, ?)`,
      [
        SPORT.id,
        SPORT.name,
        JSON.stringify({
          category: [
            {
              id: SPORT.id,
              parent_id: null,
              name: SPORT.name,
              kind: SPORT.kind,
              sort: SPORT.sort,
              archived_at: '2026-10-01T00:00:00.000Z',
            },
          ],
          hints: [],
        }),
        Date.now() + PURGE_UNDO_MS,
        new Date().toISOString(),
      ]
    );

    const data = await loadCategoriesData(db);

    expect(data.undo).toMatchObject({ kind: 'category', targetId: SPORT.id, label: SPORT.name });
  });

  it('does not surface a pending tag purge on the category screen', async () => {
    const db = await createTestDb();
    await db.run(
      `INSERT INTO purge_undo (id, kind, target_id, label, payload_json, expires_at, created_at)
       VALUES (1, 'tag', 't1', '夜宵', '{"tag":[{"id":"t1","name":"夜宵","color":null,"archived_at":"2026-10-01T00:00:00.000Z"}]}', ?, ?)`,
      [Date.now() + PURGE_UNDO_MS, new Date().toISOString()]
    );

    expect((await loadCategoriesData(db)).undo).toBeNull();
  });

  it('survives a missing database with a readable line, not a crash', () => {
    store.data = null;
    store.error = new Error('no native sqlite');
    const html = renderScreen();

    expect(html).toContain('<h1>分类</h1>');
    expect(html).toContain('分类暂时打不开');
    store.error = null;
  });
});

describe('buildCategoryRows', () => {
  it('orders roots by sort, follows each with its children, and drops a child whose parent is not live', () => {
    const rows = buildCategoryRows([SPORT, BADMINTON, FOOD, SALARY, SYSTEM], 'expense');

    expect(rows.map(row => [row.category.name, row.depth])).toEqual([
      ['饮食', 0],
      ['运动', 0],
      ['羽毛球', 1],
    ]);
  });
});

describe('CategoryMenuSheet', () => {
  it('offers 断联并归档 for a live category and says how many rows move', () => {
    const html = render(
      <CategoryMenuSheet
        category={SPORT}
        inspection={inspection({ archived: false, liveTxnCount: 9, txnCount: 9 })}
        onRename={() => {}}
        onAddChild={() => {}}
        onArchive={() => {}}
        onRetire={() => {}}
        onPurge={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain('改名');
    expect(html).toContain('加二级分类');
    expect(html).toContain('归档');
    expect(html).toContain('断联并归档');
    expect(html).toContain('9 笔移到「未分类」，分类收进已归档');
    expect(html).toContain('category-menu__danger');
    expect(html).not.toContain('彻底删除');
    expect(html).toContain('9 笔');
  });

  it('says 没有在用的流水 when the live count is zero', () => {
    const html = render(
      <CategoryMenuSheet
        category={SPORT}
        inspection={inspection({ archived: false })}
        onRename={() => {}}
        onArchive={() => {}}
        onRetire={() => {}}
        onPurge={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain('没有在用的流水，分类收进已归档');
    expect(html).toContain('0 笔');
  });

  it('disables 断联并归档 while the counts are still loading', () => {
    const html = render(
      <CategoryMenuSheet
        category={SPORT}
        inspection={null}
        onRename={() => {}}
        onArchive={() => {}}
        onRetire={() => {}}
        onPurge={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain('正在数…');
    expect(html).toContain('正在数流水…');
    expect(html).toContain('disabled');
  });

  it('offers 恢复 and 彻底删除 for an archived category', () => {
    const html = render(
      <CategoryMenuSheet
        category={OLD}
        inspection={inspection({ txnCount: 3, liveTxnCount: 0 })}
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
    expect(html).toContain('只对没有历史的归档分类可用');
    expect(html).not.toContain('断联并归档');
  });
});

describe('CategoryRetireSheet', () => {
  it('states the move, the archive and that undo cannot bring the rows back', () => {
    const html = render(
      <CategoryRetireSheet
        categoryName="运动"
        inspection={inspection({ archived: false, liveTxnCount: 9, deletedTxnCount: 2, childCount: 1 })}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain('断联并归档');
    expect(html).toContain(
      '「运动」下的 9 笔流水会移到「未分类」，金额和日期都不变；「运动」及 1 个二级分类会收进「已归档」。'
    );
    expect(html).toContain('已删除的 2 笔流水仍保留原分类，仍算历史');
    expect(html).toContain('这个操作不能撤销');
    expect(html).toContain('移到「未分类」的流水不会跟着回来');
    expect(html).toContain('sheet__danger');
    expect(html).toMatch(/role="dialog"/);
  });

  it('drops the child clause and the deleted note when they do not apply', () => {
    const html = render(
      <CategoryRetireSheet
        categoryName="运动"
        inspection={inspection({ archived: false })}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).not.toContain('二级分类');
    expect(html).not.toContain('已删除的');
  });
});

describe('CategoryPurgeBlockedSheet', () => {
  it('lists every reason the archive still counts as history', () => {
    const html = render(
      <CategoryPurgeBlockedSheet
        categoryName="娱乐"
        inspection={inspection({ txnCount: 4, deletedTxnCount: 1, templateCount: 2, liveChildCount: 3 })}
        onClose={() => {}}
      />
    );

    expect(html).toContain('不能彻底删除');
    expect(html).toContain('「娱乐」还有历史，不能从数据库里删除。');
    expect(html).toContain('还有 4 笔流水用过它（其中 1 笔已删除）。');
    expect(html).toContain('还有 2 个模板在用它。');
    expect(html).toContain('下面还有 3 个未归档的二级分类。');
    expect(html).toContain('有历史的分类只能保持归档');
    expect(html).toContain('知道了');
    expect(html).not.toContain('sheet__danger');
  });
});

describe('CategoryPurgeSheet', () => {
  it('says the deletion affects no entries and offers a ten-second undo', () => {
    const html = render(
      <CategoryPurgeSheet
        categoryName="娱乐"
        inspection={inspection({ childCount: 2, hintCount: 1 })}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain('彻底删除');
    expect(html).toContain('已归档');
    expect(html).toContain(
      '「娱乐」及 2 个二级分类会从数据库里删除。这个分类没有任何流水或模板，删除不会影响一笔账。'
    );
    expect(html).toContain('同时会清掉 1 条固定支出候选。');
    expect(html).toContain('10 秒内可以撤销');
    expect(html).toContain('同时只保留最近一次彻底删除的撤销');
    expect(html).toContain('sheet__danger');
  });
});

describe('selectActiveUndo', () => {
  const record = (targetId: string, expiresAt: number): PurgeUndoRecord => ({
    kind: 'category',
    targetId,
    label: targetId,
    expiresAt,
  });

  it('prefers the purge result while the stored copy is still loading', () => {
    const pending = record('sport', Date.now() + 2000);
    expect(selectActiveUndo(pending, null, null)).toBe(pending);
  });

  it('shows a stored record until its key is dismissed', () => {
    const stored = record('sport', Date.now() + 2000);
    expect(selectActiveUndo(null, stored, null)).toBe(stored);
    expect(selectActiveUndo(null, stored, 'category\u0000sport\u0000' + stored.expiresAt)).toBeNull();
  });

  it('does not let an old dismissal hide a newer purge', () => {
    const newer = record('sport', Date.now() + 3000);
    const oldKey = 'category\u0000sport\u0000' + (newer.expiresAt - 1000);
    expect(selectActiveUndo(null, newer, oldKey)).toBe(newer);
  });
});
