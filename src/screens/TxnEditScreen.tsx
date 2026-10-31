import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AmountText } from '../components/AmountText';
import {
  AmountKeypad,
  applyAmountKey,
  formatAmountDraft,
} from '../components/AmountKeypad';
import { useDb, useQuery } from '../store/useDb';
import { listAccounts } from '../db/repos/accounts';
import { listCategories } from '../db/repos/categories';
import type { Category } from '../db/repos/categories';
import { getTxnTags, listTags, setTxnTags } from '../db/repos/tags';
import type { Tag } from '../db/repos/tags';
import { getTxnById, softDeleteTxn, updateTxn } from '../db/repos/txns';
import { listProjects, setTxnProject } from '../db/repos/projects';
import type { Project } from '../db/repos/projects';
import { setTxnFixedCost } from '../db/repos/fixedCosts';
import type { TxnRow } from '../db/repos/txns';
import { UNCATEGORIZED_CATEGORY_ID } from '../db/schema';
import type { Db } from '../db/driver';
import type { Account, Direction } from '../domain/types';
import { formatCents, parseAmountToCents } from '../domain/money';

/**
 * 编辑流水: correct one recorded row, or soft-delete it.
 *
 * The row is loaded by id, with the same joins the ledger uses, so a row from
 * any month opens: its month is a property of the row, not of the calendar.
 * An id that is not there — never recorded or already deleted — is a plain
 * "不存在" state rather than a form editing nothing.
 *
 * What may change is amount, category, account, note and tags. The date is
 * display-only: updateTxn has no date field and refuses a patch that carries
 * one, so a correction can never move a transaction to another day. Tags are
 * written by setTxnTags after updateTxn, because neither repository nests a
 * transaction.
 *
 * Transfers are read-only here. A transfer leg is one half of a matched pair;
 * updateTxn and softDeleteTxn both throw on it, and deleting one leg would
 * move money out of thin air. The screen therefore renders such a row as a
 * read-only summary without a save or delete control, and both commitTxnEdit
 * and deleteTxnRow refuse a transfer leg as a second line of defence.
 */

/** Everything the screen renders from, loaded as one snapshot. */
export interface TxnEditData {
  /** The row, or null when this month has no live row with that id. */
  row: TxnRow | null;
  /** Every live category; the screen narrows to the row's kind. */
  categories: Category[];
  /** Live accounts; the row's own account is appended if it was archived. */
  accounts: Account[];
  /** Every known tag; the sheet filters archived rows out. */
  tags: Tag[];
  /** Tags already attached to this row, archived history included. */
  rowTags: Tag[];
  /** Live projects only; the row's own archived project is named, not offered. */
  projects: Project[];
}

/** Everything one save needs, exactly as the form holds it. */
export interface TxnEditDraft {
  /** Raw text; parsing is this module's job, never the input's. */
  amount: string;
  categoryId: string | null;
  accountId: string;
  note: string;
  /** 0..N tag ids; written after updateTxn, in setTxnTags' own transaction. */
  tagIds: readonly string[];
  /**
   * The project the row should belong to, or null for none. Written only when
   * it differs from the row's current project, so re-saving an old row cannot
   * rewrite (or refuse) an assignment the user did not touch.
   */
  projectId: string | null;
}

/** What stopped a save, field by field, so each can be marked in place. */
export interface TxnEditProblems {
  amountInvalid: boolean;
  accountInvalid: boolean;
}

/** The decision about one draft: what to write, or why nothing is written. */
export interface TxnEditPlan {
  draft: TxnEditDraft;
  /** Positive integer cents; null whenever the amount is invalid. */
  amountCents: number | null;
  problems: TxnEditProblems;
  blocked: boolean;
}

/** One press of 保存: the plan plus whether the row was actually written. */
export interface TxnEditResult extends TxnEditPlan {
  saved: boolean;
}

/** How a row's direction reads. Transfer rows use this as their label. */
const KIND_LABELS: Record<Direction, string> = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  adjust: '调整',
};

function noProblems(): TxnEditProblems {
  return { amountInvalid: false, accountInvalid: false };
}

