import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useDialogFocus } from '../components/useDialogFocus';
import type { Db } from '../db/driver';
import type {
  Category,
  CategoryKind,
  CategoryPurgeInspection,
} from '../db/repos/categories';
import {
  archiveCategory,
  archiveCategoryWithUnlink,
  createCategory,
  inspectCategoryPurge,
  listCategories,
  purgeCategory,
  renameCategory,
  unarchiveCategory,
} from '../db/repos/categories';
import type { PurgeUndoRecord } from '../db/repos/purge';
import { readPurgeUndo, undoPurge } from '../db/repos/purge';
import { UNCATEGORIZED_CATEGORY_ID } from '../db/schema';
import { Toast, useToast } from '../components/Toast';
import { PurgeUndoToast, purgeUndoKey, selectPurgeUndo } from '../components/PurgeUndoToast';
import { useDb, useQuery } from '../store/useDb';

/**
 * 分类: the two-level taxonomy behind every transaction.
 *
 * Parents and children are one flat table in the database; this screen is the
 * only place that edits it. The system 未分类 category is rendered last, with a
 * 系统 mark and no menu, because every write refuses it. Archived user rows
 * stay on the page so 恢复 and 彻底删除 are one tap away.
 *
 * A live category can be archived two ways: 归档 keeps its history, while
 * 断联并归档 moves live transactions to 未分类 first. Neither is undoable. An
 * archived category can be physically purged only when it has no history at
 * all; that purge keeps a ten-second undo in purge_undo so a restart cannot
 * turn it into an irreversible mistake.
 */
export interface CategoriesData {
  /** Archived user rows included; the system row is in here too. */
  categories: Category[];
  /** A category purge whose ten-second window has not closed, or null. */
  undo: PurgeUndoRecord | null;
}

export async function loadCategoriesData(db: Db): Promise<CategoriesData> {
  const [categories, undo] = await Promise.all([
    listCategories(db, undefined, { includeArchived: true }),
    readPurgeUndo(db),
  ]);
  return { categories, undo: undo?.kind === 'category' ? undo : null };
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
   * Counts for the row the menu was opened on. null while the screen is still
   * reading them for a just-opened sheet.
   */
  inspection: CategoryPurgeInspection | null;
  onRename(): void;
  onAddChild?(): void;
  onArchive?(): void;
  onUnarchive?(): void;
  /** 断联并归档: live only. */
  onRetire(): void;
  /** 彻底删除: archived only; never disabled, so the refusal can explain itself. */
  onPurge(): void;
  onCancel(): void;
}

/** 分类 · 行菜单: the one ⋯ sheet, mirroring the prototype's cat-menu. */
export function CategoryMenuSheet({
  category,
  inspection,
  onRename,
  onAddChild,
  onArchive,
  onUnarchive,
  onRetire,
  onPurge,
  onCancel,
}: CategoryMenuSheetProps) {
  const panelRef = useDialogFocus({ onClose: onCancel });
  const busy = inspection === null;

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
            {category.archivedAt !== null
              ? '已归档'
              : inspection === null
                ? '正在数…'
                : `${inspection.liveTxnCount} 笔`}
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
            <>
              <button className="action-menu__item" type="button" onClick={onArchive}>
                归档
                <span>从记账选择里收起</span>
              </button>
              <button
                className="action-menu__item action-menu__item--danger category-menu__danger"
                type="button"
                onClick={onRetire}
                disabled={busy}
              >
                断联并归档
                <span>
                  {inspection === null
                    ? '正在数流水…'
                    : inspection.liveTxnCount > 0
                      ? `${inspection.liveTxnCount} 笔移到「未分类」，分类收进已归档`
                      : '没有在用的流水，分类收进已归档'}
                </span>
              </button>
            </>
          ) : (
            <>
              <button className="action-menu__item" type="button" onClick={onUnarchive}>
                恢复
                <span>回到记账选择</span>
              </button>
              <button
                className="action-menu__item action-menu__item--danger category-menu__danger"
                type="button"
                onClick={onPurge}
              >
                彻底删除
                <span>只对没有历史的归档分类可用</span>
              </button>
            </>
          )}
        </div>

        <button className="sheet__secondary" type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

