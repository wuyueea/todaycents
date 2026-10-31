import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { formatCentsDisplay } from '../components/AmountText';
import { AmountKeypadField } from '../components/AmountKeypadField';
import { useDb, useQuery } from '../store/useDb';
import {
  allBalances,
  archiveAccount,
  createAccount,
  listAccounts,
  reconcileAccountBalance,
  txnCountByAccount,
  unarchiveAccount,
  updateAccount,
} from '../db/repos/accounts';
import type { CreateAccountInput } from '../db/repos/accounts';
import type { Db } from '../db/driver';
import type { Account, AccountType } from '../domain/types';
import { todayLocalISO } from '../domain/date';
import { formatCents, parseAmountToCents } from '../domain/money';

/**
 * 账户: the one place accounts are created, renamed, retyped, re-budgeted and
 * archived.
 *
 * Nothing here knows how many accounts exist or what they are called. The list
 * is listAccounts — live rows only — and the form offers the four account
 * types from the domain, never a fixed list of accounts. Archived rows are
 * filtered by the screen as well as by the repository, so a caller that hands
 * in a stale list still cannot show a retired account as if it were live.
 *
 * Saying 归档 is not deleting: archiveAccount only stamps archived_at, the
 * row and every transaction that points at it stay in the database, and the
 * month totals keep counting those rows. The screen says so next to the list,
 * because the account does disappear from every picker once archived. Archive
 * asks for confirmation, and 显示已归档 + 恢复 make the action reversible.
 *
 * 转账 no longer has a shortcut here: it is the third kind on 随手记 now, so
 * the page opens directly on 显示已归档 and its own list.
 */

/** How each account type reads. This is the domain's enum, not an account list. */
export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  cash: '现金',
  bank: '银行卡',
  ewallet: '电子钱包',
  prepaid: '预付卡',
};

/** The account types, in form order. */
export const ACCOUNT_TYPES: readonly AccountType[] = ['cash', 'bank', 'ewallet', 'prepaid'];

function isAccountType(value: string): value is AccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(value);
}

/** Everything the screen renders from, loaded as one snapshot. */
export interface AccountsData {
  /** Accounts in repository order; archived rows only when requested. */
  accounts: Account[];
  /**
   * Derived balances by account id. allBalances also carries archived ids;
   * the screen reads it by the ids of the rows it actually renders.
   */
  balances: Record<string, number>;
  /** Transaction rows per account, deleted rows included. */
  txnCounts: Record<string, number>;
}

export async function loadAccountsData(
  db: Db,
  opts: { includeArchived?: boolean } = {}
): Promise<AccountsData> {
  const accounts = await listAccounts(db, { includeArchived: opts.includeArchived });
  const balances = await allBalances(db);
  const txnCounts = await txnCountByAccount(db);
  return { accounts, balances, txnCounts };
}

/**
 * Archives one account only after the user confirms.
 *
 * The confirmation is the second tap that stops a mis-tap from hiding an
 * account and every picker it appears in. Passing the confirm function in makes
 * the gate testable without a browser; the screen uses window.confirm, which
 * the WebView implements. A declined confirmation writes nothing and reports
 * false.
 */
export async function archiveAccountWithConfirm(
  db: Db,
  account: Account,
  confirm: (message: string) => boolean = window.confirm
): Promise<boolean> {
  const confirmed = confirm(
    `归档「${account.name}」？它会从列表和记账选择里消失，历史流水仍保留；之后可在「显示已归档」里恢复。`
  );
  if (!confirmed) return false;
  await archiveAccount(db, account.id);
  return true;
}

/**
 * Parses the reconciliation field into integer cents.
 *
 * Blank means zero — an empty wallet is a real balance, not a missing value.
 * Everything else goes through parseAmountToCents exactly once, so the literal
 * "0" is rejected with the rest of the non-positive inputs: zero is expressed
 * by leaving the field empty, which keeps one representation of zero.
 */
export function parseReconciliationAmount(text: string): number | null {
  if (text.trim() === '') return 0;
  return parseAmountToCents(text);
}

