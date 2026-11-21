import { useEffect, useLayoutEffect, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AmountText } from '../components/AmountText';
import { TransferEditForm } from './TransferEditForm';
import {
  AmountKeypad,
  formatAmountDraft,
} from '../components/AmountKeypad';
import { Sheet } from '../components/Sheet';
import { registerBackHandler } from '../components/backButton';
import { createSaveExit } from '../components/saveExit';
import { isPlainLinkClick, projectTransactionsParent, readTxnEditOrigin } from '../components/TxnEditNavigation';
import { useDb, useQuery } from '../store/useDb';
import { listAccounts } from '../db/repos/accounts';
import { listCategories } from '../db/repos/categories';
import type { Category } from '../db/repos/categories';
import { getTxnTags, listTags, setTxnTags } from '../db/repos/tags';
import type { Tag } from '../db/repos/tags';
import { getTxnById, updateTxn } from '../db/repos/txns';
import { loadTransferEditData } from '../db/repos/transfers';
import type { TransferEditData } from '../db/repos/transfers';
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
 * Income and expense edits can change amount, category, account, note and tags.
 * Adjustments only allow note edits. The date is
 * display-only: updateTxn has no date field and refuses a patch that carries
 * one, so a correction can never move a transaction to another day. Tags and
 * the project are written by setTxnTags and setTxnProject inside the same
 * transaction as the row update, so an edit lands whole or not at all.
 *
 * A transfer uses its group editor. The single-row update and commit paths
 * reject transfer legs independently.
 */

/** Everything the screen renders from, loaded as one snapshot. */
export interface TxnEditData {
  /** The row, or null when this month has no live row with that id. */
  row: TxnRow | null;
  /** Present when the requested row belongs to a complete, editable transfer. */
  transfer?: TransferEditData;
  /** Categories of the row's kind, including archived entries for historical labels. */
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
  /** 0..N tag ids; written in the same transaction as the row update. */
  tagIds: readonly string[];
  /**
   * The project the row should belong to, or null for none. Written only when
   * it differs from the row's current project, so re-saving an old row cannot
   * rewrite (or refuse) an assignment the user did not touch.
   */
  projectId: string | null;
  /** The edited expense flag. Omitted when the user leaves it untouched. */
  isFixedCost?: boolean;
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
 * Loads one live row by id, plus the pickers.
 *
 * The lookup is by primary key, not by membership in a month's list, so an old
 * row opens regardless of which month the ledger is currently showing. A miss
 * is reported as row: null — the screen then shows the "already deleted" state
 * instead of a form that cannot save.
 */
export async function loadTxnEditData(db: Db, id: string): Promise<TxnEditData> {
  const row = await getTxnById(db, id);
  if (row === null || row.direction === 'adjust' || row.direction === 'transfer') {
    const data: TxnEditData = { row, categories: [], accounts: [], tags: [], rowTags: [], projects: [] };
    if (row?.direction === 'transfer' && row.transferGroupId) {
      const transfer = await loadTransferEditData(db, row.transferGroupId);
      if (transfer && (transfer.pair.fromTxnId === id || transfer.pair.toTxnId === id)) data.transfer = transfer;
    }
    return data;
  }

  const categories = await listCategories(db, row.direction, { includeArchived: true });
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
  if (row.direction === 'adjust') {
    await db.transaction(tx => updateTxn(tx, row.id, { note: draft.note }));
    return {
      draft,
      amountCents: Math.abs(row.amountCents),
      problems: noProblems(),
      blocked: false,
      saved: true,
    };
  }

  const plan = planTxnEdit(draft);
  if (plan.blocked || plan.amountCents === null) {
    return { ...plan, saved: false };
  }
  // Narrowed here, outside the callback: a property read inside the closure is
  // not narrowed by the guard above.
  const amountCents = plan.amountCents;

  // Keep the row, fixed-cost flag, tags and project in one transaction so
  // a failure in any write rolls back the entire edit.
  await db.transaction(async tx => {
    await updateTxn(tx, row.id, {
      amountCents,
      categoryId: draft.categoryId,
      accountId: draft.accountId,
      note: draft.note,
    });

    if (row.direction === 'expense' && draft.isFixedCost !== undefined) {
      await setTxnFixedCost(tx, row.id, draft.isFixedCost);
    }

    await setTxnTags(tx, row.id, draft.tagIds);

    // The project is written only on a real change. Re-saving the row's own
    // archived project would otherwise be refused by setTxnProject, and an
    // untouched assignment must survive an unrelated edit.
    if (draft.projectId !== row.projectId) {
      await setTxnProject(tx, row.id, draft.projectId);
    }
  });
  return { ...plan, saved: true };
}

/** The first thing wrong, said plainly, for the alert above the buttons. */
function problemText(problems: TxnEditProblems): string {
  return problems.amountInvalid
    ? '金额必须是大于 0 的数字，最多两位小数'
    : '请选择一个账户';
}

function TxnEditFacts({ row }: { row: TxnRow }) {
  return (
    <dl className="txn-edit-facts">
      <div>
        <dt>日期</dt>
        <dd><time dateTime={row.occurredDate}>{row.occurredDate}</time></dd>
      </div>
      <div>
        <dt>账户</dt>
        <dd>{row.accountName}</dd>
      </div>
      <div>
        <dt>{row.direction === 'adjust' ? '对账差额' : '金额'}</dt>
        <dd>
          <AmountText cents={row.amountCents} direction={row.direction} />
        </dd>
      </div>
      {row.direction === 'transfer' && row.note !== '' && (
        <div>
          <dt>备注</dt>
          <dd>{row.note}</dd>
        </div>
      )}
    </dl>
  );
}

export default function TxnEditScreen() {
  const { db, bump } = useDb();
  const navigate = useNavigate();
  const origin = readTxnEditOrigin(useLocation().state);
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
  const [problems, setProblems] = useState<TxnEditProblems>(noProblems);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keypadOpen, setKeypadOpen] = useState(false);