export interface CategoryRetireSheetProps {
  categoryName: string;
  inspection: CategoryPurgeInspection;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * 断联并归档: move the live rows out, then archive the category. The copy is
 * deliberately explicit that 恢复 does not bring those rows back.
 */
export function CategoryRetireSheet({
  categoryName,
  inspection,
  busy,
  onConfirm,
  onCancel,
}: CategoryRetireSheetProps) {
  const panelRef = useDialogFocus({
    onClose: onCancel,
    initial: 'last',
    canClose: () => !busy,
  });
  const childPart =
    inspection.childCount > 0 ? `及 ${inspection.childCount} 个二级分类` : '';
  const body = `「${categoryName}」下的 ${inspection.liveTxnCount} 笔流水会移到「未分类」，金额和日期都不变；「${categoryName}」${childPart}会收进「已归档」。`;

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="category-retire-title"
    >
      <div className="sheet__scrim" aria-hidden="true" onClick={onCancel} />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="category-retire-title">
            断联并归档
          </h2>
          <span className="sheet__version num">{inspection.liveTxnCount} 笔</span>
        </div>

        <p className="sheet__text">{body}</p>
        {inspection.deletedTxnCount > 0 && (
          <p className="sheet__note">
            已删除的 {inspection.deletedTxnCount} 笔流水仍保留原分类，仍算历史，之后可能挡住彻底删除。
          </p>
        )}
        <p className="sheet__note">
          这个操作不能撤销。之后可以在「已归档」里恢复分类，但移到「未分类」的流水不会跟着回来。
        </p>

        <button className="sheet__danger" type="button" onClick={onConfirm} disabled={busy}>
          断联并归档
        </button>
        <button className="sheet__secondary" type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </div>
  );
}

export interface CategoryPurgeBlockedSheetProps {
  categoryName: string;
  inspection: CategoryPurgeInspection;
  onClose(): void;
}

/** A refusal that names every reason, instead of hiding the menu item. */
export function CategoryPurgeBlockedSheet({
  categoryName,
  inspection,
  onClose,
}: CategoryPurgeBlockedSheetProps) {
  const panelRef = useDialogFocus({ onClose });

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="category-purge-blocked-title"
    >
      <div className="sheet__scrim" aria-hidden="true" onClick={onClose} />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="category-purge-blocked-title">
            不能彻底删除
          </h2>
        </div>

        <p className="sheet__text">「{categoryName}」还有历史，不能从数据库里删除。</p>
        <ul className="sheet__reasons">
          {inspection.txnCount > 0 && (
            <li>
              还有 {inspection.txnCount} 笔流水用过它（其中 {inspection.deletedTxnCount} 笔已删除）。
            </li>
          )}
          {inspection.templateCount > 0 && <li>还有 {inspection.templateCount} 个模板在用它。</li>}
          {inspection.liveChildCount > 0 && (
            <li>下面还有 {inspection.liveChildCount} 个未归档的二级分类。</li>
          )}
        </ul>
        <p className="sheet__note">
          有历史的分类只能保持归档，历史流水的分类显示不会丢。
        </p>

        <button className="sheet__secondary" type="button" onClick={onClose}>
          知道了
        </button>
      </div>
    </div>
  );
}