/** Everything the 新增账户 form holds, exactly as typed. */
export interface AccountDraft {
  name: string;
  type: AccountType;
  /** Raw text; blank means 0. Parsing happens once, in the plan. */
  initialBalance: string;
  /** Raw text; blank means no monthly budget. */
  monthlyBudget: string;
}

/** What stopped a create, field by field. */
export interface AccountProblems {
  nameInvalid: boolean;
  initialBalanceInvalid: boolean;
  monthlyBudgetInvalid: boolean;
}

/** The decision about one create draft: what to write, or why nothing is written. */
export interface AccountCreatePlan {
  draft: AccountDraft;
  /** The exact repository input, or null when the draft is blocked. */
  input: CreateAccountInput | null;
  problems: AccountProblems;
  blocked: boolean;
}

export interface AccountCreateResult extends AccountCreatePlan {
  /** True only when a row was actually written. */
  created: boolean;
}

/** Everything the inline edit form holds. */
export interface AccountEditDraft {
  name: string;
  type: AccountType;
  /** Raw text; blank clears the budget. */
  monthlyBudget: string;
  /**
   * Raw opening-balance text. Omitted by callers that are not editing it; the
   * screen sets it only while the account has no transactions.
   */
  initialBalance?: string;
  /** False freezes the opening balance; defaults to true when text is present. */
  initialBalanceEditable?: boolean;
}

/** What stopped an edit, field by field. */
export interface AccountEditProblems {
  nameInvalid: boolean;
  initialBalanceInvalid: boolean;
  monthlyBudgetInvalid: boolean;
}

/** The columns an edit may change. */
export interface AccountEditPatch {
  name: string;
  type: AccountType;
  monthlyBudgetCents: number | null;
  /** Present only when this edit is allowed to touch the opening balance. */
  initialBalanceCents?: number;
}

export interface AccountEditPlan {
  draft: AccountEditDraft;
  patch: AccountEditPatch | null;
  problems: AccountEditProblems;
  blocked: boolean;
}

export interface AccountEditResult extends AccountEditPlan {
  saved: boolean;
}

function noCreateProblems(): AccountProblems {
  return { nameInvalid: false, initialBalanceInvalid: false, monthlyBudgetInvalid: false };
}

function noEditProblems(): AccountEditProblems {
  return { nameInvalid: false, initialBalanceInvalid: false, monthlyBudgetInvalid: false };
}

/**
 * Parses one optional money field.
 *
 * A blank field is "not provided" and yields the fallback (0 for the initial
 * balance, null for the budget). Anything else goes through parseAmountToCents,
 * which rejects negatives, zero and more than two decimals instead of rounding
 * them — a new account can never be opened with a negative balance through
 * this form.
 */
function parseOptionalCents(
  text: string,
  emptyCents: number | null
): { cents: number | null; invalid: boolean } {
  if (text.trim() === '') return { cents: emptyCents, invalid: false };
  const cents = parseAmountToCents(text);
  return { cents, invalid: cents === null };
}

export function planAccountCreate(draft: AccountDraft): AccountCreatePlan {
  const name = draft.name.trim();
  const initial = parseOptionalCents(draft.initialBalance, 0);
  const budget = parseOptionalCents(draft.monthlyBudget, null);

  const problems: AccountProblems = {
    nameInvalid: name === '',
    initialBalanceInvalid: initial.invalid,
    monthlyBudgetInvalid: budget.invalid,
  };
  const blocked =
    problems.nameInvalid || problems.initialBalanceInvalid || problems.monthlyBudgetInvalid;

  if (blocked) return { draft, input: null, problems, blocked: true };

  return {
    draft,
    input: {
      name,
      type: draft.type,
      initialBalanceCents: initial.cents ?? 0,
      monthlyBudgetCents: budget.cents,
    },
    problems,
    blocked: false,
  };
}

