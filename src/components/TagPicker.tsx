import { useState } from 'react';
import type { Db } from '../db/driver';
import { createTag, listTags } from '../db/repos/tags';
import type { Tag } from '../db/repos/tags';

/**
 * The shared tag chooser for 记账 and 编辑流水.
 *
 * The tag model is deliberately flat: a transaction carries 0..N labels, and
 * the sheet is a set of chips rather than a tree. Usage numbers belong to the
 * management screen, so nothing here reads or renders a count. Archived tags
 * are filtered out of the sheet — archiving is how a label retires without
 * rewriting the rows that already carry it — with one exception: a tag already
 * on this transaction stays visible (marked 已归档) so it can be taken off.
 * Hiding it would make that mistake impossible to undo.
 *
 * The caller owns the selected ids. Creating a tag is immediate (there is no
 * second save step) and the new tag is appended to the selection, so the label
 * the user typed is already in effect when they press 完成.
 */

/** 1 -> the name; >=2 -> 「夜宵 等 3 个」; 0 -> 添加标签. */
export function tagSelectionLabel(selected: readonly Pick<Tag, 'name'>[]): string {
  if (selected.length === 0) return '添加标签';
  if (selected.length === 1) return selected[0]!.name;
  return `${selected[0]!.name} 等 ${selected.length} 个`;
}

/** The outcome of an inline create: a selectable live tag, or a sentence. */
export interface PickedTagCreate {
  tag: Tag | null;
  error: string | null;
}

/**
 * The entry sheet's create step, separated from the input so it can be tested
 * without a browser.
 *
 * createTag owns trim, length and duplicate handling. The only decision added
 * here is visibility: an archived duplicate comes back as an error rather than
 * being attached silently, because the sheet cannot show an archived chip and
 * setTxnTags refuses to add one to a row that did not carry it.
 */
export async function createTagForPicker(
  db: Db,
  rawName: string
): Promise<PickedTagCreate> {
  try {
    const id = await createTag(db, rawName);
    const fresh = await listTags(db, { includeArchived: true });
    const tag = fresh.find(candidate => candidate.id === id);
    if (tag === undefined) return { tag: null, error: '新建失败：找不到刚建的标签' };
    if (tag.archivedAt !== null) {
      return {
        tag: null,
        error: `「${tag.name}」在已归档里，恢复后才能再选。`,
      };
    }
    return { tag, error: null };
  } catch (reason) {
    return {
      tag: null,
      error: `新建失败：${reason instanceof Error ? reason.message : String(reason)}`,
    };
  }
}

export interface TagSheetProps {
  /** Every known tag; archived rows are filtered in here as a second guard. */
  tags: readonly Tag[];
  selectedIds: readonly string[];
  onToggle(id: string): void;
  /** Resolves to an error sentence, or null after the tag exists and is selected. */
  onCreate(name: string): Promise<string | null>;
  onClose(): void;
}

/**
 * The sheet's body: live chips, an inline create field, and 完成.
 *
 * No form element is used for creation because this sheet is rendered inside
 * the entry form; a nested <form> is invalid HTML. Enter in the input triggers
 * the same path as the 新建 button.
 */
export function TagSheet({
  tags,
  selectedIds,
  onToggle,
  onCreate,
  onClose,
}: TagSheetProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const liveTags = tags
    .filter(tag => tag.archivedAt === null || selectedIds.includes(tag.id))
    .slice()
    .sort((a, b) => {
      // Live chips first, then the retired ones still attached to this row.
      const retired = Number(a.archivedAt !== null) - Number(b.archivedAt !== null);
      if (retired !== 0) return retired;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const message = await onCreate(draft);
      if (message === null) {
        setDraft('');
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet tag-sheet" role="dialog" aria-modal="true" aria-labelledby="tag-sheet-title">
      <div className="sheet__scrim" aria-hidden="true" onClick={onClose} />
      <div className="sheet__panel">
        <div className="sheet__head">
          <h2 className="sheet__title" id="tag-sheet-title">
            选标签
          </h2>
          <span className="sheet__version">
            已选 <b className="num">{selectedIds.length}</b>
          </span>
        </div>

        <div className="tag-sheet__chips">
          {liveTags.length === 0 ? (
            <p className="tag-sheet__empty">还没有标签</p>
          ) : (
            liveTags.map(tag => {
              const selected = selectedIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  className="tag-chip"
                  type="button"
                  data-tag-id={tag.id}
                  aria-pressed={selected}
                  onClick={() => onToggle(tag.id)}
                >
                  {tag.name}
                  {tag.archivedAt !== null && (
                    <span className="tag-chip__retired">已归档</span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="tag-sheet__create">
          <label className="tag-sheet__create-label" htmlFor="tag-sheet-new">
            新建标签
          </label>
          <div className="tag-sheet__create-row">
            <input
              id="tag-sheet-new"
              className="tag-sheet__input"
              type="text"
              autoComplete="off"
              placeholder="标签名，最多 12 个字"
              value={draft}
              disabled={busy}
              aria-invalid={error !== null ? 'true' : undefined}
              onChange={event => {
                setDraft(event.target.value);
                setError(null);
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void create();
                }
              }}
            />
            <button
              className="tag-sheet__create-button"
              type="button"
              disabled={busy}
              onClick={() => void create()}
            >
              新建
            </button>
          </div>
          {error !== null && (
            <p className="tag-sheet__error" role="alert">
              {error}
            </p>
          )}
        </div>

        <button className="tag-sheet__done" type="button" onClick={onClose}>
          完成
        </button>
      </div>
    </div>
  );
}

export interface TagPickerProps {
  /** Null while the database is still opening. */
  db: Db | null;
  /** Every known tag; archived rows are not offered. */
  tags: readonly Tag[];
  /** Selected tag ids, in the order the user picked them. */
  value: readonly string[];
  onChange(next: string[]): void;
}

/**
 * The 标签 row plus its sheet.
 *
 * Tags created inside the sheet are kept in a local list until the caller's
 * query catches up, so the chip and the row label update immediately instead
 * of blinking away while the refetch is in flight.
 */
export function TagPicker({ db, tags, value, onChange }: TagPickerProps) {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<Tag[]>([]);

  const known = [
    ...tags,
    ...created.filter(tag => !tags.some(candidate => candidate.id === tag.id)),
  ];
  const selectedTags = value
    .map(id => known.find(tag => tag.id === id))
    .filter((tag): tag is Tag => tag !== undefined);

  const label =
    selectedTags.length === value.length
      ? tagSelectionLabel(selectedTags)
      : `已选 ${value.length} 个`;

  const toggle = (id: string) => {
    onChange(
      value.includes(id)
        ? value.filter(candidate => candidate !== id)
        : [...value, id]
    );
  };

  const create = async (rawName: string): Promise<string | null> => {
    if (db === null) return '数据层还没准备好';
    const result = await createTagForPicker(db, rawName);
    if (result.tag === null) return result.error;

    const tag = result.tag;
    setCreated(previous =>
      previous.some(candidate => candidate.id === tag.id)
        ? previous
        : [...previous, tag]
    );
    if (!value.includes(tag.id)) onChange([...value, tag.id]);
    return null;
  };

  return (
    <>
      <button
        className="add-value"
        type="button"
        data-tag-trigger="true"
        aria-label={`标签：${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>

      {open && (
        <TagSheet
          tags={known}
          selectedIds={value}
          onToggle={toggle}
          onCreate={create}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