export interface CategoryPurgeSheetProps {
  categoryName: string;
  inspection: CategoryPurgeInspection;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** 彻底删除: only reachable for an archived, history-free category. */
export function CategoryPurgeSheet({
  categoryName,
  inspection,
  busy,
  onConfirm,
  onCancel,
}: CategoryPurgeSheetProps) {
  const panelRef = useDialogFocus({
    onClose: onCancel,
    initial: 'last',
    canClose: () => !busy,
  });
  const childPart =
    inspection.childCount > 0 ? `及 ${inspection.childCount} 个二级分类` : '';
  const body = `「${categoryName}」${childPart}会从数据库里删除。这个分类没有任何流水或模板，删除不会影响一笔账。`;

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="category-purge-title"
    >
      <div className="sheet__scrim" aria-hidden="true" onClick={onCancel} />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="category-purge-title">
            彻底删除
          </h2>
          <span className="sheet__version">已归档</span>
        </div>

        <p className="sheet__text">{body}</p>
        {inspection.hintCount > 0 && (
          <p className="sheet__note">同时会清掉 {inspection.hintCount} 条固定支出候选。</p>
        )}
        <p className="sheet__note">
          10 秒内可以撤销；撤销会把分类恢复成现在的归档状态。同时只保留最近一次彻底删除的撤销。
        </p>

        <button className="sheet__danger" type="button" onClick={onConfirm} disabled={busy}>
          彻底删除
        </button>
        <button className="sheet__secondary" type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </div>
  );
}

interface RetireSheetState {
  category: Category;
  inspection: CategoryPurgeInspection;
}

interface PurgeDialogState {
  category: Category;
  inspection: CategoryPurgeInspection;
  /** True when the archive still has history and the destructive action is refused. */
  blocked: boolean;
}

/**
 * What the screen should offer right now.
 *
 * The purge's own result wins while it is fresh. Once its timer fires the key
 * is marked dismissed, which keeps a stale query snapshot (still holding the
 * same row) from bringing the toast back. A newer row has a new expiresAt and
 * therefore a new key, so it is not swallowed by the old dismissal.
 */
