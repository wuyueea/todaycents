import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  CategoryPicker,
  CategorySheet,
  buildCategoryTree,
} from '../../src/components/CategoryPicker';
import type { Category } from '../../src/db/repos/categories';

/**
 * The category chooser is a two-level bottom sheet. Categories are a flat list
 * in the database (parentId is the only edge), so the tree is built here.
 * Archived rows and the system 未分类 sink are never offered.
 */

const SYSTEM: Category = {
  id: 'uncategorized',
  parentId: null,
  name: '未分类',
  kind: 'expense',
  sort: 9999,
  archivedAt: null,
};

const SPORT: Category = {
  id: 'c-sport',
  parentId: null,
  name: '运动',
  kind: 'expense',
  sort: 0,
  archivedAt: null,
};

const BADMINTON: Category = {
  id: 'c-badminton',
  parentId: SPORT.id,
  name: '羽毛球',
  kind: 'expense',
  sort: 0,
  archivedAt: null,
};

const FOOD: Category = {
  id: 'c-food',
  parentId: null,
  name: '饮食',
  kind: 'expense',
  sort: 1,
  archivedAt: null,
};

const OLD: Category = {
  id: 'c-old',
  parentId: null,
  name: '旧分类',
  kind: 'expense',
  sort: 2,
  archivedAt: '2026-10-01T00:00:00.000Z',
};

describe('buildCategoryTree', () => {
  it('lists each root in sort order followed by its children', () => {
    const cats: Category[] = [
      { ...FOOD, sort: 0 },
      { ...BADMINTON, sort: 1 },
      { ...SPORT, sort: 2 },
    ];
    const rows = buildCategoryTree(cats);
    expect(rows.map(row => row.category.name)).toEqual(['饮食', '运动', '羽毛球']);
    expect(rows.map(row => row.depth)).toEqual([0, 0, 1]);
  });

  it('hides archived rows, the system 未分类, and orphaned children', () => {
    const cats: Category[] = [
      SPORT,
      BADMINTON,
      OLD,
      SYSTEM,
      { ...FOOD, parentId: 'c-gone' },
    ];
    const rows = buildCategoryTree(cats);
    expect(rows.map(row => row.category.name)).toEqual(['运动', '羽毛球']);
  });
});

describe('CategorySheet', () => {
  it('hides 未分类 and shows the children of a chosen root indented', () => {
    const html = renderToString(
      <CategorySheet
        categories={[SPORT, BADMINTON, FOOD, SYSTEM, OLD]}
        value={BADMINTON.id}
        onChange={() => {}}
        onClose={() => {}}
      />
    ).replace(/<!-- -->/g, '');

    expect(html).toMatch(/role="dialog"/);
    expect(html).toContain('选分类');
    expect(html).toContain('data-category-id="c-sport"');
    expect(html).toContain('data-category-id="c-badminton"');
    expect(html).toContain('data-depth="1"');
    // The system sink is not a choice while recording.
    expect(html).not.toContain('未分类');
    expect(html).not.toContain('旧分类');
    // No create affordance here: that belongs to 设置 › 分类.
    expect(html).not.toContain('<input');
    // One short rule; the "why you cannot create here" essay is gone.
    expect(html).toContain('一笔一个分类。');
  });

  it('marks the selected category and names the current choice', () => {
    const html = renderToString(
      <CategorySheet
        categories={[SPORT, BADMINTON, FOOD, SYSTEM]}
        value={BADMINTON.id}
        onChange={() => {}}
        onClose={() => {}}
      />
    ).replace(/<!-- -->/g, '');
    const selected = html.match(/data-category-id="c-badminton"[^>]*/)?.[0] ?? '';
    expect(selected).toContain('aria-pressed="true"');
    expect(html).toContain('现在：羽毛球');
  });
});

describe('CategoryPicker', () => {
  it('renders the chosen category on the row trigger and keeps the sheet closed', () => {
    const html = renderToString(
      <CategoryPicker categories={[SPORT, BADMINTON]} value={SPORT.id} onChange={() => {}} />
    ).replace(/<!-- -->/g, '');

    expect(html).toContain('data-category-trigger');
    expect(html).toContain('运动');
    expect(html).not.toContain('role="dialog"');
  });

  it('says 选择分类 when nothing is chosen', () => {
    const html = renderToString(
      <CategoryPicker categories={[SPORT]} value={null} onChange={() => {}} />
    );
    expect(html).toContain('选择分类');
  });
});