/**
 * Turns the form's text into exactly one update, or refuses it.
 *
 * The amount is parsed once, here, into positive integer cents: the repository
 * owns the sign (an edited expense stays negative), so no caller multiplies by
 * 100 and no float ever reaches SQL. Every field of the draft is carried back
 * untouched — a rejected amount stays in the input, never trimmed or rounded.
 */
export function planTxnEdit(draft: TxnEditDraft): TxnEditPlan {
  const amountCents = parseAmountToCents(draft.amount);
  const problems: TxnEditProblems = {
    amountInvalid: amountCents === null,
    accountInvalid: draft.accountId === '',
  };

  return {
    draft,
    amountCents,
    problems,
    blocked: problems.amountInvalid || problems.accountInvalid,
  };
}

/** One option of the account select. */
export interface AccountOption {
  id: string;
  name: string;
}

/**
 * The account select's options.
 *
 * listAccounts only returns live accounts. A row written before its account
 * was archived would then match no option and the select would silently show
 * a blank (or another account) while the state still held the archived id. The
 * row's own account is appended from the row itself so the select tells the
 * truth; picking it again changes nothing.
 */
export function accountOptionsFor(
  accounts: readonly Account[],
  row: TxnRow
): AccountOption[] {
  const options = accounts.map(account => ({ id: account.id, name: account.name }));
  if (!options.some(option => option.id === row.accountId)) {
    options.push({ id: row.accountId, name: `${row.accountName}（已归档）` });
  }
  return options;
}

/**
 * The categories a row of this direction may choose from.
 *
 * Transfers and adjustments are not categorised, so they get no picker at all.
 * Archived categories are already excluded by listCategories.
 */
function editCategoryOptions(
  categories: readonly Category[],
  direction: Direction
): Category[] {
  if (direction !== 'expense' && direction !== 'income') return [];
  return categories.filter(category => category.kind === direction);
}

/**
 * Loads one live row by id, plus the pickers.
 *
 * The lookup is by primary key, not by membership in a month's list, so an old
 * row opens regardless of which month the ledger is currently showing. A miss
 * is reported as row: null — the screen then shows the "already deleted" state
 * instead of a form that cannot save.
 */
export async function loadTxnEditData(db: Db, id: string): Promise<TxnEditData> {
  const row = await getTxnById(db, id);
  if (row === null) {
    return { row: null, categories: [], accounts: [], tags: [], rowTags: [], projects: [] };
  }

  const categories = await listCategories(db);
  const accounts = await listAccounts(db);
  const tags = await listTags(db, { includeArchived: true });
  const rowTags = await getTxnTags(db, id);
  const projects = await listProjects(db);
  return { row, categories, accounts, tags, rowTags, projects };
}

/**
 * Saves one planned edit through updateTxn. The single place the screen's
 * decision and the repository's guard meet, so a transfer leg is refused before
 * anything is written even if a caller forgets which rows are read-only.
 */
export async function commitTxnEdit(
  db: Db,
  row: TxnRow,
  draft: TxnEditDraft
): Promise<TxnEditResult> {
  if (row.direction === 'transfer') {
    throw new Error('转账记录不能在这里单独修改，需要整组处理');
  }

  const plan = planTxnEdit(draft);
  if (plan.blocked || plan.amountCents === null) {
    return { ...plan, saved: false };
  }

  await updateTxn(db, row.id, {
    amountCents: plan.amountCents,
    categoryId: draft.categoryId,
    accountId: draft.accountId,
    note: draft.note,
  });

  // A separate unit of work, exactly as on create: updateTxn never opens a
  // transaction, and setTxnTags opens one after the row update has committed.
  await setTxnTags(db, row.id, draft.tagIds);

  // The project is a third unit of work, and only a real change is written.
  // Re-saving the row's own archived project would otherwise be refused by
  // setTxnProject, and an untouched assignment must survive an unrelated edit.
  if (draft.projectId !== row.projectId) {
    await setTxnProject(db, row.id, draft.projectId);
  }
  return { ...plan, saved: true };
}

/**
 * The screen's only delete path: a soft delete for a normal row, and a refusal
 * for a transfer leg. softDeleteTxn itself also refuses a leg; checking here
 * keeps a transfer away from that call and keeps the error message about the
 * pair rather than about one row.
 */