export function selectActiveUndo(
  pending: PurgeUndoRecord | null,
  stored: PurgeUndoRecord | null,
  dismissedKey: string | null,
  now: number = Date.now()
): PurgeUndoRecord | null {
  return selectPurgeUndo(pending, stored, dismissedKey, now);
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
  const [menuInspection, setMenuInspection] = useState<CategoryPurgeInspection | null>(null);
  const [retireSheet, setRetireSheet] = useState<RetireSheetState | null>(null);
  const [purgeDialog, setPurgeDialog] = useState<PurgeDialogState | null>(null);
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [pendingUndo, setPendingUndo] = useState<PurgeUndoRecord | null>(null);
  const [dismissedUndoKey, setDismissedUndoKey] = useState<string | null>(null);

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

  // The purge's own result renders immediately; the copy loaded with the
  // categories is what survives a restart. Once its timer fires, the key stays
  // dismissed so a stale query snapshot cannot bring the toast back.
  const storedUndo = data?.undo ?? null;
  const activeUndo = selectActiveUndo(pendingUndo, storedUndo, dismissedUndoKey);

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
    if (activeUndo === null) return;
    const key = purgeUndoKey(activeUndo);
    const remaining = Math.max(0, activeUndo.expiresAt - Date.now());
    const timer = window.setTimeout(() => {
      setDismissedUndoKey(key);
      setPendingUndo(current => (current !== null && purgeUndoKey(current) === key ? null : current));
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [activeUndo]);

  // The ⋯ sheet names the count its destructive action would affect, before
  // that action is pressed. 归档 and 断联并归档 share the live count; 彻底删除
  // shows only 已归档, because a history-free row has no number worth showing.
  useEffect(() => {
    if (db === null || menuId === null) {
      setMenuInspection(null);
      return;
    }
    let cancelled = false;
    setMenuInspection(null);
    inspectCategoryPurge(db, menuId).then(
      inspection => {
        if (!cancelled) setMenuInspection(inspection);
      },
      () => {
        if (!cancelled) setMenuInspection(null);
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

  const startRetire = (category: Category) => {
    if (menuInspection === null) return;
    setMenuId(null);
    setRetireSheet({ category, inspection: menuInspection });
  };

  const handleRetire = async () => {
    if (db === null || retireSheet === null || busy) return;
    const { category } = retireSheet;
    setBusy(true);
    try {
      const result = await archiveCategoryWithUnlink(db, category.id);
      setRetireSheet(null);
      clearToast();
      bump();
      const childPart =
        result.archivedChildCount > 0
          ? `，${result.archivedChildCount} 个二级分类一起收进「已归档」`
          : '';
      showToast(
        `已断联并归档「${category.name}」：${result.movedTxns} 笔流水移到「未分类」${childPart}。`
      );
    } catch (reason) {
      showToast(`断联失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const startPurge = async (category: Category) => {
    if (db === null || busy) return;
    setBusy(true);
    setMenuId(null);
    try {
      const inspection = await inspectCategoryPurge(db, category.id);
      setPurgeDialog({ category, inspection, blocked: !inspection.purgeable });
    } catch (reason) {
      showToast(`读取分类信息失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handlePurge = async () => {
    if (db === null || purgeDialog === null || purgeDialog.blocked || busy) return;
    const { category } = purgeDialog;
    setBusy(true);
    try {
      const result = await purgeCategory(db, category.id);
      setPurgeDialog(null);
      clearToast();
      bump();
      setPendingUndo(result.undo);
      setDismissedUndoKey(null);
    } catch (reason) {
      showToast(`彻底删除失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleUndo = async () => {
    if (db === null || activeUndo === null || busy) return;
    const restored = activeUndo;
    const key = purgeUndoKey(restored);
    if (Date.now() >= restored.expiresAt) {
      setPendingUndo(current => (current !== null && purgeUndoKey(current) === key ? null : current));
      setDismissedUndoKey(key);
      showToast('撤销窗口已过');
      return;
    }

    setBusy(true);
    try {
      const result = await undoPurge(db, {
        kind: restored.kind,
        targetId: restored.targetId,
        expiresAt: restored.expiresAt,
      });
      setPendingUndo(null);
      setDismissedUndoKey(key);
      bump();
      showToast(`已恢复分类「${result.label}」，它回到「已归档」。`);
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
          {KIND_LABELS[category.kind]} · 已归档
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
          inspection={menuInspection}
          onRename={() => startRename(menuCategory)}
          onAddChild={() => startAddChild(menuCategory)}
          onArchive={() => handleArchive(menuCategory)}
          onUnarchive={() => handleUnarchive(menuCategory)}
          onRetire={() => startRetire(menuCategory)}
          onPurge={() => startPurge(menuCategory)}
          onCancel={() => setMenuId(null)}
        />
      )}

      {retireSheet !== null && (
        <CategoryRetireSheet
          categoryName={retireSheet.category.name}
          inspection={retireSheet.inspection}
          busy={busy}
          onConfirm={handleRetire}
          onCancel={() => {
            if (!busy) setRetireSheet(null);
          }}
        />
      )}

      {purgeDialog !== null &&
        (purgeDialog.blocked ? (
          <CategoryPurgeBlockedSheet
            categoryName={purgeDialog.category.name}
            inspection={purgeDialog.inspection}
            onClose={() => setPurgeDialog(null)}
          />
        ) : (
          <CategoryPurgeSheet
            categoryName={purgeDialog.category.name}
            inspection={purgeDialog.inspection}
            busy={busy}
            onConfirm={handlePurge}
            onCancel={() => {
              if (!busy) setPurgeDialog(null);
            }}
          />
        ))}

      {activeUndo !== null && <PurgeUndoToast undo={activeUndo} onUndo={handleUndo} />}
      {toast !== null && (
        <Toast
          text={toast}
          className={activeUndo !== null ? 'toast--stacked' : undefined}
        />
      )}
    </div>
  );
}