import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useDialogFocus } from '../components/useDialogFocus';
import type { Db } from '../db/driver';
import type { Tag, TagPurgeInspection } from '../db/repos/tags';
import {
  archiveTag,
  archiveTagWithUnlink,
  createTag,
  inspectTagPurge,
  listTags,
  purgeTag,
  renameTag,
  TAG_NAME_MAX_LENGTH,
  tagUsage,
  unarchiveTag,
} from '../db/repos/tags';
import type { PurgeUndoRecord } from '../db/repos/purge';
import { readPurgeUndo, undoPurge } from '../db/repos/purge';
import { formatMonthDay, todayLocalISO } from '../domain/date';
import { Toast, useToast } from '../components/Toast';
import { PurgeUndoToast, purgeUndoKey, selectPurgeUndo } from '../components/PurgeUndoToast';
import { useDb, useQuery } from '../store/useDb';

/**
 * 标签: the one place the flat label vocabulary is created and retired.
 *
 * The list is deliberately all tags, archived included: archiving only hides a
 * tag from pickers, and the owner needs a way back. Usage is read from
 * tagUsage, so the screen never counts transactions itself. A create reuses the
 * repository's trim / 12-character / duplicate rules; this file only turns a
 * rejected draft into a sentence before the repository is called.
 */
export interface TagUsageRow {
  id: string;
  name: string;
  count: number;
  lastUsedDate: string | null;
}

export interface TagsData {
  /** Archived rows included; the live list filters them out. */
  tags: Tag[];
  usage: TagUsageRow[];
  /** A tag purge whose ten-second window has not closed, or null. */
  undo: PurgeUndoRecord | null;
}

export async function loadTagsData(db: Db): Promise<TagsData> {
  const [tags, usage, undo] = await Promise.all([
    listTags(db, { includeArchived: true }),
    tagUsage(db),
    readPurgeUndo(db),
  ]);
  return { tags, usage, undo: undo?.kind === 'tag' ? undo : null };
}

/** A trimmed create draft, or the sentence explaining why it cannot be used. */
export interface TagCreatePlan {
  name: string | null;
  error: string | null;
}

/**
 * The user-facing half of createTag's rules. The repository repeats them, so a
 * stale caller cannot store a blank or 13-character name; doing it here as well
 * lets the form explain the problem before opening a write.
 */
export function planTagCreate(rawName: string): TagCreatePlan {
  const name = rawName.trim();
  if (name === '') return { name: null, error: '标签名不能为空' };
  if (Array.from(name).length > TAG_NAME_MAX_LENGTH) {
    return { name: null, error: `标签名最多 ${TAG_NAME_MAX_LENGTH} 个字` };
  }
  return { name, error: null };
}

/**
 * The last-use cell. The current day gets a word because it is the common case
 * and the prototype names it; everything older uses the app's month-day shape.
 */
export function tagLastUsedLabel(lastUsedDate: string | null, todayISO: string): string {
  if (lastUsedDate === null) return '还没用过';
  if (lastUsedDate === todayISO) return '最近 今天';
  return `最近 ${formatMonthDay(lastUsedDate)}`;
}

function usageCount(usage: readonly TagUsageRow[], tagId: string): number {
  return usage.find(row => row.id === tagId)?.count ?? 0;
}

/** The per-row ⋯ sheet. Both archive states share one shape. */
export interface TagMenuSheetProps {
  tag: Tag;
  /** Live usage shown on the active sheet; archived rows say 已归档 instead. */
  count: number;
  /** All links, read when the menu opens; null while it is being read. */
  inspection: TagPurgeInspection | null;
  onRename(): void;
  onArchive?(): void;
  onUnarchive?(): void;
  /** 断联并归档: live only. */
  onRetire(): void;
  /** 彻底删除: archived only; never disabled, so the refusal can explain itself. */
  onPurge(): void;
  onCancel(): void;
}

