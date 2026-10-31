import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useDialogFocus } from '../components/useDialogFocus';
import type { Db } from '../db/driver';
import type { Category, CategoryKind, CategoryMove } from '../db/repos/categories';
import {
  archiveCategory,
  countCategoryTxns,
  createCategory,
  deleteCategory,
  listCategories,
  renameCategory,
  unarchiveCategory,
  undoDeleteCategory,
} from '../db/repos/categories';
import { UNCATEGORIZED_CATEGORY_ID } from '../db/schema';
import { Toast, useToast } from '../components/Toast';
import { useDb, useQuery } from '../store/useDb';

/**
 * 分类: the two-level taxonomy behind every transaction.
 *
 * Parents and children are one flat table in the database; this screen is the
 * only place that edits it. The system 未分类 category is rendered last, with a
 * 系统 mark and no menu, because renameCategory / archiveCategory /
 * deleteCategory all refuse it. Archived user rows stay on the page so 恢复 is
 * one tap away.
 *
 * Delete is the one irreversible action. It asks countCategoryTxns for the same
 * subtree count deleteCategory will move, states it in §7's sentence, and
 * keeps a ten-second 撤销 in the toast. The undo's txn ids are the ones the
 * delete actually reported, never a guess from the screen's snapshot.
 */
export interface CategoriesData {
  /** Archived user rows included; the system row is in here too. */
  categories: Category[];
}

export async function loadCategoriesData(db: Db): Promise<CategoriesData> {
  return { categories: await listCategories(db, undefined, { includeArchived: true }) };
}

/** One rendered line of the live two-level tree. */
export interface CategoryRow {
  category: Category;
  depth: 0 | 1;
}

const KIND_LABELS: Record<CategoryKind, string> = {
  expense: '支出',
  income: '收入',
};

/** 10 seconds, from §9's 撤销删除 decision. */
export const CATEGORY_UNDO_MS = 10_000;

function bySort(a: Category, b: Category): number {
  return a.sort - b.sort || a.name.localeCompare(b.name, 'zh-Hans-CN');
}

/**
 * Live roots of one kind, each followed by its live children. The system row is
 * excluded here and rendered separately, which is what keeps it last even
 * while an archived section sits above it. A child whose parent is not live is
 * omitted rather than promoted: the same rule CategoryPicker uses.
 */
export function buildCategoryRows(
  categories: readonly Category[],
  kind: CategoryKind
): CategoryRow[] {
  const live = categories.filter(
    category =>
      category.archivedAt === null &&
      category.kind === kind &&
      category.id !== UNCATEGORIZED_CATEGORY_ID
  );
  const roots = live.filter(category => category.parentId === null).sort(bySort);
  const rows: CategoryRow[] = [];

  for (const root of roots) {
    rows.push({ category: root, depth: 0 });
    const children = live.filter(category => category.parentId === root.id).sort(bySort);
    for (const child of children) rows.push({ category: child, depth: 1 });
  }
  return rows;
}

export interface CategoryMenuSheetProps {
  category: Category;
  /**
   * Live transactions delete would move, including the children's rows. null
   * while the screen is still reading the count for a just-opened sheet.
   */
  txnCount: number | null;
  onRename(): void;
  onAddChild?(): void;
  onArchive?(): void;
  onUnarchive?(): void;
  onDelete(): void;
  onCancel(): void;
}