  const leaveEdit = () => {
    if (origin === null) navigate('/ledger', { replace: true });
    else navigate(-1);
  };
  const exit = createSaveExit(busy, leaveEdit);

  useLayoutEffect(() => {
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
  }, [id]);

  // While a save is in flight, swallow the hardware back gesture: the write is
  // still landing, and leaving now would hide a commit or invite a duplicate.
  useEffect(() => {
    if (exit.canLeave) return;
    return registerBackHandler(() => true);
  }, [exit.canLeave]);

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

  const categories = (data?.categories ?? []).filter(category => category.kind === row?.direction);
  const liveCategories = categories.filter(category => category.archivedAt === null);
  const selectedCategory = categories.find(category => category.id === categoryId);
  const topCategories = liveCategories.filter(category => category.parentId === null);
  const selectedTop = topCategories.find(
    category => category.id === (selectedCategory?.parentId ?? selectedCategory?.id)
  );
  const subCategories = selectedTop
    ? liveCategories.filter(category => category.parentId === selectedTop.id)
    : [];
  const historicalCategory =
    categoryId !== null && categoryId !== UNCATEGORIZED_CATEGORY_ID &&
    (!selectedTop || selectedCategory?.archivedAt !== null);
  const historicalParent = historicalCategory
    ? categories.find(category => category.id === selectedCategory?.parentId)
    : undefined;
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