export function TagMenuSheet({
  tag,
  count,
  inspection,
  onRename,
  onArchive,
  onUnarchive,
  onRetire,
  onPurge,
  onCancel,
}: TagMenuSheetProps) {
  const panelRef = useDialogFocus({ onClose: onCancel });

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="tag-menu-title">
      <div className="sheet__scrim" aria-hidden="true" onClick={onCancel} />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="tag-menu-title">
            {tag.name}
          </h2>
          <span className="sheet__version">
            {tag.archivedAt !== null ? '已归档' : `${count} 次`}
          </span>
        </div>

        <div className="action-menu">
          <button className="action-menu__item" type="button" onClick={onRename}>
            改名
            <span>历史流水一起改</span>
          </button>
          {tag.archivedAt === null ? (
            <>
              <button className="action-menu__item" type="button" onClick={onArchive}>
                归档
                <span>从选择里收起，历史保留</span>
              </button>
              <button
                className="action-menu__item action-menu__item--danger"
                type="button"
                onClick={onRetire}
                disabled={inspection === null}
              >
                断联并归档
                <span>删掉全部关联，标签收进已归档</span>
              </button>
            </>
          ) : (
            <>
              <button className="action-menu__item" type="button" onClick={onUnarchive}>
                恢复
                <span>重新出现在标签选择里</span>
              </button>
              <button
                className="action-menu__item action-menu__item--danger"
                type="button"
                onClick={onPurge}
              >
                彻底删除
                <span>只对没有关联的归档标签可用</span>
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

export interface TagRetireSheetProps {
  tagName: string;
  inspection: TagPurgeInspection;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * 断联并归档: delete every link, then archive the tag. The note is explicit
 * that 恢复 will not bring the links back.
 */
export function TagRetireSheet({
  tagName,
  inspection,
  busy,
  onConfirm,
  onCancel,
}: TagRetireSheetProps) {
  const panelRef = useDialogFocus({
    onClose: onCancel,
    initial: 'last',
    canClose: () => !busy,
  });
  const deletedPart =
    inspection.deletedLinkCount > 0
      ? `（其中 ${inspection.deletedLinkCount} 条在已删除流水上）`
      : '';
  const body = `「${tagName}」的 ${inspection.linkCount} 条流水关联会被删除${deletedPart}；流水本身一笔都不会少，金额和日期都不变。标签会收进「已归档」。`;

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="tag-retire-title">
      <div className="sheet__scrim" aria-hidden="true" onClick={onCancel} />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="tag-retire-title">
            断联并归档
          </h2>
          <span className="sheet__version num">{inspection.linkCount} 条关联</span>
        </div>

        <p className="sheet__text">{body}</p>
        <p className="sheet__note">
          这个操作不能撤销。之后恢复标签，也不会恢复这些关联。
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

export interface TagPurgeBlockedSheetProps {
  tagName: string;
  inspection: TagPurgeInspection;
  onClose(): void;
}

/** A refusal that names the remaining links, instead of hiding the menu item. */
export function TagPurgeBlockedSheet({
  tagName,
  inspection,
  onClose,
}: TagPurgeBlockedSheetProps) {
  const panelRef = useDialogFocus({ onClose });

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tag-purge-blocked-title"
    >
      <div className="sheet__scrim" aria-hidden="true" onClick={onClose} />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="tag-purge-blocked-title">
            不能彻底删除
          </h2>
        </div>

        <p className="sheet__text">
          「{tagName}」还关联着 {inspection.linkCount} 笔流水（其中 {inspection.deletedLinkCount} 笔已删除）。有历史的标签只能保持归档，不能从数据库里删除。
        </p>
        <p className="sheet__note">彻底删除只适用于没有任何关联的归档标签。</p>

        <button className="sheet__secondary" type="button" onClick={onClose}>
          知道了
        </button>
      </div>
    </div>
  );
}

export interface TagPurgeSheetProps {
  tagName: string;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** 彻底删除: only reachable for an archived, link-free tag. */
export function TagPurgeSheet({
  tagName,
  busy,
  onConfirm,
  onCancel,
}: TagPurgeSheetProps) {
  const panelRef = useDialogFocus({
    onClose: onCancel,
    initial: 'last',
    canClose: () => !busy,
  });

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="tag-purge-title">
      <div className="sheet__scrim" aria-hidden="true" onClick={onCancel} />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="tag-purge-title">
            彻底删除
          </h2>
          <span className="sheet__version">已归档</span>
        </div>

        <p className="sheet__text">
          「{tagName}」没有任何流水关联，会从数据库里删除。删除不会影响任何一笔账。
        </p>
        <p className="sheet__note">
          10 秒内可以撤销；撤销会把标签恢复成现在的归档状态。同时只保留最近一次彻底删除的撤销。
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

interface TagRetireSheetState {
  tag: Tag;
  inspection: TagPurgeInspection;
}

interface TagPurgeDialogState {
  tag: Tag;
  inspection: TagPurgeInspection;
  /** True when the archive still has links and the destructive action is refused. */
  blocked: boolean;
}

export default function TagsScreen() {
  const { db, bump } = useDb();
  const query = useQuery<TagsData>(loadTagsData, []);
  const { toast, showToast, clearToast } = useToast();

  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [menuInspection, setMenuInspection] = useState<TagPurgeInspection | null>(null);
  const [retireSheet, setRetireSheet] = useState<TagRetireSheetState | null>(null);
  const [purgeDialog, setPurgeDialog] = useState<TagPurgeDialogState | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [pendingUndo, setPendingUndo] = useState<PurgeUndoRecord | null>(null);
  const [dismissedUndoKey, setDismissedUndoKey] = useState<string | null>(null);

  const todayISO = todayLocalISO();

  const data = query.data;
  const tags = data?.tags ?? [];
  const liveTags = tags
    .filter(tag => tag.archivedAt === null)
    .sort((a, b) => {
      const byCount = usageCount(data?.usage ?? [], b.id) - usageCount(data?.usage ?? [], a.id);
      return byCount || a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
  const archivedTags = tags
    .filter(tag => tag.archivedAt !== null)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  const needle = search.trim().toLocaleLowerCase();
  const visibleLiveTags = liveTags.filter(tag =>
    tag.name.toLocaleLowerCase().includes(needle)
  );
  const visibleArchivedTags = archivedTags.filter(tag =>
    tag.name.toLocaleLowerCase().includes(needle)
  );
  const menuTag = tags.find(tag => tag.id === menuId) ?? null;

  const storedUndo = data?.undo ?? null;
  const activeUndo = selectPurgeUndo(pendingUndo, storedUndo, dismissedUndoKey, Date.now());

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

  // The menu reads every link, including links on deleted transactions, before
  // it offers 断联并归档 or 彻底删除. 已归档 rows show a word, not a count.
  useEffect(() => {
    if (db === null || menuId === null) {
      setMenuInspection(null);
      return;
    }
    let cancelled = false;
    setMenuInspection(null);
    inspectTagPurge(db, menuId).then(
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

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (db === null || busy) return;

    const plan = planTagCreate(draft);
    if (plan.name === null) {
      setCreateError(plan.error);
      return;
    }

    setBusy(true);
    setCreateError(null);
    try {
      const before = tags.find(
        tag => tag.name.trim().toLocaleLowerCase() === plan.name!.toLocaleLowerCase()
      );
      await createTag(db, plan.name);
      setDraft('');
      bump();
      if (before !== undefined && before.archivedAt !== null) {
        showToast(`「${before.name}」在已归档里，恢复后才能再选。`);
      } else if (before !== undefined) {
        showToast(`「${before.name}」已经在了。`);
      } else {
        showToast(`已新建标签「${plan.name}」`);
      }
    } catch (reason) {
      setCreateError(`新建失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleArchive = async (tag: Tag) => {
    if (db === null || busy) return;
    setBusy(true);
    try {
      await archiveTag(db, tag.id);
      setMenuId(null);
      bump();
      showToast(`已归档「${tag.name}」：历史关联还在，可在「已归档」里恢复。`);
    } catch (reason) {
      showToast(`归档失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleUnarchive = async (tag: Tag) => {
    if (db === null || busy) return;
    setBusy(true);
    try {
      await unarchiveTag(db, tag.id);
      setMenuId(null);
      bump();
      showToast(`已恢复「${tag.name}」，它重新出现在标签选择里。`);
    } catch (reason) {
      showToast(`恢复失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (db === null || renaming === null || busy) return;

    const plan = planTagCreate(renaming.name);
    if (plan.name === null) {
      setRenameError(plan.error);
      return;
    }

    setBusy(true);
    setRenameError(null);
    try {
      await renameTag(db, renaming.id, plan.name);
      setRenaming(null);
      bump();
      showToast('标签已改名');
    } catch (reason) {
      setRenameError(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const startRetire = (tag: Tag) => {
    if (menuInspection === null) return;
    setMenuId(null);
    setRetireSheet({ tag, inspection: menuInspection });
  };

  const handleRetire = async () => {
    if (db === null || retireSheet === null || busy) return;
    const { tag } = retireSheet;
    setBusy(true);
    try {
      const result = await archiveTagWithUnlink(db, tag.id);
      setRetireSheet(null);
      clearToast();
      bump();
      showToast(
        `已断联并归档「${tag.name}」：${result.unlinked} 条关联已删除，流水都还在。`
      );
    } catch (reason) {
      showToast(`断联失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const startPurge = async (tag: Tag) => {
    if (db === null || busy) return;
    setBusy(true);
    setMenuId(null);
    try {
      const inspection = await inspectTagPurge(db, tag.id);
      setPurgeDialog({ tag, inspection, blocked: !inspection.purgeable });
    } catch (reason) {
      showToast(`读取标签信息失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handlePurge = async () => {
    if (db === null || purgeDialog === null || purgeDialog.blocked || busy) return;
    const { tag } = purgeDialog;
    setBusy(true);
    try {
      const result = await purgeTag(db, tag.id);
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
      showToast(`已恢复标签「${result.label}」，它回到「已归档」。`);
    } catch (reason) {
      showToast(`撤销失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const startRename = (tag: Tag) => {
    setMenuId(null);
    setRenameError(null);
    setRenaming({ id: tag.id, name: tag.name });
  };

  const renderTag = (tag: Tag) => {
    const count = usageCount(data?.usage ?? [], tag.id);
    const lastUsed = data?.usage.find(row => row.id === tag.id)?.lastUsedDate ?? null;

    return (
      <li className="tag-row" key={tag.id} data-tag-id={tag.id}>
        {renaming?.id === tag.id ? (
          <form className="tag-rename" onSubmit={handleRename}>
            <label className="tag-rename__label" htmlFor={`rename-${tag.id}`}>
              改名
            </label>
            <input
              id={`rename-${tag.id}`}
              className="tag-rename__input"
              type="text"
              value={renaming.name}
              autoComplete="off"
              aria-invalid={renameError !== null ? 'true' : undefined}
              onChange={event => {
                setRenaming({ id: tag.id, name: event.target.value });
                setRenameError(null);
              }}
            />
            <button className="tag-rename__save" type="submit" disabled={busy}>
              保存
            </button>
            <button
              className="tag-rename__cancel"
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
              <p className="tag-rename__error" role="alert">
                {renameError}
              </p>
            )}
          </form>
        ) : (
          <>
            <div className="tag-row__main">
              <span className="tag-row__name">
                {tag.name}
                {tag.archivedAt !== null && <span className="tag-row__archived">已归档</span>}
              </span>
              <span className="tag-row__meta">
                <span className="tag-row__count num">{count} 次</span>
                <span aria-hidden="true">·</span>
                <span className="tag-row__last">{tagLastUsedLabel(lastUsed, todayISO)}</span>
              </span>
            </div>
            <button
              className="tag-row__menu"
              type="button"
              aria-label={`${tag.name}的菜单`}
              disabled={busy}
              onClick={() => setMenuId(tag.id)}
            >
              ⋯
            </button>
          </>
        )}
      </li>
    );
  };

  return (
    <div className="tags-screen tags-screen--v1">
      <header className="settings-header">
        <Link className="add-back" to="/settings" aria-label="返回设置">
          ‹
        </Link>
        <h1>标签</h1>
        {data !== null && <span className="settings-header__meta">{liveTags.length} 个</span>}
      </header>

      <label className="tags-search">
        <span className="tags-search__icon" aria-hidden="true">
          ⌕
        </span>
        <input
          className="tags-search__input"
          type="search"
          value={search}
          placeholder="搜索标签"
          aria-label="搜索标签"
          onChange={event => setSearch(event.target.value)}
        />
      </label>

      {data === null ? (
        query.error !== null ? (
          <p className="tags-note tags-note--error" role="alert">
            标签暂时打不开
          </p>
        ) : (
          <p className="tags-note" role="status">
            正在加载标签…
          </p>
        )
      ) : (
        <>
          {tags.length === 0 ? (
            <div className="tags-empty">
              <p className="tags-empty__title">还没有标签</p>
            </div>
          ) : (
            <section aria-labelledby="tags-live-title">
              <h2 className="tags-section" id="tags-live-title">
                在用的
              </h2>
              <ul className="tags-list">{visibleLiveTags.map(renderTag)}</ul>
            </section>
          )}

          {archivedTags.length > 0 && (
            <section aria-labelledby="tags-archived-title">
              <h2 className="tags-section" id="tags-archived-title">
                已归档
              </h2>
              <ul className="tags-list">{visibleArchivedTags.map(renderTag)}</ul>
            </section>
          )}
        </>
      )}

      {search.trim() !== '' &&
        visibleLiveTags.length === 0 &&
        visibleArchivedTags.length === 0 && (
          <p className="tags-note">没有匹配的标签</p>
        )}

      {!showCreate && (
        <button
          className="tags-add"
          type="button"
          onClick={() => {
            setShowCreate(true);
            window.setTimeout(() => {
              document.getElementById('tags-create')?.scrollIntoView({ behavior: 'smooth' });
            }, 0);
          }}
        >
          ＋ 新增标签
        </button>
      )}

      <form className="tags-create" id="tags-create" hidden={!showCreate} onSubmit={handleCreate}>
        <label className="tags-create__label" htmlFor="new-tag-name">
          新建标签
        </label>
        <div className="tags-create__row">
          <input
            id="new-tag-name"
            className="tags-create__input"
            type="text"
            autoComplete="off"
            placeholder="标签名，最多 12 个字"
            value={draft}
            aria-invalid={createError !== null ? 'true' : undefined}
            disabled={busy || db === null}
            onChange={event => {
              setDraft(event.target.value);
              setCreateError(null);
            }}
          />
          <span className="tags-create__count num">{Array.from(draft.trim()).length}/12</span>
          <button className="tags-create__button" type="submit" disabled={busy || db === null}>
            新建
          </button>
        </div>
        {createError !== null && (
          <p className="tags-create__error" role="alert">
            {createError}
          </p>
        )}
      </form>


      {menuTag !== null && (
        <TagMenuSheet
          tag={menuTag}
          count={usageCount(data?.usage ?? [], menuTag.id)}
          inspection={menuInspection}
          onRename={() => startRename(menuTag)}
          onArchive={() => handleArchive(menuTag)}
          onUnarchive={() => handleUnarchive(menuTag)}
          onRetire={() => startRetire(menuTag)}
          onPurge={() => startPurge(menuTag)}
          onCancel={() => setMenuId(null)}
        />
      )}

      {retireSheet !== null && (
        <TagRetireSheet
          tagName={retireSheet.tag.name}
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
          <TagPurgeBlockedSheet
            tagName={purgeDialog.tag.name}
            inspection={purgeDialog.inspection}
            onClose={() => setPurgeDialog(null)}
          />
        ) : (
          <TagPurgeSheet
            tagName={purgeDialog.tag.name}
            busy={busy}
            onConfirm={handlePurge}
            onCancel={() => {
              if (!busy) setPurgeDialog(null);
            }}
          />
        ))}

      {activeUndo !== null && <PurgeUndoToast undo={activeUndo} onUndo={handleUndo} />}

      {toast !== null && (
        <Toast text={toast} className={activeUndo !== null ? 'toast--stacked' : undefined} />
      )}
    </div>
  );
}