/** 分类 · 行菜单: the one ⋯ sheet, mirroring the prototype's cat-menu. */
export function CategoryMenuSheet({
  category,
  txnCount,
  onRename,
  onAddChild,
  onArchive,
  onUnarchive,
  onDelete,
  onCancel,
}: CategoryMenuSheetProps) {
  const panelRef = useDialogFocus({ onClose: onCancel });

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="category-menu-title"
    >
      <div className="sheet__scrim" aria-hidden="true" onClick={onCancel} />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="category-menu-title">
            {category.name}
          </h2>
          <span className="sheet__version num">
            {txnCount === null ? '正在数…' : `${txnCount} 笔`}
          </span>
        </div>

        <div className="action-menu">
          <button className="action-menu__item" type="button" onClick={onRename}>
            改名
            <span>历史流水一起改</span>
          </button>
          {category.archivedAt === null && category.parentId === null && (
            <button className="action-menu__item" type="button" onClick={onAddChild}>
              加二级分类
              <span>最多两级</span>
            </button>
          )}
          {category.archivedAt === null ? (
            <button className="action-menu__item" type="button" onClick={onArchive}>
              归档
              <span>从记账选择里收起</span>
            </button>
          ) : (
            <button className="action-menu__item" type="button" onClick={onUnarchive}>
              恢复
              <span>回到记账选择</span>
            </button>
          )}
          <button
            className="action-menu__item action-menu__item--danger category-menu__danger"
            type="button"
            onClick={onDelete}
          >
            删除
            <span>
              {txnCount === null ? '正在数流水…' : `${txnCount} 笔移到「未分类」`}
            </span>
          </button>
        </div>

        <button className="sheet__secondary" type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

export interface CategoryDeleteSheetProps {
  categoryName: string;
  txnCount: number;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * 删除分类: §7's sentence with the real count, then a danger-outline 删除.
 * The note states the undo window without promising that it lasts forever.
 */
export function CategoryDeleteSheet({
  categoryName,
  txnCount,
  busy,
  onConfirm,
  onCancel,
}: CategoryDeleteSheetProps) {
  const panelRef = useDialogFocus({
    onClose: onCancel,
    initial: 'last',
    canClose: () => !busy,
  });

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="category-delete-title"
    >
      <div className="sheet__scrim" aria-hidden="true" onClick={onCancel} />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="category-delete-title">
            删除分类
          </h2>
          <span className="sheet__version num">{txnCount} 笔</span>
        </div>

        <p className="sheet__text">
          「{categoryName}」下的 {txnCount} 笔流水会移到 未分类，金额和日期都不变；分类本身从选择里消失。
        </p>
        <p className="sheet__note">
          删除后 10 秒内可以撤销；窗口期过后，这些流水会留在「未分类」，分类也不会自己回来。
        </p>

        <button className="sheet__danger" type="button" onClick={onConfirm} disabled={busy}>
          删除
        </button>
        <button className="sheet__secondary" type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </div>
  );
}

export interface CategoryUndoToastProps {
  categoryName: string;
  movedTxns: number;
  onUndo(): void;
}

/**
 * The only irreversible action's escape hatch. It is deliberately the same
 * quiet toast, with one action: the window is ten seconds, and the copy says
 * so rather than implying the undo lasts forever.
 */
export function CategoryUndoToast({
  categoryName,
  movedTxns,
  onUndo,
}: CategoryUndoToastProps) {
  return (
    <Toast
      text={`「${categoryName}」已删除 · ${movedTxns} 笔移到「未分类」 · 10 秒内可撤销`}
      actionLabel="撤销"
      onAction={onUndo}
    />
  );
}

interface DeleteSheetState {
  category: Category;
  txnCount: number;
}

interface UndoState {
  categoryId: string;
  categoryName: string;
  /** Where each moved transaction came from, so undo restores it exactly. */
  moves: CategoryMove[];
  movedTxns: number;
  expiresAt: number;
}

interface RenameState {
  id: string;
  name: string;
}

export default function CategoriesScreen() {
  const { db, bump } = useDb();
  const query = useQuery<CategoriesData>(loadCategoriesData, []);
  const { toast, showToast, clearToast } = useToast();

  const [name, setName] = useState('');
  const [kind, setKind] = useState<CategoryKind>('expense');
  const [showCreate, setShowCreate] = useState(false);
  const [parentId, setParentId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [menuCount, setMenuCount] = useState<number | null>(null);
  const [deleteSheet, setDeleteSheet] = useState<DeleteSheetState | null>(null);
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);

  const data = query.data;
  const categories = data?.categories ?? [];
  const live = categories.filter(
    category => category.archivedAt === null && category.id !== UNCATEGORIZED_CATEGORY_ID
  );
  const archived = categories
    .filter(
      category => category.archivedAt !== null && category.id !== UNCATEGORIZED_CATEGORY_ID
    )
    .sort(bySort);
  const parentOptions = live.filter(
    category => category.parentId === null && category.kind === kind
  );
  const selectedParent = parentOptions.find(category => category.id === parentId) ?? null;
  const menuCategory = categories.find(category => category.id === menuId) ?? null;
  const systemCategory = categories.find(
    category => category.id === UNCATEGORIZED_CATEGORY_ID
  );

  const liveRoots = live.filter(
    category => category.parentId === null && category.kind === kind
  );
  const siblingCount =
    selectedParent === null
      ? liveRoots.length
      : live.filter(category => category.parentId === selectedParent.id).length;
  const tenHint =
    siblingCount >= 10
      ? selectedParent === null
        ? `${KIND_LABELS[kind]}一级分类已经有 ${siblingCount} 个了；还能建，但十个以内更好找。`
        : `「${selectedParent.name}」下已经有 ${siblingCount} 个二级分类了；还能建，但十个以内更好找。`
      : null;

  useEffect(() => {
    if (undo === null) return;
    const remaining = Math.max(0, undo.expiresAt - Date.now());
    const timer = window.setTimeout(() => {
      setUndo(current => (current?.categoryId === undo.categoryId ? null : current));
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [undo]);

  // The ⋯ sheet's count is the number the delete will move. It is read on open
  // so the sheet can name it before the destructive button is pressed.
  useEffect(() => {
    if (db === null || menuId === null) {
      setMenuCount(null);
      return;
    }
    let cancelled = false;
    setMenuCount(null);
    countCategoryTxns(db, menuId).then(
      count => {
        if (!cancelled) setMenuCount(count);
      },
      () => {
        if (!cancelled) setMenuCount(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [db, menuId]);

  const resetForm = () => {
    setName('');
    setFormError(null);
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (db === null || busy) return;

    const trimmed = name.trim();
    if (trimmed === '') {
      setFormError('分类名不能为空');
      return;
    }

    setBusy(true);
    setFormError(null);
    try {
      await createCategory(db, {
        name: trimmed,
        kind: selectedParent?.kind ?? kind,
        ...(selectedParent === null ? {} : { parentId: selectedParent.id }),
      });
      resetForm();
      bump();
      showToast(selectedParent === null ? `已新建一级分类「${trimmed}」` : `已新建二级分类「${trimmed}」`);
    } catch (reason) {
      setFormError(`新建失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (db === null || renaming === null || busy) return;

    const trimmed = renaming.name.trim();
    if (trimmed === '') {
      setRenameError('分类名不能为空');
      return;
    }

    setBusy(true);
    setRenameError(null);
    try {
      await renameCategory(db, renaming.id, trimmed);
      setRenaming(null);
      bump();
      showToast('分类已改名');
    } catch (reason) {
      setRenameError(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleArchive = async (category: Category) => {
    if (db === null || busy) return;
    setBusy(true);
    try {
      await archiveCategory(db, category.id);
      setMenuId(null);
      bump();
      showToast(`已归档「${category.name}」：记账选择里不再出现，历史流水还在。`);
    } catch (reason) {
      showToast(`归档失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleUnarchive = async (category: Category) => {
    if (db === null || busy) return;
    setBusy(true);
    try {
      await unarchiveCategory(db, category.id);
      setMenuId(null);
      bump();
      showToast(`已恢复「${category.name}」，它重新出现在记账选择里。`);
    } catch (reason) {
      showToast(`恢复失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const startDelete = async (category: Category) => {
    if (db === null || busy) return;
    setBusy(true);
    setMenuId(null);
    try {
      const txnCount = await countCategoryTxns(db, category.id);
      setDeleteSheet({ category, txnCount });
    } catch (reason) {
      showToast(`读取笔数失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (db === null || deleteSheet === null || busy) return;
    const { category } = deleteSheet;
    setBusy(true);
    try {
      const result = await deleteCategory(db, category.id);
      setDeleteSheet(null);
      clearToast();
      bump();
      setUndo({
        categoryId: category.id,
        categoryName: category.name,
        moves: result.moves,
        movedTxns: result.movedTxns,
        expiresAt: Date.now() + CATEGORY_UNDO_MS,
      });
    } catch (reason) {
      showToast(`删除失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleUndo = async () => {
    if (db === null || undo === null || busy) return;
    if (Date.now() > undo.expiresAt) {
      setUndo(null);
      showToast('撤销窗口已过');
      return;
    }

    setBusy(true);
    try {
      await undoDeleteCategory(db, undo.categoryId, undo.moves);
      const restored = undo;
      setUndo(null);
      bump();
      showToast(
        `已撤销「${restored.categoryName}」，${restored.movedTxns} 笔流水回到「${restored.categoryName}」。`
      );
    } catch (reason) {
      showToast(`撤销失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const startRename = (category: Category) => {
    setMenuId(null);
    setRenameError(null);
    setRenaming({ id: category.id, name: category.name });
  };

  const startAddChild = (category: Category) => {
    setMenuId(null);
    setParentId(category.id);
    setKind(category.kind);
    setName('');
    setFormError(null);
    setShowCreate(true);
    window.setTimeout(() => {
      document.getElementById('categories-create')?.scrollIntoView({ behavior: 'smooth' });
    }, 0);
  };

  const renderRow = (row: CategoryRow) => {
    const { category, depth } = row;
    const childCount = live.filter(candidate => candidate.parentId === category.id).length;

    return (
      <li
        className={depth === 1 ? 'category-row category-row--child' : 'category-row'}
        key={category.id}
        data-category-id={category.id}
        data-depth={depth}
      >
        {renaming?.id === category.id ? (
          <form className="category-rename" onSubmit={handleRename}>
            <label className="category-rename__label" htmlFor={`rename-${category.id}`}>
              改名
            </label>
            <input
              id={`rename-${category.id}`}
              className="category-rename__input"
              type="text"
              autoComplete="off"
              value={renaming.name}
              aria-invalid={renameError !== null ? 'true' : undefined}
              onChange={event => {
                setRenaming({ id: category.id, name: event.target.value });
                setRenameError(null);
              }}
            />
            <button className="category-rename__save" type="submit" disabled={busy}>
              保存
            </button>
            <button
              className="category-rename__cancel"
              type="button"
              disabled={busy}
              onClick={() => {
                setRenaming(null);
                setRenameError(null);
              }}
            >
              取消
            </button>
            {renameError !== null && (
              <p className="category-rename__error" role="alert">
                {renameError}
              </p>
            )}
          </form>
        ) : (
          <>
            <div className="category-row__main">
              <span className="category-row__name">{category.name}</span>
              <span className="category-row__meta">
                {depth === 0
                  ? `一级分类${childCount > 0 ? ` · ${childCount} 个二级` : ''}`
                  : '二级分类'}
              </span>
            </div>
            <button
              className="category-row__menu"
              type="button"
              aria-label={`${category.name}的菜单`}
              disabled={busy}
              onClick={() => setMenuId(category.id)}
            >
              ⋯
            </button>
          </>
        )}
      </li>
    );
  };

  const renderArchived = (category: Category) => (
    <li className="category-row category-row--archived" key={category.id} data-category-id={category.id}>
      <div className="category-row__main">
        <span className="category-row__name">{category.name}</span>
        <span className="category-row__meta">
          {KIND_LABELS[category.kind]} · 已归档，历史流水还在
        </span>
      </div>
      <button
        className="category-row__restore"
        type="button"
        disabled={busy}
        onClick={() => handleUnarchive(category)}
      >
        恢复
      </button>
      <button
        className="category-row__menu"
        type="button"
        aria-label={`${category.name}的菜单`}
        disabled={busy}
        onClick={() => setMenuId(category.id)}
      >
        ⋯
      </button>
    </li>
  );

  return (
    <div className="categories-screen categories-screen--v1">
      <header className="settings-header">
        <Link className="add-back" to="/settings" aria-label="返回设置">
          ‹
        </Link>
        <h1>分类</h1>
        {data !== null && <span className="settings-header__meta">{live.length} 个</span>}
      </header>

      <div className="categories-seg" role="group" aria-label="分类类型">
        <button
          type="button"
          className={kind === 'expense' ? 'is-on' : undefined}
          aria-pressed={kind === 'expense'}
          onClick={() => {
            setKind('expense');
            setParentId('');
          }}
        >
          支出
        </button>
        <button
          type="button"
          className={kind === 'income' ? 'is-on' : undefined}
          aria-pressed={kind === 'income'}
          onClick={() => {
            setKind('income');
            setParentId('');
          }}
        >
          收入
        </button>
      </div>
      <p className="categories-hint">最多两层：领域 → 细分</p>

      {data === null ? (
        query.error !== null ? (
          <p className="categories-note categories-note--error" role="alert">
            分类暂时打不开
          </p>
        ) : (
          <p className="categories-note" role="status">
            正在加载分类…
          </p>
        )
      ) : (
        <>
          {live.length === 0 && (
            <p className="categories-note">还没有分类，先新建一个一级分类。</p>
          )}

          {buildCategoryRows(categories, 'expense').length > 0 && (
            <section
              aria-labelledby="categories-expense-title"
              hidden={kind !== 'expense'}
            >
              <h2 className="categories-section" id="categories-expense-title">
                支出
              </h2>
              <ul className="category-list">
                {buildCategoryRows(categories, 'expense').map(renderRow)}
              </ul>
            </section>
          )}

          {buildCategoryRows(categories, 'income').length > 0 && (
            <section
              aria-labelledby="categories-income-title"
              hidden={kind !== 'income'}
            >
              <h2 className="categories-section" id="categories-income-title">
                收入
              </h2>
              <ul className="category-list">
                {buildCategoryRows(categories, 'income').map(renderRow)}
              </ul>
            </section>
          )}

          {archived.length > 0 && (
            <section aria-labelledby="categories-archived-title">
              <h2 className="categories-section" id="categories-archived-title">
                已归档
              </h2>
              <ul className="category-list">{archived.map(renderArchived)}</ul>
            </section>
          )}

          <section aria-labelledby="categories-system-title">
            <h2 className="categories-section" id="categories-system-title">
              系统
            </h2>
            <ul className="category-list">
              <li className="category-row category-row--system" data-category-id={UNCATEGORIZED_CATEGORY_ID}>
                <div className="category-row__main">
                  <span className="category-row__name">{systemCategory?.name ?? '未分类'}</span>
                  <span className="category-row__meta">删掉的分类会落到这里</span>
                </div>
                <span className="category-row__system">系统</span>
              </li>
            </ul>
          </section>
        </>
      )}

      {!showCreate && (
        <button
          className="categories-add"
          type="button"
          onClick={() => {
            setName('');
            setParentId('');
            setFormError(null);
            setShowCreate(true);
            window.setTimeout(() => {
              document.getElementById('categories-create')?.scrollIntoView({ behavior: 'smooth' });
            }, 0);
          }}
        >
          ＋ 新增{kind === 'expense' ? '支出' : '收入'}分类
        </button>
      )}

      <form
        className="category-create"
        id="categories-create"
        hidden={!showCreate}
        onSubmit={handleCreate}
      >
        <h2 className="category-create__title">新增分类</h2>
        <div className="category-create__row">
          <label className="category-create__label" htmlFor="new-category-name">
            名称
          </label>
          <input
            id="new-category-name"
            className="category-create__input"
            type="text"
            autoComplete="off"
            placeholder="分类名"
            value={name}
            aria-invalid={formError !== null ? 'true' : undefined}
            disabled={busy || db === null}
            onChange={event => {
              setName(event.target.value);
              setFormError(null);
            }}
          />
        </div>

        <div className="category-create__row">
          <label className="category-create__label" htmlFor="new-category-parent">
            放在
          </label>
          <select
            id="new-category-parent"
            className="category-create__select"
            value={parentId}
            disabled={busy || db === null}
            onChange={event => {
              setParentId(event.target.value);
              setFormError(null);
            }}
          >
            <option value="">一级分类</option>
            {parentOptions.map(category => (
              <option key={category.id} value={category.id}>
                「{category.name}」下的二级
              </option>
            ))}
          </select>
        </div>

        {tenHint !== null && <p className="category-create__hint">{tenHint}</p>}
        {formError !== null && (
          <p className="category-create__error" role="alert">
            {formError}
          </p>
        )}

        <button className="category-create__button" type="submit" disabled={busy || db === null}>
          新增分类
        </button>
      </form>


      {menuCategory !== null && (
        <CategoryMenuSheet
          category={menuCategory}
          txnCount={menuCount}
          onRename={() => startRename(menuCategory)}
          onAddChild={() => startAddChild(menuCategory)}
          onArchive={() => handleArchive(menuCategory)}
          onUnarchive={() => handleUnarchive(menuCategory)}
          onDelete={() => startDelete(menuCategory)}
          onCancel={() => setMenuId(null)}
        />
      )}

      {deleteSheet !== null && (
        <CategoryDeleteSheet
          categoryName={deleteSheet.category.name}
          txnCount={deleteSheet.txnCount}
          busy={busy}
          onConfirm={handleDelete}
          onCancel={() => {
            if (!busy) setDeleteSheet(null);
          }}
        />
      )}

      {undo !== null ? (
        <CategoryUndoToast
          categoryName={undo.categoryName}
          movedTxns={undo.movedTxns}
          onUndo={handleUndo}
        />
      ) : (
        toast !== null && <Toast text={toast} />
      )}
    </div>
  );
}