export function planAccountEdit(draft: AccountEditDraft): AccountEditPlan {
  const name = draft.name.trim();
  const budget = parseOptionalCents(draft.monthlyBudget, null);
  // An account with history cannot have its opening balance rewritten. The
  // screen marks such a draft not-editable; the repository refuses the field
  // anyway, so a stale or forged draft cannot get through.
  const editsOpeningBalance =
    draft.initialBalance !== undefined && draft.initialBalanceEditable !== false;
  const opening = editsOpeningBalance
    ? parseOptionalCents(draft.initialBalance ?? '', 0)
    : { cents: null, invalid: false };

  const problems: AccountEditProblems = {
    nameInvalid: name === '',
    initialBalanceInvalid: opening.invalid,
    monthlyBudgetInvalid: budget.invalid,
  };
  const blocked =
    problems.nameInvalid || problems.initialBalanceInvalid || problems.monthlyBudgetInvalid;

  if (blocked) return { draft, patch: null, problems, blocked: true };

  const patch: AccountEditPatch = {
    name,
    type: draft.type,
    monthlyBudgetCents: budget.cents,
  };
  if (editsOpeningBalance) patch.initialBalanceCents = opening.cents ?? 0;

  return { draft, patch, problems, blocked: false };
}

/**
 * The draft the inline edit form opens with.
 *
 * A zero opening balance is shown as a blank field, not "0.00": the money
 * parser intentionally rejects literal zero, and blank is this form's existing
 * representation of zero (the 0.00 placeholder still shows what it means).
 * Formatting zero as "0.00" made every edit of a zero-opening account fail
 * validation until the user guessed to clear the field. Non-zero values keep
 * their formatted text, and the field freezes once the account has history.
 */
export function accountEditDraftFor(
  account: Account,
  txnCount: number
): AccountEditDraft & { id: string } {
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    monthlyBudget:
      account.monthlyBudgetCents === null ? '' : formatCents(account.monthlyBudgetCents),
    initialBalance:
      account.initialBalanceCents === 0 ? '' : formatCents(account.initialBalanceCents),
    initialBalanceEditable: txnCount === 0,
  };
}

/** Writes a new account, and nothing at all when the draft is blocked. */
export async function submitAccountCreate(
  db: Db,
  draft: AccountDraft
): Promise<AccountCreateResult> {
  const plan = planAccountCreate(draft);
  if (plan.blocked || plan.input === null) return { ...plan, created: false };

  await createAccount(db, plan.input);
  return { ...plan, created: true };
}

/** Updates the editable columns of one account, and nothing at all when blocked. */
export async function submitAccountEdit(
  db: Db,
  accountId: string,
  draft: AccountEditDraft
): Promise<AccountEditResult> {
  const plan = planAccountEdit(draft);
  if (plan.blocked || plan.patch === null) return { ...plan, saved: false };

  await updateAccount(db, accountId, plan.patch);
  return { ...plan, saved: true };
}

/** The first thing wrong with a create, said plainly. */
function createProblemText(problems: AccountProblems): string {
  if (problems.nameInvalid) return '请填写账户名称';
  if (problems.initialBalanceInvalid) {
    return '期初余额必须是大于 0 的数字，最多两位小数；留空按 0 处理';
  }
  return '月度额度必须是大于 0 的数字，最多两位小数；留空表示不设额度';
}

/** The first thing wrong with an edit, said plainly. */
function editProblemText(problems: AccountEditProblems): string {
  if (problems.nameInvalid) return '请填写账户名称';
  if (problems.initialBalanceInvalid) {
    return '期初余额必须是大于 0 的数字，最多两位小数；留空按 0 处理';
  }
  return '月度额度必须是大于 0 的数字，最多两位小数；留空表示不设额度';
}

function emptyDraft(): AccountDraft {
  return { name: '', type: 'cash', initialBalance: '', monthlyBudget: '' };
}

interface StatusNote {
  kind: 'info' | 'success' | 'error';
  text: string;
}

