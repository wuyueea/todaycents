import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import CategoriesScreen, {
  CATEGORY_UNDO_MS,
  CategoryDeleteSheet,
  CategoryMenuSheet,
  CategoryUndoToast,
  buildCategoryRows,
} from '../../src/screens/CategoriesScreen';
import type { CategoriesData } from '../../src/screens/CategoriesScreen';
import type { Category } from '../../src/db/repos/categories';

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

function categoriesData(): CategoriesData {
  return { categories: [FOOD, SPORT, BADMINTON, SALARY, OLD, SYSTEM] };
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

  it('shows archived categories with 恢复 rather than a live menu', () => {
    store.data = categoriesData();
    const html = renderScreen();

    expect(html).toContain('已归档');
    expect(html).toContain('娱乐');
    expect(html).toContain('恢复');
    expect(html).toContain('aria-label="娱乐的菜单"');
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
  it('offers 改名 / 加二级分类 / 归档 / 删除, with the count the delete will move', () => {
    const html = render(
      <CategoryMenuSheet category={SPORT} txnCount={9} onRename={() => {}} onAddChild={() => {}} onArchive={() => {}} onDelete={() => {}} onCancel={() => {}} />
    );

    expect(html).toContain('改名');
    expect(html).toContain('加二级分类');
    expect(html).toContain('归档');
    expect(html).toContain('删除');
    expect(html).toContain('9 笔移到「未分类」');
    expect(html).toContain('category-menu__danger');
  });
});

describe('CategoryUndoToast', () => {
  it('offers 撤销 for ten seconds and says the window is finite', () => {
    expect(CATEGORY_UNDO_MS).toBe(10_000);
    const html = render(
      <CategoryUndoToast categoryName="运动" movedTxns={9} onUndo={() => {}} />
    );

    expect(html).toContain('「运动」已删除');
    expect(html).toContain('9 笔移到「未分类」');
    expect(html).toContain('10 秒内可撤销');
    expect(html).toContain('toast--action');
    expect(html).toContain('撤销');
  });
});

describe('CategoryDeleteSheet', () => {
  it('uses the §7 sentence with the real count and says 10 秒内可撤销', () => {
    const html = render(
      <CategoryDeleteSheet categoryName="运动" txnCount={9} busy={false} onConfirm={() => {}} onCancel={() => {}} />
    );

    expect(html).toContain('删除分类');
    expect(html).toContain(
      '「运动」下的 9 笔流水会移到 未分类，金额和日期都不变；分类本身从选择里消失。'
    );
    expect(html).toContain('10 秒内可以撤销');
    expect(html).toContain('删除');
    expect(html).toContain('sheet__danger');
    expect(html).toMatch(/role="dialog"/);
  });
});