export async function deleteTxnRow(
  db: Db,
  row: Pick<TxnRow, 'id' | 'direction'>
): Promise<void> {
  if (row.direction === 'transfer') {
    throw new Error('转账记录不能在这里删除，需要整组删除');
  }
  await softDeleteTxn(db, row.id);
}

/**
 * Soft-deletes one row only after the user confirms.
 *
 * The confirm is the second tap that stops a mis-tap from removing a row from
 * the ledger and every total. Passing it in makes the gate testable without a
 * browser; the screen uses window.confirm, which the WebView implements. A
 * declined confirmation writes nothing and reports false. A transfer leg still
 * goes through deleteTxnRow's refusal, never softDeleteTxn.
 */
export async function deleteTxnWithConfirm(
  db: Db,
  row: Pick<TxnRow, 'id' | 'direction'>,
  confirm: (message: string) => boolean = window.confirm
): Promise<boolean> {
  const confirmed = confirm('删除这笔流水？它会从流水和统计中消失，记录仍保留在本地，且不能撤销。');
  if (!confirmed) return false;
  await deleteTxnRow(db, row);
  return true;
}

/** The first thing wrong, said plainly, for the alert above the buttons. */
function problemText(problems: TxnEditProblems): string {
  return problems.amountInvalid
    ? '金额必须是大于 0 的数字，最多两位小数'
    : '请选择一个账户';
}