export default function AccountsScreen() {
  const { db, bump } = useDb();
  const [showArchived, setShowArchived] = useState(false);
  const query = useQuery<AccountsData>(
    database => loadAccountsData(database, { includeArchived: showArchived }),
    [showArchived]
  );
  const data = query.data;
  // The repository already applies the filter; filtering again means a stale
  // snapshot can never resurrect an archived account when the toggle is off.
  const accounts = (data?.accounts ?? []).filter(
    account => showArchived || account.archivedAt === null
  );

  const [draft, setDraft] = useState<AccountDraft>(emptyDraft);
  const [createProblems, setCreateProblems] = useState<AccountProblems>(noCreateProblems);
  const [createError, setCreateError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<(AccountEditDraft & { id: string }) | null>(null);
  const [editProblems, setEditProblems] = useState<AccountEditProblems>(noEditProblems);
  const [editError, setEditError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState<{ id: string; amount: string } | null>(null);
  const [reconcileInvalid, setReconcileInvalid] = useState(false);
  const [status, setStatus] = useState<StatusNote | null>(null);
  const [busy, setBusy] = useState(false);

  const changeCreate = (patch: Partial<AccountDraft>, field?: keyof AccountProblems) => {
    setDraft(previous => ({ ...previous, ...patch }));
    if (field !== undefined) {
      setCreateProblems(previous =>
        previous[field] ? { ...previous, [field]: false } : previous
      );
    }
    setCreateError(null);
  };

  const changeEditing = (patch: Partial<AccountEditDraft>, field?: keyof AccountEditProblems) => {
    setEditing(previous => (previous === null ? previous : { ...previous, ...patch }));
    if (field !== undefined) {
      setEditProblems(previous => (previous[field] ? { ...previous, [field]: false } : previous));
    }
    setEditError(null);
  };

  const selectAccount = (account: Account) => {
    if (busy) return;
    if (selectedId === account.id) {
      setSelectedId(null);
      cancelEdit();
      cancelReconcile();
      return;
    }
    setSelectedId(account.id);
    cancelEdit();
    cancelReconcile();
    setStatus(null);
  };

  const startEdit = (account: Account) => {
    setSelectedId(account.id);
    setEditing(accountEditDraftFor(account, data?.txnCounts[account.id] ?? 0));
    setReconciling(null);
    setReconcileInvalid(false);
    setEditProblems(noEditProblems());
    setEditError(null);
    setStatus(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditProblems(noEditProblems());
    setEditError(null);
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (db === null || busy) return;

    setBusy(true);
    try {
      const result = await submitAccountCreate(db, draft);
      setCreateProblems(result.problems);

      if (!result.created) {
        setCreateError(createProblemText(result.problems));
        return;
      }

      setDraft(emptyDraft());
      setCreateProblems(noCreateProblems());
      setCreateError(null);
      setStatus({ kind: 'success', text: '已新增账户' });
      bump();
    } catch (reason) {
      setCreateError(`新增失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (db === null || editing === null || busy) return;

    setBusy(true);
    try {
      const result = await submitAccountEdit(db, editing.id, editing);
      setEditProblems(result.problems);

      if (!result.saved) {
        setEditError(editProblemText(result.problems));
        return;
      }

      setEditing(null);
      setEditError(null);
      setStatus({ kind: 'success', text: '账户已更新' });
      bump();
    } catch (reason) {
      setEditError(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const startReconcile = (account: Account) => {
    cancelEdit();
    setSelectedId(account.id);
    setReconciling({ id: account.id, amount: '' });
    setReconcileInvalid(false);
    setStatus(null);
  };

  const cancelReconcile = () => {
    setReconciling(null);
    setReconcileInvalid(false);
  };

  /**
   * One 对账 submit. The screen only parses what the user typed; the delta and
   * the write live in reconcileAccountBalance, so no balance arithmetic is
   * duplicated here.
   */
  const handleReconcile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (db === null || reconciling === null || busy) return;

    const actualBalanceCents = parseReconciliationAmount(reconciling.amount);
    if (actualBalanceCents === null) {
      setReconcileInvalid(true);
      return;
    }

    const account = data?.accounts.find(candidate => candidate.id === reconciling.id);
    setBusy(true);
    try {
      const result = await reconcileAccountBalance(db, {
        date: todayLocalISO(),
        accountId: reconciling.id,
        actualBalanceCents,
      });
      setReconciling(null);
      setReconcileInvalid(false);
      setStatus(
        result.deltaCents === 0
          ? { kind: 'info', text: '余额一致，无需调整' }
          : {
              kind: 'success',
              text: `已调整「${account?.name ?? ''}」的余额 ${formatCentsDisplay(result.deltaCents)}`,
            }
      );
      bump();
    } catch (reason) {
      setStatus({
        kind: 'error',
        text: `对账失败：${reason instanceof Error ? reason.message : String(reason)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleArchive = async (account: Account) => {
    if (db === null || busy) return;

    setBusy(true);
    try {
      const archived = await archiveAccountWithConfirm(db, account);
      if (!archived) return; // declined: nothing was written
      if (editing?.id === account.id) cancelEdit();
      setStatus({
        kind: 'info',
        text: `已归档「${account.name}」：它不再出现在列表和记账选择里，历史流水仍然保留，可在「显示已归档」里恢复。`,
      });
      bump();
    } catch (reason) {
      setStatus({
        kind: 'error',
        text: `归档失败：${reason instanceof Error ? reason.message : String(reason)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async (account: Account) => {
    if (db === null || busy) return;

    setBusy(true);
    try {
      await unarchiveAccount(db, account.id);
      setStatus({
        kind: 'success',
        text: `已恢复「${account.name}」，它重新出现在账户列表和记账选择里。`,
      });
      bump();
    } catch (reason) {
      setStatus({
        kind: 'error',
        text: `恢复失败：${reason instanceof Error ? reason.message : String(reason)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const toggleArchived = (checked: boolean) => {
    setShowArchived(checked);
    setSelectedId(null);
    setEditing(null);
    setReconciling(null);
    setReconcileInvalid(false);
    setStatus(null);
  };

  return (
    <div className="accounts-screen accounts-screen--v1">
      <header className="settings-header">
        <Link className="add-back" to="/settings" aria-label="返回设置">
          ‹
        </Link>
        <h1>账户</h1>
      </header>

      {data !== null && (
        <section className="accounts-hero" aria-label="全部账户余额">
          <span>全部账户余额</span>
          <strong className="num">
            {formatCentsDisplay(
              accounts
                .filter(account => account.archivedAt === null)
                .reduce((sum, account) => sum + (data.balances[account.id] ?? 0), 0)
            )}
          </strong>
        </section>
      )}

      {data === null ? (
        query.error !== null ? (
          <p className="accounts-note accounts-note--error" role="alert">
            账户暂时打不开
          </p>
        ) : (
          <p className="accounts-note" role="status">
            正在加载账户…
          </p>
        )
      ) : accounts.length === 0 ? (
        <p className="accounts-empty">还没有账户</p>
      ) : (
        <ul className="accounts-list">
          {accounts.map(account => (
            <li
              className={
                selectedId === account.id ? 'accounts-item is-selected' : 'accounts-item'
              }
              key={account.id}
              data-account-id={account.id}
            >
              {editing?.id === account.id ? (
                <form className="accounts-edit" onSubmit={handleEdit}>
                  <div className="add-field">
                    <label className="add-label" htmlFor={`edit-name-${account.id}`}>
                      名称
                    </label>
                    <input
                      id={`edit-name-${account.id}`}
                      className="accounts-input"
                      type="text"
                      autoComplete="off"
                      value={editing.name}
                      aria-invalid={editProblems.nameInvalid ? 'true' : undefined}
                      onChange={event => changeEditing({ name: event.target.value }, 'nameInvalid')}
                    />
                  </div>

                  <div className="add-field">
                    <label className="add-label" htmlFor={`edit-type-${account.id}`}>
                      类型
                    </label>
                    <select
                      id={`edit-type-${account.id}`}
                      className="add-account"
                      value={editing.type}
                      onChange={event => {
                        if (isAccountType(event.target.value)) {
                          changeEditing({ type: event.target.value });
                        }
                      }}
                    >
                      {ACCOUNT_TYPES.map(type => (
                        <option key={type} value={type}>
                          {ACCOUNT_TYPE_LABELS[type]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="add-field">
                    <label className="add-label" htmlFor={`edit-initial-${account.id}`}>
                      期初余额
                    </label>
                    <AmountKeypadField
                      id={`edit-initial-${account.id}`}
                      label="期初余额"
                      value={editing.initialBalance ?? ''}
                      onChange={value =>
                        changeEditing({ initialBalance: value }, 'initialBalanceInvalid')
                      }
                      invalid={editProblems.initialBalanceInvalid}
                      placeholder="0.00"
                      disabled={!editing.initialBalanceEditable}
                    />
                    {!editing.initialBalanceEditable && (
                      <p className="accounts-hint">
                        该账户已有流水，期初余额不可改；请用「对账」修正当前余额。
                      </p>
                    )}
                  </div>

                  <div className="add-field">
                    <label className="add-label" htmlFor={`edit-budget-${account.id}`}>
                      月度额度
                    </label>
                    <AmountKeypadField
                      id={`edit-budget-${account.id}`}
                      label="月度额度"
                      value={editing.monthlyBudget}
                      onChange={value =>
                        changeEditing({ monthlyBudget: value }, 'monthlyBudgetInvalid')
                      }
                      invalid={editProblems.monthlyBudgetInvalid}
                      placeholder="0.00"
                    />
                    <p className="accounts-hint">留空表示不设额度。</p>
                  </div>

                  {editError !== null && (
                    <p className="accounts-note accounts-note--error" role="alert">
                      {editError}
                    </p>
                  )}

                  <div className="accounts-edit__actions">
                    <button className="add-submit" type="submit" disabled={busy}>
                      保存
                    </button>
                    <button
                      className="accounts-action"
                      type="button"
                      onClick={cancelEdit}
                      disabled={busy}
                    >
                      取消
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <button
                    className="accounts-row"
                    type="button"
                    data-account-row
                    aria-expanded={selectedId === account.id}
                    onClick={() => selectAccount(account)}
                  >
                    <span className="accounts-row__main">
                      <span className="accounts-row__name">{account.name}</span>
                      <span className="accounts-row__type">{ACCOUNT_TYPE_LABELS[account.type]}</span>
                      {account.archivedAt !== null && (
                        <span className="accounts-row__archived">已归档</span>
                      )}
                    </span>
                    <span className="accounts-row__balance num">
                      {formatCentsDisplay(data.balances[account.id] ?? 0)}
                    </span>
                  </button>

                  {account.monthlyBudgetCents !== null && (
                    <p className="accounts-row__budget">
                      额度 {formatCentsDisplay(account.monthlyBudgetCents)}
                    </p>
                  )}

                  {selectedId === account.id &&
                    (account.archivedAt !== null ? (
                      <div className="accounts-actions">
                        <button
                          className="accounts-action"
                          type="button"
                          onClick={() => handleRestore(account)}
                          disabled={busy}
                        >
                          恢复
                        </button>
                      </div>
                    ) : (
                      <div className="accounts-actions">
                        <button
                          className="accounts-action"
                          type="button"
                          onClick={() => startReconcile(account)}
                          disabled={busy}
                        >
                          对账
                        </button>
                        <button
                          className="accounts-action"
                          type="button"
                          onClick={() => startEdit(account)}
                          disabled={busy}
                        >
                          编辑
                        </button>
                        <button
                          className="accounts-action accounts-action--danger"
                          type="button"
                          onClick={() => handleArchive(account)}
                          disabled={busy}
                        >
                          归档
                        </button>
                      </div>
                    ))}
                </>
              )}

              {reconciling?.id === account.id && (
                <form className="accounts-reconcile" onSubmit={handleReconcile}>
                  <div className="add-field">
                    <label className="add-label" htmlFor={`reconcile-${account.id}`}>
                      这张卡上现在实际有多少钱
                    </label>
                    <AmountKeypadField
                      id={`reconcile-${account.id}`}
                      label="对账金额"
                      value={reconciling.amount}
                      onChange={value => {
                        setReconciling({ id: account.id, amount: value });
                        setReconcileInvalid(false);
                      }}
                      invalid={reconcileInvalid}
                      placeholder="0.00"
                    />
                    <p className="accounts-hint">留空表示 0；差额会自动记为一笔「调整」，不计入收支。</p>
                    {reconcileInvalid && (
                      <p className="accounts-note accounts-note--error" role="alert">
                        请输入实际余额：大于 0 的数字，最多两位小数；0 请留空。
                      </p>
                    )}
                  </div>
                  <div className="accounts-edit__actions">
                    <button className="add-submit" type="submit" disabled={busy}>
                      确认对账
                    </button>
                    <button
                      className="accounts-action"
                      type="button"
                      onClick={cancelReconcile}
                      disabled={busy}
                    >
                      取消
                    </button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      <label className="accounts-toggle">
        <input
          type="checkbox"
          checked={showArchived}
          disabled={busy}
          onChange={event => toggleArchived(event.target.checked)}
        />
        显示已归档
      </label>

      {!showCreate && (
        <button
          className="accounts-add"
          type="button"
          onClick={() => {
            setShowCreate(true);
            window.setTimeout(() => {
              document.getElementById('accounts-create')?.scrollIntoView({ behavior: 'smooth' });
            }, 0);
          }}
        >
          ＋ 新增账户
        </button>
      )}

      {status !== null && (
        <p
          className={`accounts-note accounts-note--${status.kind}`}
          role={status.kind === 'error' ? 'alert' : 'status'}
        >
          {status.text}
        </p>
      )}

      <form
        className="accounts-form"
        id="accounts-create"
        hidden={!showCreate}
        onSubmit={handleCreate}
      >
        <h2 className="accounts-form__title">新增账户</h2>

        <div className="add-field">
          <label className="add-label" htmlFor="account-name">
            名称
          </label>
          <input
            id="account-name"
            className="accounts-input"
            type="text"
            autoComplete="off"
            value={draft.name}
            aria-invalid={createProblems.nameInvalid ? 'true' : undefined}
            onChange={event => changeCreate({ name: event.target.value }, 'nameInvalid')}
          />
        </div>

        <div className="add-field">
          <label className="add-label" htmlFor="account-type">
            类型
          </label>
          <select
            id="account-type"
            className="add-account"
            value={draft.type}
            onChange={event => {
              if (isAccountType(event.target.value)) {
                changeCreate({ type: event.target.value });
              }
            }}
          >
            {ACCOUNT_TYPES.map(type => (
              <option key={type} value={type}>
                {ACCOUNT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>

        <div className="add-field">
          <label className="add-label" htmlFor="account-initial">
            期初余额
          </label>
          <AmountKeypadField
            id="account-initial"
            label="期初余额"
            value={draft.initialBalance}
            onChange={value => changeCreate({ initialBalance: value }, 'initialBalanceInvalid')}
            invalid={createProblems.initialBalanceInvalid}
            placeholder="0.00"
          />
          <p className="accounts-hint">留空按 0 处理。</p>
        </div>

        <div className="add-field">
          <label className="add-label" htmlFor="account-budget">
            月度额度
          </label>
          <AmountKeypadField
            id="account-budget"
            label="月度额度"
            value={draft.monthlyBudget}
            onChange={value => changeCreate({ monthlyBudget: value }, 'monthlyBudgetInvalid')}
            invalid={createProblems.monthlyBudgetInvalid}
            placeholder="0.00"
          />
          <p className="accounts-hint">留空表示不设额度。</p>
        </div>

        {createError !== null && (
          <p className="accounts-note accounts-note--error" role="alert">
            {createError}
          </p>
        )}

        <button className="add-submit" type="submit" disabled={busy || db === null}>
          新增账户
        </button>
      </form>

    </div>
  );
}