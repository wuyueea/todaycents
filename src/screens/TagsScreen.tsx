import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useDialogFocus } from '../components/useDialogFocus';
import type { Db } from '../db/driver';
import type { Tag } from '../db/repos/tags';
import {
  archiveTag,
  createTag,
  deleteTag,
  listTags,
  renameTag,
  TAG_NAME_MAX_LENGTH,
  tagUsage,
  unarchiveTag,
} from '../db/repos/tags';
import { formatMonthDay, todayLocalISO } from '../domain/date';
import { Toast, useToast } from '../components/Toast';
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
}

export async function loadTagsData(db: Db): Promise<TagsData> {
  const [tags, usage] = await Promise.all([listTags(db, { includeArchived: true }), tagUsage(db)]);
  return { tags, usage };
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
  count: number;
  onRename(): void;
  onArchive?(): void;
  onUnarchive?(): void;
  onDelete(): void;
  onCancel(): void;
}

export function TagMenuSheet({
  tag,
  count,
  onRename,
  onArchive,
  onUnarchive,
  onDelete,
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
          <span className="sheet__version">{count} 次</span>
        </div>

        <div className="action-menu">
          <button className="action-menu__item" type="button" onClick={onRename}>
            改名
            <span>历史流水一起改</span>
          </button>
          {tag.archivedAt === null ? (
            <button className="action-menu__item" type="button" onClick={onArchive}>
              归档
              <span>从选择里收起，历史保留</span>
            </button>
          ) : (
            <button className="action-menu__item" type="button" onClick={onUnarchive}>
              恢复
              <span>重新出现在标签选择里</span>
            </button>
          )}
          <button
            className="action-menu__item action-menu__item--danger"
            type="button"
            onClick={onDelete}
          >
            删除关联
            <span>只删关联，不删流水</span>
          </button>
        </div>

        <button className="sheet__secondary" type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

export interface TagDeleteSheetProps {
  tag: Tag;
  /** The number of transaction links deleteTag will remove. */
  linkCount: number;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * The confirmation for 删除关联. It says the one thing that matters: only the
 * tag links go away, never a transaction, an amount or a date.
 */
export function TagDeleteSheet({
  tag,
  linkCount,
  busy,
  onConfirm,
  onCancel,
}: TagDeleteSheetProps) {
  const panelRef = useDialogFocus({
    onClose: onCancel,
    initial: 'last',
    canClose: () => !busy,
  });

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="tag-delete-title">
      <div className="sheet__scrim" aria-hidden="true" onClick={onCancel} />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="tag-delete-title">
            删除关联
          </h2>
          <span className="sheet__version">{linkCount} 笔</span>
        </div>

        <p className="sheet__text">
          「{tag.name}」和 {linkCount} 笔流水的关联会被删除；流水本身一笔都不会少，金额和日期都不变。
        </p>
        <p className="sheet__note">
          这个标签会从列表和记账选择里消失。只想先收起它，可以用「归档」——归档会留住历史。
        </p>

        <button className="sheet__danger" type="button" onClick={onConfirm} disabled={busy}>
          删除关联
        </button>
        <button className="sheet__secondary" type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </div>
  );
}

export default function TagsScreen() {
  const { db, bump } = useDb();
  const query = useQuery<TagsData>(loadTagsData, []);
  const { toast, showToast } = useToast();

  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

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
  const deletingTag = tags.find(tag => tag.id === deletingId) ?? null;

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

  const handleDelete = async () => {
    if (db === null || deletingTag === null || busy) return;
    const tag = deletingTag;
    setBusy(true);
    try {
      await deleteTag(db, tag.id);
      setDeletingId(null);
      bump();
      showToast(`已删除「${tag.name}」的关联 · 流水都还在`);
    } catch (reason) {
      showToast(`删除失败：${reason instanceof Error ? reason.message : String(reason)}`);
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
          onRename={() => startRename(menuTag)}
          onArchive={() => handleArchive(menuTag)}
          onUnarchive={() => handleUnarchive(menuTag)}
          onDelete={() => {
            setMenuId(null);
            setDeletingId(menuTag.id);
          }}
          onCancel={() => setMenuId(null)}
        />
      )}

      {deletingTag !== null && (
        <TagDeleteSheet
          tag={deletingTag}
          linkCount={usageCount(data?.usage ?? [], deletingTag.id)}
          busy={busy}
          onConfirm={handleDelete}
          onCancel={() => {
            if (!busy) setDeletingId(null);
          }}
        />
      )}

      {toast !== null && <Toast text={toast} />}
    </div>
  );
}