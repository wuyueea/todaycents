import { useState } from 'react';
import { UNCATEGORIZED_CATEGORY_ID } from '../db/schema';
import type { Category } from '../db/repos/categories';

/**
 * The app's category chooser: a two-level tree in the same bottom sheet as
 * 标签.
 *
 * Categories are a flat list in the database (parentId is the only edge), so
 * this component builds the tree itself: roots in the repository's sort order,
 * each followed immediately by its children. Archived rows are filtered here as
 * well as in the repository, so a caller that hand-builds a list cannot surface
 * a hidden category by accident.
 *
 * The system 未分类 category is deliberately not offered. It is a sink for rows
 * whose category was deleted, not a choice a user can make while recording; a
 * reflowed row can still name it in the field and keep it unless changed.
 */

/** The one rule the sheet has to state; exported so test and sheet cannot drift. */
export const CATEGORY_PICKER_FOOTNOTE = '一笔一个分类。';

export interface CategoryPickerProps {
  /** Live categories, both roots and children. */
  categories: readonly Category[];
  /** Selected category id, or null when nothing is chosen. */
  value: string | null;
  /**
   * Reports the chosen id. null stays in the signature so a caller can clear
   * the selection, but the picker itself never deselects: a category is
   * required, and re-tapping the chosen row is how a user confirms it.
   */
  onChange: (id: string | null) => void;
  /** The last submit was rejected because no category was chosen. */
  invalid?: boolean;
  /** Name to show for a value that is no longer in the live list (archived). */
  valueLabel?: string;
}

/** One rendered row of the flattened tree. */
export interface CategoryTreeRow {
  category: Category;
  /** 0 for a root, 1 for a child; drives the indentation via data-depth. */
  depth: 0 | 1;
}

/** Repository order, with the name as a stable tiebreak. */
function bySort(a: Category, b: Category): number {
  return a.sort - b.sort || a.name.localeCompare(b.name, 'zh-Hans-CN');
}

/**
 * Flattens the two-level tree into render order.
 *
 * A child whose parent is missing or archived is not rendered: showing it as a
 * root would silently promote it to a level it was never given. The system
 * 未分类 row is never a rendering choice, even though listCategories returns it.
 */
export function buildCategoryTree(categories: readonly Category[]): CategoryTreeRow[] {
  const live = categories.filter(
    category =>
      category.archivedAt === null && category.id !== UNCATEGORIZED_CATEGORY_ID
  );
  const roots = live.filter(category => category.parentId === null).sort(bySort);
  const rows: CategoryTreeRow[] = [];

  for (const root of roots) {
    rows.push({ category: root, depth: 0 });
    const children = live.filter(category => category.parentId === root.id).sort(bySort);
    for (const child of children) rows.push({ category: child, depth: 1 });
  }
  return rows;
}

function childrenCount(categories: readonly Category[], rootId: string): number {
  return categories.filter(
    category =>
      category.archivedAt === null &&
      category.id !== UNCATEGORIZED_CATEGORY_ID &&
      category.parentId === rootId
  ).length;
}

export interface CategorySheetProps {
  /** Live categories, both roots and children. */
  categories: readonly Category[];
  value: string | null;
  onChange(id: string): void;
  onClose(): void;
}

/**
 * The two-level sheet. Roots and their children share one list, so picking a
 * child is one tap from the field; there is no create affordance here, because
 * the taxonomy is meant to be stable and is edited in 设置 › 分类.
 */
export function CategorySheet({ categories, value, onChange, onClose }: CategorySheetProps) {
  const rows = buildCategoryTree(categories);
  const current = categories.find(category => category.id === value) ?? null;

  return (
    <div
      className="sheet category-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="category-sheet-title"
    >
      <div className="sheet__scrim" aria-hidden="true" onClick={onClose} />
      <div className="sheet__panel">
        <div className="sheet__head">
          <h2 className="sheet__title" id="category-sheet-title">
            选分类
          </h2>
          <span className="sheet__version">现在：{current?.name ?? '未选'}</span>
        </div>

        <div className="category-sheet__cats">
          {rows.length === 0 ? (
            <p className="category-sheet__empty">还没有分类</p>
          ) : (
            rows.map(({ category, depth }) => {
              const selected = category.id === value;
              const count = depth === 0 ? childrenCount(categories, category.id) : 0;
              return (
                <button
                  key={category.id}
                  type="button"
                  className={
                    selected
                      ? 'category-sheet__row is-selected'
                      : 'category-sheet__row'
                  }
                  data-category-id={category.id}
                  data-depth={String(depth)}
                  aria-pressed={selected}
                  onClick={() => {
                    onChange(category.id);
                    onClose();
                  }}
                >
                  <span>{category.name}</span>
                  {count > 0 && (
                    <span className="category-sheet__count">{count} 个二级</span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <p className="category-sheet__note">{CATEGORY_PICKER_FOOTNOTE}</p>

        <button className="sheet__secondary" type="button" onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  );
}

/**
 * The 分类 field row plus its sheet. The trigger names the current category;
 * tapping it opens the tree. The sheet closes as soon as a row is chosen.
 */
export function CategoryPicker({
  categories,
  value,
  onChange,
  invalid = false,
  valueLabel,
}: CategoryPickerProps) {
  const [open, setOpen] = useState(false);
  const current = categories.find(category => category.id === value) ?? null;
  const label = current?.name ?? valueLabel ?? '选择分类';

  return (
    <>
      <button
        className="add-value"
        type="button"
        data-category-trigger="true"
        aria-label={`分类：${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={invalid ? 'true' : undefined}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>

      {open && (
        <CategorySheet
          categories={categories}
          value={value}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