  const changeFixed = (next: boolean) => {
    setFixedEdit(next);
    setErrorText(null);
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
        isFixedCost: fixedEdit,
      });
      setProblems(result.problems);

      if (result.saved) {
        // Keep the exit guard active until the history step removes the form.
        bump();
        leaveEdit();
        return;
      }
      setErrorText(problemText(result.problems));
    } catch (reason) {
      setErrorText(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    }
    setBusy(false);
  };

  const sourcePath = origin?.pathname ?? '';
  let backLabel = '返回流水';
  if (sourcePath === '/') backLabel = '返回今天';
  else if (/^\/settings\/fixed\/?$/.test(sourcePath)) backLabel = '返回固定支出';
  else if (projectTransactionsParent(sourcePath) !== null) backLabel = '返回项目流水';
  else if (sourcePath.startsWith('/settings/projects/')) backLabel = '返回项目详情';

  return (
    <div className="txn-edit-screen txn-edit-screen--v1">
      <header className="add-header">
        <Link
          className="add-back"
          to={origin ?? '/ledger'}
          aria-label={backLabel}
          aria-disabled={exit.canLeave ? undefined : true}
          tabIndex={exit.canLeave ? undefined : -1}
          onClick={event => {
            if (!exit.canLeave || isPlainLinkClick(event)) {
              event.preventDefault();
              exit.requestLeave();
            }
          }}
        >
          ‹
        </Link>
        <h1>{row?.direction === 'transfer' ? '转账详情' : '编辑流水'}</h1>
        {row !== null && row.direction !== 'transfer' && (
          <span className="txn-edit-kind" data-direction={row.direction}>
            {KIND_LABELS[row.direction]}
          </span>
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
      ) : row.direction === 'transfer' && data.transfer ? (
        <TransferEditForm key={data.transfer.pair.groupId} data={data.transfer} db={db} busy={busy}
          setBusy={setBusy} onSaved={() => { bump(); leaveEdit(); }} />
      ) : row.direction === 'transfer' ? (
        <section className="txn-edit-readonly" aria-label="转账记录">
          <TxnEditFacts row={row} />
          <p className="add-note" role="status">转账记录不完整或存在异常，仅可查看这条流水。</p>
        </section>
      ) : (
        <form className="add-form" onSubmit={handleSubmit}>
          {row.direction === 'adjust' ? (
            <section className="txn-edit-readonly" aria-label="对账调整">
              <TxnEditFacts row={row} />
              <p className="add-note">这里只能编辑备注。要修正余额，请到「设置 → 账户」对原账户重新对账。</p>
            </section>
          ) : (
            <>
              <div className="add-field add-field--amount">
                <span className="add-label">金额</span>
                <button
                  id="edit-amount"
                  className="txn-amount-button"
                  type="button"
                  data-amount-open
                  aria-label={`金额 ${formatAmountDraft(amount)}`}
                  aria-invalid={problems.amountInvalid ? 'true' : undefined}
                  onClick={() => setKeypadOpen(true)}
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
                  {topCategories.map(category => (
                    <button
                      key={category.id}
                      type="button"
                      className={`entry-chip${selectedTop?.id === category.id ? ' is-on' : ''}`}
                      data-category-id={category.id}
                      aria-pressed={selectedTop?.id === category.id}
                      onClick={() => {
                        if (selectedTop?.id !== category.id) changeCategory(category.id);
                      }}
                    >
                      {category.name}
                    </button>
                  ))}
                </div>
              </div>
              {selectedTop && (subCategories.length > 0 || selectedCategory?.parentId === selectedTop.id) && (
                <div className="entry-group" role="group" aria-labelledby="edit-subcategory-heading">
                  <div className="entry-group__head">
                    <span id="edit-subcategory-heading">细分 · {selectedTop.name}</span>
                  </div>
                  <div className="entry-chips entry-chips--wrap">
                    <button
                      type="button"
                      className={`entry-chip is-ghost${categoryId === selectedTop.id ? ' is-on' : ''}`}
                      data-subcategory-id=""
                      aria-pressed={categoryId === selectedTop.id}
                      onClick={() => changeCategory(selectedTop.id)}
                    >
                      不细分
                    </button>
                    {subCategories.map(category => (
                      <button
                        key={category.id}
                        type="button"
                        className={`entry-chip is-ghost${categoryId === category.id ? ' is-on' : ''}`}
                        data-subcategory-id={category.id}
                        aria-pressed={categoryId === category.id}
                        onClick={() => changeCategory(category.id)}
                      >
                        {category.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {historicalCategory && (
                <p className="add-note">
                  当前分类「{historicalParent && `${historicalParent.name} / `}
                  {selectedCategory?.name ?? row.categoryName ?? '原分类'}」不可选。不重新选择会保留原分类。
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
                    disabled={busy || db === null}
                    onClick={() => changeFixed(!isFixed)}
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

            </>
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

      {keypadOpen && (row?.direction === 'expense' || row?.direction === 'income') && (
        <Sheet variant="keypad" ariaLabel="金额键盘" onClose={() => setKeypadOpen(false)}>
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
            replaceOnFirstKey
            actionLabel="完成"
            actionType="button"
            actionData="done"
            onAction={() => setKeypadOpen(false)}
          />
        </Sheet>
      )}

    </div>
  );
}