export default function TxnEditScreen() {
  const { db, bump } = useDb();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const id = params.id ?? '';

  const query = useQuery<TxnEditData>(
    database => loadTxnEditData(database, id),
    [id]
  );

  // undefined means "untouched": the loaded row still supplies the value.
  // null is a real category choice (未分类), and "" is a real amount edit, so
  // neither can double as the untouched sentinel.
  const [amountEdit, setAmountEdit] = useState<string | null>(null);
  const [categoryEdit, setCategoryEdit] = useState<string | null | undefined>(undefined);
  const [accountEdit, setAccountEdit] = useState<string | undefined>(undefined);
  const [noteEdit, setNoteEdit] = useState<string | undefined>(undefined);
  const [tagEdit, setTagEdit] = useState<string[] | undefined>(undefined);
  const [projectEdit, setProjectEdit] = useState<string | null | undefined>(undefined);
  const [fixedEdit, setFixedEdit] = useState<boolean | undefined>(undefined);
  const [fixedBusy, setFixedBusy] = useState(false);
  const [problems, setProblems] = useState<TxnEditProblems>(noProblems);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [amountPristine, setAmountPristine] = useState(false);
  const amountButtonRef = useRef<HTMLButtonElement>(null);
  const keypadPanelRef = useRef<HTMLDivElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const deletePanelRef = useRef<HTMLDivElement>(null);

  const data = query.data;
  const row = data?.row ?? null;

  // Derived, not copied with an effect: the form is usable the render the row
  // arrives, and a field the user has not touched keeps following the row.
  const amount = amountEdit ?? (row === null ? '' : formatCents(Math.abs(row.amountCents)));
  const categoryId = categoryEdit === undefined ? (row?.categoryId ?? null) : categoryEdit;
  const accountId = accountEdit ?? row?.accountId ?? '';
  const note = noteEdit ?? row?.note ?? '';
  const tagIds = tagEdit ?? (data?.rowTags ?? []).map(tag => tag.id);
  const projectId = projectEdit === undefined ? (row?.projectId ?? null) : projectEdit;
  // undefined means untouched: the loaded row still supplies the flag.
  const isFixed = fixedEdit ?? row?.isFixedCost ?? false;

  const categories =
    row === null ? [] : editCategoryOptions(data?.categories ?? [], row.direction);
  const accounts = row === null ? [] : accountOptionsFor(data?.accounts ?? [], row);
  const tagOptions = (data?.tags ?? []).filter(
    tag => tag.archivedAt === null || tagIds.includes(tag.id)
  );
  const activeProjects = (data?.projects ?? []).filter(
    project => project.status === 'active'
  );
  const archivedProject =
    row !== null &&
    row.projectId !== null &&
    row.projectName !== null &&
    !activeProjects.some(project => project.id === row.projectId)
      ? { id: row.projectId, name: row.projectName }
      : null;
  const projectOptions = archivedProject === null ? activeProjects : [...activeProjects, archivedProject];
  // 未分类 is a real system row, not a retired category: it gets no
  // "已停用" warning even though the sheet never offers it.
  const currentCategoryMissing =
    row !== null &&
    row.categoryId !== null &&
    row.categoryId !== UNCATEGORIZED_CATEGORY_ID &&
    !categories.some(category => category.id === row.categoryId);

  useEffect(() => {
    if (!keypadOpen) return;
    const panel = keypadPanelRef.current;
    const focusable = Array.from(
      panel?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []
    );
    (focusable[0] ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setKeypadOpen(false);
        return;
      }
      if (event.key !== 'Tab' || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      amountButtonRef.current?.focus();
    };
  }, [keypadOpen]);

  useEffect(() => {
    if (!confirmDelete) return;
    const panel = deletePanelRef.current;
    const focusable = Array.from(
      panel?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []
    );
    // Focus 取消, the safe action, not the destructive one.
    (focusable[focusable.length - 1] ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (focusable.length > 0) setConfirmDelete(false);
        return;
      }
      if (event.key !== 'Tab' || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      deleteButtonRef.current?.focus();
    };
  }, [confirmDelete]);

  const clearProblem = (field: keyof TxnEditProblems) => {
    setProblems(previous => (previous[field] ? { ...previous, [field]: false } : previous));
  };

  const changeCategory = (value: string | null) => {
    setCategoryEdit(value);
    setErrorText(null);
  };

  const changeAccount = (value: string) => {
    setAccountEdit(value);
    clearProblem('accountInvalid');
    setErrorText(null);
  };

  const changeNote = (value: string) => {
    setNoteEdit(value);
    setErrorText(null);
  };

  const changeTags = (next: string[]) => {
    setTagEdit(next);
    setErrorText(null);
  };

  const changeProject = (next: string | null) => {
    setProjectEdit(next);
    setErrorText(null);
  };

  const changeFixed = async (next: boolean) => {
    if (db === null || row === null || fixedBusy) return;
    setFixedEdit(next);
    setErrorText(null);
    setFixedBusy(true);
    try {
      await setTxnFixedCost(db, row.id, next);
      bump();
    } catch (reason) {
      setFixedEdit(!next);
      setErrorText(
        `固定支出标记失败：${reason instanceof Error ? reason.message : String(reason)}`
      );
    } finally {
      setFixedBusy(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (db === null || row === null || busy) return;

    setBusy(true);
    try {
      const result = await commitTxnEdit(db, row, {
        amount,
        categoryId,
        accountId,
        note,
        tagIds,
        projectId,
      });
      setProblems(result.problems);

      if (!result.saved) {
        setErrorText(problemText(result.problems));
        return;
      }

      // The write is committed before leaving; replace() keeps a stale edit
      // form out of the back stack.
      bump();
      navigate('/ledger', { replace: true });
    } catch (reason) {
      setErrorText(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (db === null || row === null || busy) return;

    setBusy(true);
    try {
      await deleteTxnRow(db, row);
      bump();
      navigate('/ledger', { replace: true });
    } catch (reason) {
      setConfirmDelete(false);
      setErrorText(`删除失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="txn-edit-screen txn-edit-screen--v1">
      <header className="add-header">
        <Link className="add-back" to="/ledger" aria-label="返回流水">
          ‹
        </Link>
        <h1>编辑流水</h1>
        {row !== null && (
          <span className="txn-edit-kind" data-direction={row.direction}>
            {KIND_LABELS[row.direction]}
          </span>
        )}
        {/* 原型把删除放在 nav 右端；它只对可编辑的普通流水出现。
            危险色文字 + 44px 点击区，不做实心红块。 */}
        {row !== null && row.direction !== 'transfer' && (
          <button
            ref={deleteButtonRef}
            className="txn-edit-delete"
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={busy || db === null}
          >
            删除
          </button>
        )}
      </header>

      {data === null ? (
        query.error !== null ? (
          <p className="add-note add-note--error" role="alert">
            这条记录暂时打不开
          </p>
        ) : (
          <p className="add-note" role="status">
            正在加载这条记录…
          </p>
        )
      ) : row === null ? (
        <p className="add-note" role="status">
          这笔记录不存在，可能已经被删除。
        </p>
      ) : row.direction === 'transfer' ? (
        <section className="txn-edit-readonly" aria-label="转账记录">
          <dl className="txn-edit-facts">
            <div>
              <dt>日期</dt>
              <dd>{row.occurredDate}</dd>
            </div>
            <div>
              <dt>账户</dt>
              <dd>{row.accountName}</dd>
            </div>
            <div>
              <dt>金额</dt>
              <dd>
                <AmountText cents={row.amountCents} direction={row.direction} />
              </dd>
            </div>
            {row.note !== '' && (
              <div>
                <dt>备注</dt>
                <dd>{row.note}</dd>
              </div>
            )}
          </dl>
          <p className="add-note">
            转账记录由一出一进两条腿组成，不能在这里单独修改。
          </p>
        </section>
      ) : (
        <form className="add-form" onSubmit={handleSubmit}>
          <div className="add-field add-field--amount">
            <span className="add-label">金额</span>
            <button
              ref={amountButtonRef}
              id="edit-amount"
              className="txn-amount-button"
              type="button"
              data-amount-open
              aria-label={`金额 ${formatAmountDraft(amount)}`}
              aria-invalid={problems.amountInvalid ? 'true' : undefined}
              onClick={() => {
                setAmountPristine(true);
                setKeypadOpen(true);
              }}
            >
              {formatAmountDraft(amount)}
            </button>
          </div>

          <p className="txn-edit-date">
            日期：<time dateTime={row.occurredDate}>{row.occurredDate}</time>（不可修改）
          </p>

          <div className="entry-group">
            <div className="entry-group__head">
              <span>分类</span>
            </div>
            <div className="entry-chips entry-chips--wrap">
              {categories.map(category => (
                <button
                  key={category.id}
                  type="button"
                  className={`entry-chip${categoryId === category.id ? ' is-on' : ''}`}
                  data-category-id={category.id}
                  aria-pressed={categoryId === category.id}
                  onClick={() => changeCategory(category.id)}
                >
                  {category.name}
                </button>
              ))}
            </div>
          </div>
          {currentCategoryMissing && (
            <p className="add-note">
              当前分类「{row.categoryName ?? '未分类'}」已停用；不重新选择会保留原分类。
            </p>
          )}

          <div className="entry-group">
            <div className="entry-group__head">
              <span>账户</span>
            </div>
            <div className="entry-chips entry-chips--wrap">
              {accounts.map(option => (
                <button
                  key={option.id}
                  type="button"
                  className={`entry-chip${accountId === option.id ? ' is-on' : ''}`}
                  data-account-id={option.id}
                  aria-pressed={accountId === option.id}
                  aria-invalid={problems.accountInvalid ? 'true' : undefined}
                  onClick={() => changeAccount(option.id)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          </div>

          <div className="entry-group">
            <div className="entry-group__head">
              <span>标签</span>
            </div>
            <div className="entry-chips entry-chips--wrap">
              {tagOptions.length === 0 ? (
                <span className="entry-group__hint">还没有标签</span>
              ) : (
                tagOptions.map(tag => (
                  <button
                    key={tag.id}
                    type="button"
                    className={`entry-chip${tagIds.includes(tag.id) ? ' is-on' : ''}`}
                    data-tag-id={tag.id}
                    aria-pressed={tagIds.includes(tag.id)}
                    onClick={() =>
                      changeTags(
                        tagIds.includes(tag.id)
                          ? tagIds.filter(candidate => candidate !== tag.id)
                          : [...tagIds, tag.id]
                      )
                    }
                  >
                    {tag.name}
                  </button>
                ))
              )}
            </div>
          </div>

          {(row.direction === 'expense' || row.direction === 'income') && (
            <>
              <div className="entry-group">
                <div className="entry-group__head">
                  <span>项目</span>
                </div>
                <div className="entry-chips entry-chips--wrap">
                  <button
                    type="button"
                    className={`entry-chip${projectId === null ? ' is-on' : ''}`}
                    data-project-clear="true"
                    aria-pressed={projectId === null}
                    onClick={() => changeProject(null)}
                  >
                    不归项目
                  </button>
                  {projectOptions.map(project => (
                    <button
                      key={project.id}
                      type="button"
                      className={`entry-chip${projectId === project.id ? ' is-on' : ''}`}
                      data-project-id={project.id}
                      aria-pressed={projectId === project.id}
                      onClick={() => changeProject(project.id)}
                    >
                      {project.name}
                      {archivedProject?.id === project.id ? '（已归档）' : ''}
                    </button>
                  ))}
                </div>
              </div>
              {row.projectArchived && row.projectName !== null && projectId === row.projectId && (
                <p className="add-note">
                  当前项目「{row.projectName}」已归档；不重新选择会保留原项目。
                </p>
              )}
            </>
          )}

          {row.direction === 'expense' && (
            <div className="txn-edit-fixed">
              <span className="add-label">固定支出</span>
              {/* A plain on/off control on the right: no status word, no
                  paragraph underneath. The thumb's position says the state. */}
              <button
                className="fixed-toggle"
                type="button"
                role="switch"
                data-fixed-toggle
                aria-checked={isFixed}
                aria-label="固定支出"
                disabled={busy || fixedBusy || db === null}
                onClick={() => {
                  void changeFixed(!isFixed);
                }}
              >
                <span
                  className={isFixed ? 'fixed-toggle__track is-on' : 'fixed-toggle__track'}
                  aria-hidden="true"
                >
                  <span className="fixed-toggle__thumb" />
                </span>
              </button>
            </div>
          )}

          <div className="txn-edit-note">
            <label className="add-label" htmlFor="edit-note">
              备注
            </label>
            <input
              id="edit-note"
              className="txn-edit-note__input"
              type="text"
              autoComplete="off"
              placeholder="备注（可不填）"
              value={note}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                changeNote(event.target.value)
              }
            />
          </div>

          {errorText !== null && (
            <p className="add-note add-note--error" role="alert">
              {errorText}
            </p>
          )}

          <button
            className="add-submit"
            type="submit"
            disabled={busy || db === null}
          >
            {busy ? '处理中…' : '保存'}
          </button>
        </form>
      )}

      {keypadOpen && (
        <div
          className="txn-keypad-layer"
          role="dialog"
          aria-modal="true"
          aria-label="金额键盘"
        >
          <div
            className="txn-keypad-scrim"
            aria-hidden="true"
            onClick={() => setKeypadOpen(false)}
          />
          <div className="txn-keypad-panel" ref={keypadPanelRef} tabIndex={-1}>
            <div className="txn-keypad-head">
              <span>金额</span>
              <strong aria-live="polite">{formatAmountDraft(amount)}</strong>
            </div>
            <AmountKeypad
              value={amount}
              onChange={next => {
                setAmountEdit(next);
                clearProblem('amountInvalid');
                setErrorText(null);
              }}
              onKey={key => {
                // The first digit replaces the loaded amount; a decimal starts
                // a fresh cents value; edit keys keep the old draft editable.
                let next: string;
                if (amountPristine && /^\d$/.test(key)) {
                  next = key;
                } else if (amountPristine && key === '.') {
                  next = '0.';
                } else {
                  next = applyAmountKey(amount, key);
                }
                setAmountPristine(false);
                setAmountEdit(next);
                clearProblem('amountInvalid');
                setErrorText(null);
              }}
              actionLabel="完成"
              actionType="button"
              actionData="done"
              onAction={() => setKeypadOpen(false)}
            />
          </div>
        </div>
      )}

      {confirmDelete && row !== null && (
        <div
          className="sheet txn-delete-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="txn-delete-title"
        >
          <div
            className="sheet__scrim"
            aria-hidden="true"
            onClick={() => {
              if (!busy) setConfirmDelete(false);
            }}
          />
          <div className="sheet__panel" ref={deletePanelRef} tabIndex={-1}>
            <h2 className="sheet__title" id="txn-delete-title">
              删除这笔流水
            </h2>
            <p className="sheet__text">
              它会从流水和统计中消失，记录仍保留在本地，且不能撤销。
            </p>
            <button
              className="sheet__danger"
              type="button"
              disabled={busy}
              onClick={() => void handleDelete()}
            >
              {busy ? '正在删除…' : '删除'}
            </button>
            <button
              className="sheet__secondary"
              type="button"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}