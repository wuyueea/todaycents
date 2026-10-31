import { useEffect, useRef, useState } from 'react';
import {
  AmountKeypad,
  applyAmountKey,
  formatAmountDraft,
} from '../components/AmountKeypad';
import type { ChangeEvent, FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createTagForPicker } from '../components/TagPicker';
import { useDb, useQuery } from '../store/useDb';
import { listAccounts } from '../db/repos/accounts';
import { listCategories } from '../db/repos/categories';
import type { Category } from '../db/repos/categories';
import { listTags, setTxnTags } from '../db/repos/tags';
import type { Tag } from '../db/repos/tags';
import { createExpense, createIncome, lastEntryDefaults } from '../db/repos/txns';
import { listProjects, setTxnProject } from '../db/repos/projects';
import type { Project } from '../db/repos/projects';
import { createTransfer } from '../db/repos/transfers';
import type { EntryDefaults } from '../db/repos/txns';
import { UNCATEGORIZED_CATEGORY_ID } from '../db/schema';
import type { Db } from '../db/driver';
import type { Account, Direction } from '../domain/types';
import { formatMonthDay, todayLocalISO } from '../domain/date';
import { parseAmountToCents } from '../domain/money';

/**
 * The three kinds one 随手记 form can write. adjust exists in the domain (a
 * reconciliation writes it) but is never typed by hand, so it is not offered.
 */
export type EntryDirection = Extract<Direction, 'expense' | 'income' | 'transfer'>;

/** The two kinds that carry a category; each keeps its own last-used prefill. */
export type CategoryDirection = Extract<EntryDirection, 'expense' | 'income'>;

/** Everything the screen renders from, loaded as one snapshot. */
export interface QuickEntryData {
  /** Live categories of both kinds; the screen filters by direction. */
  categories: Category[];
  accounts: Account[];
  /** Every known tag; the sheet filters archived rows out. */
  tags: Tag[];
  /** Live projects only: a finished trip must not receive a new row. */
  projects: Project[];
  /** Last used category and account per category-bearing direction, for prefill. */
  lastUsed: Record<CategoryDirection, EntryDefaults>;
}

/** Everything one submit needs, exactly as the form holds it. */
export interface QuickEntryDraft {
  direction: EntryDirection;
  /** Raw text; parsing is the plan's job, never the input's. */
  amount: string;
  /** 分类, used by 支出 and 收入 only; a transfer is never categorised. */
  categoryId: string | null;
  /** The one account of a 支出 or 收入 row; a transfer uses the pair below. */
  accountId: string;
  /** 转出账户, used by 转账 only. */
  fromAccountId: string;
  /** 转入账户, used by 转账 only. */
  toAccountId: string;
  /** Optional one-line note; blank is stored as the empty string. */
  note: string;
  /** 0..N tag ids; written after the row exists, never inside its insert. */
  tagIds: readonly string[];
  /** One project or none; written after the row exists, like the tags. */
  projectId: string | null;
}

/** What stopped a submit, field by field, so each can be marked in place. */
export interface QuickEntryProblems {
  amountInvalid: boolean;
  categoryInvalid: boolean;
  accountInvalid: boolean;
  /** 转账 only: no 转出账户 chosen. */
  fromAccountInvalid: boolean;
  /** 转账 only: no 转入账户 chosen. */
  toAccountInvalid: boolean;
  /**
   * 转账 only: both sides hold the same account. Kept apart from the two
   * "missing" flags so the form can say what is actually wrong.
   */
  sameAccount: boolean;
}

/** The decision about one draft: what to write, or why nothing is written. */
export interface QuickEntryPlan {
  draft: QuickEntryDraft;
  /** Positive integer cents; null whenever the amount is invalid. */
  amountCents: number | null;
  problems: QuickEntryProblems;
  blocked: boolean;
}

/** One press of 保存: the plan plus whether a row was actually written. */
export interface QuickEntryResult extends QuickEntryPlan {
  /** The shared id of both legs when a transfer was written; null otherwise. */
  transferGroupId: string | null;
  written: boolean;
}

const DIRECTIONS: ReadonlyArray<{ value: EntryDirection; label: string }> = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '转账' },
];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function noProblems(): QuickEntryProblems {
  return {
    amountInvalid: false,
    categoryInvalid: false,
    accountInvalid: false,
    fromAccountInvalid: false,
    toAccountInvalid: false,
    sameAccount: false,
  };
}

/**
 * Turns the form's text into exactly one entry's worth of input, or refuses it.
 *
 * parseAmountToCents rejects zero and negatives as well as malformed text, so
 * "0" can never be booked as a movement of nothing. This is one deliberate
 * entry, not a grid cell where zero means "nothing here": unlike the retired
 * day grid, a zero stays an error. The draft is carried back untouched: a
 * rejected amount stays in the input, it is never trimmed, rounded or cleared.
 *
 * The rules follow the chosen kind. 支出 and 收入 need one category and one
 * account; 转账 needs two different accounts and no category at all, because a
 * transfer is money the user already owns, never spending.
 */
export function planQuickEntry(draft: QuickEntryDraft): QuickEntryPlan {
  const amountCents = parseAmountToCents(draft.amount);
  const isTransfer = draft.direction === 'transfer';
  const problems: QuickEntryProblems = {
    amountInvalid: amountCents === null,
    categoryInvalid: isTransfer
      ? false
      : draft.categoryId === null || draft.categoryId === '',
    accountInvalid: isTransfer ? false : draft.accountId === '',
    fromAccountInvalid: isTransfer && draft.fromAccountId === '',
    toAccountInvalid: isTransfer && draft.toAccountId === '',
    sameAccount:
      isTransfer && draft.fromAccountId !== '' && draft.fromAccountId === draft.toAccountId,
  };

  return {
    draft,
    amountCents,
    problems,
    blocked:
      problems.amountInvalid ||
      problems.categoryInvalid ||
      problems.accountInvalid ||
      problems.fromAccountInvalid ||
      problems.toAccountInvalid ||
      problems.sameAccount,
  };
}

/**
 * Writes one entry of the chosen kind, and nothing at all when the plan is
 * blocked. 支出 and 收入 decide both the repository and therefore the sign: an
 * income can never be written through createExpense here. 转账 goes through
 * createTransfer, which writes both signed legs inside one transaction.
 */
export async function submitQuickEntry(
  db: Db,
  dateISO: string,
  draft: QuickEntryDraft
): Promise<QuickEntryResult> {
  const plan = planQuickEntry(draft);
  if (plan.blocked || plan.amountCents === null) {
    return { ...plan, transferGroupId: null, written: false };
  }

  // A transfer is neither a txn create nor a tagged row: no category, no tags,
  // no project, just the pair of legs the transfer repository owns.
  if (draft.direction === 'transfer') {
    const transferGroupId = await createTransfer(db, {
      date: dateISO,
      fromAccountId: draft.fromAccountId,
      toAccountId: draft.toAccountId,
      amountCents: plan.amountCents,
      // A note of spaces is no note: the ledger would render an empty line
      // above the account name. Trimmed here, at the one place a row is written.
      note: draft.note.trim(),
    });
    return { ...plan, transferGroupId, written: true };
  }

  const input = {
    date: dateISO,
    accountId: draft.accountId,
    amountCents: plan.amountCents,
    categoryId: draft.categoryId,
    // Same rule for the other two kinds: a spaces-only note is stored blank.
    note: draft.note.trim(),
  };

  let txnId: string;
  if (draft.direction === 'expense') {
    txnId = await createExpense(db, input);
  } else if (draft.direction === 'income') {
    txnId = await createIncome(db, input);
  } else {
    // Unreachable through the type, but refuse loudly rather than book income
    // through the expense path if a plain object ever carries another value.
    throw new RangeError(`unsupported direction: ${String(draft.direction)}`);
  }

  // Tag assignment is a second unit of work: createExpense/createIncome never
  // open a transaction (submitDay already wraps one and nesting is rejected).
  // Writing tags after the row exists is what keeps both paths usable.
  await setTxnTags(db, txnId, draft.tagIds);

  // A project can gather both sides of a bounded story (a trip's costs and its
  // reimbursements). The transfer path returned above, so only expense/income
  // can reach this write.
  if (draft.projectId !== null) {
    await setTxnProject(db, txnId, draft.projectId);
  }

  return { ...plan, transferGroupId: null, written: true };
}

/** Where a successful save goes, and what runs just before it leaves. */
export interface QuickEntryExit {
  /** Runs first, so the refetch is already in flight when 今天 mounts. */
  onSaved: () => void;
  /** Replaces the form in history: back from 今天 must not reopen /add. */
  navigate: (to: string, options: { replace: true }) => void;
}

/**
 * Writes one entry and leaves for 今天, or stays put when nothing was written.
 *
 * The row is committed before navigation, and onSaved (the app's revision bump)
 * runs before the route changes, so the list that mounts next already sees the
 * new row. A rejected draft never navigates: the caller keeps the form and
 * paints the problems. Navigation replaces /add in history, so pressing back
 * from 今天 cannot reopen a form whose row is already saved. A transfer takes
 * this same path, so a saved transfer lands on 今天 exactly like an expense.
 */
export async function saveQuickEntryAndLeave(
  db: Db,
  dateISO: string,
  draft: QuickEntryDraft,
  exit: QuickEntryExit
): Promise<QuickEntryResult> {
  const result = await submitQuickEntry(db, dateISO, draft);
  if (!result.written) return result;

  exit.onSaved();
  exit.navigate('/', { replace: true });
  return result;
}

/** The first thing wrong, said plainly, for the alert above the button. */
function problemText(problems: QuickEntryProblems): string {
  if (problems.sameAccount) return '转入账户不能和转出账户相同';
  if (problems.fromAccountInvalid) return '请选择转出账户';
  if (problems.toAccountInvalid) return '请选择转入账户';
  if (problems.amountInvalid) return '金额必须是大于 0 的数字，最多两位小数';
  if (problems.categoryInvalid) return '请选择一个分类';
  return '请选择一个账户';
}

/**
 * Keeps a quick entry on a real day that is not in the future.
 *
 * The input carries max=today, but a browser may ignore it and a cleared date
 * produces "". Both cases fall back to today rather than leaving the form
 * without a date or booking tomorrow by accident. The transfer form uses this
 * same guard, so its date behaves exactly like an expense date.
 */
export function clampEntryDate(value: string, todayISO: string): string {
  return ISO_DAY.test(value) && value <= todayISO ? value : todayISO;
}

/** The muted line under a back-filled date; null when the date is today. */
export function entryDateHint(dateISO: string, todayISO: string): string | null {
  return dateISO === todayISO ? null : `补记 ${formatMonthDay(dateISO)}`;
}

/**
 * The two accounts a transfer starts on, chosen from the live list only.
 *
 * 转出: the bank account, else the first live account.
 * 转入: the first account carrying a monthly budget (the prepaid card the
 *       top-up refills, matched by the budget marker rather than by its name),
 *       else the second live account.
 *
 * Both fallbacks refuse to return the same account twice: a form that opens
 * already invalid would teach the user to ignore the error. When there is no
 * second account at all, 转入 stays empty and the submit says why.
 */
export function pickTransferDefaults(accounts: readonly Account[]): {
  fromAccountId: string;
  toAccountId: string;
} {
  const fromAccountId = (accounts.find(account => account.type === 'bank') ?? accounts[0])?.id ?? '';
  const budgeted = accounts.find(account => account.monthlyBudgetCents !== null);
  const second = accounts[1];

  const toAccountId =
    (budgeted !== undefined && budgeted.id !== fromAccountId ? budgeted.id : undefined) ??
    (second !== undefined && second.id !== fromAccountId ? second.id : undefined) ??
    accounts.find(account => account.id !== fromAccountId)?.id ??
    '';

  return { fromAccountId, toAccountId };
}

/**
 * 随手记: a pushed page with the app's only capture form, for all three kinds.
 *
 * The page is opened from 今天's floating + and covers the tab bar while it is
 * open. There is no list, no monthly total and no balance here: the page is the
 * one action of writing a row. The amount is focused on open, the date defaults
 * to today and cannot move into the future, and a non-today date says 补记 so
 * the user can see they are filling in an earlier day.
 *
 * 支出 and 收入 are prefilled for the common case: 支出 is already selected and
 * the last used expense category and account are already chosen. Switching to
 * 收入 swaps the category list and keeps a separate choice per direction. The
 * tag row under the account opens a flat multi-select sheet; tags are written
 * after the row exists, never inside its insert.
 *
 * 转账 is the third choice, laid out like 收入/支出 but without 分类, 标签 or
 * 项目: 金额, 转出账户, 转入账户, 日期, 备注, 保存. Its date is the same
 * editable control, so a transfer can be back-filled into a past month; the
 * two accounts must differ, and the save writes both legs through
 * createTransfer before leaving for 今天 exactly as an expense does.
 *
 * Nothing is written until 保存 succeeds; a rejected submit marks the offending
 * fields and leaves every keystroke in place.
 */
export { applyAmountKey };

/** The large draft above the keypad: grouped, with the expense minus. */
export function amountDraftDisplay(current: string, direction: EntryDirection): string {
  return formatAmountDraft(current, direction === 'expense');
}

/** A local-calendar day shift, used only for the 今天/昨天/前天 quick chips. */
function shiftDayISO(dateISO: string, delta: number): string {
  const [year, month, day] = dateISO.split('-').map(Number);
  const shifted = new Date(year, month - 1, day + delta);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`;
}

const chipClass = (selected: boolean, ghost = false): string =>
  `entry-chip${ghost ? ' is-ghost' : ''}${selected ? ' is-on' : ''}`;

/** Props of the one form; the default is 支出, as 今天's + opens it. */
export interface QuickEntryScreenProps {
  /**
   * Which kind the form opens on. 今天 always opens 支出; the prop lets the
   * tests render 收入 and 转账 too, since SSR never presses a button.
   */
  initialDirection?: EntryDirection;
  /** Closes the sheet. Defaults to leaving for 今天 when rendered on its own. */
  onClose?: () => void;
}

/**
 * 随手记: the bottom sheet that writes one entry, for all three kinds.
 *
 * The sheet rises over whatever screen opened it; the page underneath keeps
 * its state and the dock steps out of the way. The keypad is the amount input:
 * the big number is the draft, and parseAmountToCents still decides what is
 * written. 支出 and 收入 share the category/account/tag/project fields;
 * 转账 replaces them with the two account sides and never carries a category,
 * tag or project. The date defaults to today, cannot move into the future and
 * is the one field a new row may back-fill.
 *
 * Nothing is written until 保存 succeeds; a rejected submit marks the offending
 * fields and leaves every keystroke in place.
 */
export default function QuickEntryScreen({
  initialDirection = 'expense',
  onClose,
}: QuickEntryScreenProps = {}) {
  const { db, bump } = useDb();
  const navigate = useNavigate();
  const today = todayLocalISO();
  const sheetRef = useRef<HTMLElement>(null);
  const newTagRef = useRef<HTMLInputElement>(null);
  const fieldsRef = useRef<HTMLDivElement>(null);
  const tagRowRef = useRef<HTMLDivElement>(null);

  const [direction, setDirection] = useState<EntryDirection>(initialDirection);
  const [amount, setAmount] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [createdTags, setCreatedTags] = useState<Tag[]>([]);
  const [tagOpen, setTagOpen] = useState(false);
  const [newTag, setNewTag] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [creatingTag, setCreatingTag] = useState(false);
  // undefined means "untouched", so the last-used default can still arrive
  // after the query resolves; null means the user cleared the choice.
  const [categoryChoices, setCategoryChoices] = useState<
    Partial<Record<CategoryDirection, string | null>>
  >({});
  const [accountChoice, setAccountChoice] = useState<string | undefined>(undefined);
  // The transfer pair has its own choices, so switching to 支出 and back keeps
  // both of them; undefined means "use the computed default".
  const [fromChoice, setFromChoice] = useState<string | undefined>(undefined);
  const [toChoice, setToChoice] = useState<string | undefined>(undefined);
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<QuickEntryProblems>(noProblems);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [keypadActive, setKeypadActive] = useState(true);
  const [fieldsOverflow, setFieldsOverflow] = useState(false);

  const query = useQuery<QuickEntryData>(async database => {
    const categories = await listCategories(database);
    const accounts = await listAccounts(database);
    const tags = await listTags(database, { includeArchived: true });
    const projects = await listProjects(database);
    // Last used is read for both category-bearing directions up front: the
    // toggle then never needs a refetch, and neither half can lag behind.
    const expense = await lastEntryDefaults(database, 'expense');
    const income = await lastEntryDefaults(database, 'income');
    return { categories, accounts, tags, projects, lastUsed: { expense, income } };
  }, []);

  const close = onClose ?? (() => navigate('/'));
  const closeRef = useRef(close);
  closeRef.current = close;
  const data = query.data;
  const isTransfer = direction === 'transfer';

  useEffect(() => {
    const sheet = sheetRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheet?.focus();

    const selector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || sheet === null) return;

      const items = Array.from(sheet.querySelectorAll<HTMLElement>(selector)).filter(
        element => element.offsetParent !== null
      );
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet)) {
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
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    if (tagOpen) newTagRef.current?.focus();
  }, [tagOpen]);

  // A new tag is inserted first, but the chip row may still be scrolled to the
  // far right from finding ＋ 新标签. Bring the created chip into view so the
  // add visibly took effect.
  useEffect(() => {
    if (createdTags.length === 0) return;
    tagRowRef.current?.scrollTo({ left: 0 });
  }, [createdTags.length]);

  // Only the current direction's half of the taxonomy is offered.
  const liveCategories =
    data === null || isTransfer
      ? []
      : data.categories.filter(category => category.kind === direction);

  // 未分类 is a sink for deleted categories, never a prefill: a last row that
  // was reflowed into it must not make the next entry choose it.
  const selectableCategories = liveCategories.filter(
    category => category.id !== UNCATEGORIZED_CATEGORY_ID
  );
  const lastCategoryId =
    data === null || isTransfer ? null : data.lastUsed[direction].categoryId;
  const defaultCategoryId =
    lastCategoryId !== null &&
    selectableCategories.some(category => category.id === lastCategoryId)
      ? lastCategoryId
      : null;
  const categoryChoice = isTransfer ? undefined : categoryChoices[direction];
  const categoryId = categoryChoice === undefined ? defaultCategoryId : categoryChoice;

  const selectedCategory =
    categoryId === null ? null : (liveCategories.find(category => category.id === categoryId) ?? null);
  const selectedTopId =
    selectedCategory === null ? null : (selectedCategory.parentId ?? selectedCategory.id);
  const topCategories = liveCategories.filter(category => category.parentId === null);
  const subCategories =
    selectedTopId === null
      ? []
      : liveCategories.filter(category => category.parentId === selectedTopId);

  // An id that points at a since-archived account would render the wrong
  // option, so the default is only used when the account is still live.
  const lastAccountId =
    data === null || isTransfer ? null : data.lastUsed[direction].accountId;
  const defaultAccountId =
    data === null || isTransfer
      ? ''
      : lastAccountId !== null && data.accounts.some(account => account.id === lastAccountId)
        ? lastAccountId
        : (data.accounts[0]?.id ?? '');
  const accountId = accountChoice ?? defaultAccountId;

  const transferDefaults = pickTransferDefaults(data?.accounts ?? []);
  const fromAccountId = fromChoice ?? transferDefaults.fromAccountId;
  const toAccountId = toChoice ?? transferDefaults.toAccountId;

  const liveTags = (data?.tags ?? []).filter(tag => tag.archivedAt === null);
  // Newly created tags go first: the created chip is the confirmation that the
  // add worked, and it must not be parked off-screen at the end of the row.
  const knownTags = [
    ...createdTags
      .filter(tag => !liveTags.some(candidate => candidate.id === tag.id))
      .slice()
      .reverse(),
    ...liveTags,
  ];
  const activeProjects = (data?.projects ?? []).filter(project => project.status === 'active');
  const quickDates = [
    { value: today, label: '今天' },
    { value: shiftDayISO(today, -1), label: '昨天' },
    { value: shiftDayISO(today, -2), label: '前天' },
  ];
  const dateHint = entryDateHint(date, today);
  const amountShown = amountDraftDisplay(amount, direction);

  const blurActive = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  };

  /**
   * The keypad is the amount's keyboard, not a permanent footer. Focusing a
   * text field (note, new tag, date) puts it away so the system keyboard has
   * the space; tapping the amount brings it back. The save button stays either
   * way, so a note can be finished and saved without reopening the keypad.
   */
  const activateKeypad = () => {
    blurActive();
    setKeypadActive(true);
  };
  const deactivateKeypad = () => setKeypadActive(false);

  // Only show the fade while there is more content below. A sheet whose fields
  // already fit (e.g. 转账) must not end with a grey band over its last row.
  useEffect(() => {
    const element = fieldsRef.current;
    if (element === null) return;
    const measure = () => {
      setFieldsOverflow(element.scrollHeight - element.scrollTop - element.clientHeight > 4);
    };
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [data, direction, subCategories.length, tagOpen, projectId, categoryId, date, errorText, tagError, keypadActive]);

  const clearProblem = (field: keyof QuickEntryProblems) => {
    setProblems(previous => (previous[field] ? { ...previous, [field]: false } : previous));
  };

  const changeDirection = (next: EntryDirection) => {
    if (next === direction) return;
    blurActive();
    setKeypadActive(true);
    setDirection(next);
    // The fields on screen change with the kind; an error about the previous
    // layout would be stale, so clear it instead of carrying it over.
    setProblems(noProblems());
    setErrorText(null);
  };

  const changeAmountDraft = (next: string) => {
    setAmount(next);
    clearProblem('amountInvalid');
    setErrorText(null);
  };

  const changeCategory = (id: string | null) => {
    if (isTransfer) return;
    setCategoryChoices(previous => ({ ...previous, [direction]: id }));
    clearProblem('categoryInvalid');
    setErrorText(null);
  };

  const changeAccount = (id: string) => {
    setAccountChoice(id);
    clearProblem('accountInvalid');
    setErrorText(null);
  };

  const changeFrom = (id: string) => {
    setFromChoice(id);
    clearProblem('fromAccountInvalid');
    clearProblem('sameAccount');
    setErrorText(null);
  };

  const changeTo = (id: string) => {
    setToChoice(id);
    clearProblem('toAccountInvalid');
    clearProblem('sameAccount');
    setErrorText(null);
  };

  const toggleTag = (id: string) => {
    setTagIds(previous =>
      previous.includes(id) ? previous.filter(candidate => candidate !== id) : [...previous, id]
    );
    setTagError(null);
    setErrorText(null);
  };

  const createInlineTag = async () => {
    if (db === null) {
      setTagError('数据层还没准备好');
      return;
    }
    if (creatingTag) return;
    setCreatingTag(true);
    setTagError(null);
    const result = await createTagForPicker(db, newTag);
    setCreatingTag(false);
    if (result.tag === null) {
      setTagError(result.error);
      return;
    }
    const tag = result.tag;
    setCreatedTags(previous =>
      previous.some(candidate => candidate.id === tag.id) ? previous : [...previous, tag]
    );
    setTagIds(previous => (previous.includes(tag.id) ? previous : [...previous, tag.id]));
    setNewTag('');
    setTagOpen(false);
  };

  const changeProject = (next: string | null) => {
    setProjectId(next);
    setErrorText(null);
  };

  const changeDate = (value: string) => {
    setDate(clampEntryDate(value, today));
    setErrorText(null);
  };

  const changeNote = (value: string) => {
    setNote(value);
    setErrorText(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (db === null || submitting) return;

    setSubmitting(true);
    try {
      const result = await saveQuickEntryAndLeave(
        db,
        date,
        {
          direction,
          amount,
          categoryId,
          accountId,
          fromAccountId,
          toAccountId,
          note,
          tagIds,
          projectId,
        },
        { onSaved: bump, navigate }
      );
      setProblems(result.problems);

      if (!result.written) {
        setErrorText(problemText(result.problems));
      }
    } catch (reason) {
      setErrorText(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="entry-layer">
      <div className="entry-scrim" aria-hidden="true" onClick={close} />
      <section
        className="entry-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="entry-sheet-title"
        ref={sheetRef}
        tabIndex={-1}
      >
        <div className="entry-sheet__grab" aria-hidden="true" />
        <header className="entry-sheet__head">
          <h1 className="sr-only" id="entry-sheet-title">
            随手记
          </h1>
          <div className="entry-seg" role="group" aria-label="记账类型">
            {DIRECTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                className={direction === option.value ? 'is-on' : undefined}
                data-direction={option.value}
                aria-pressed={direction === option.value}
                onClick={() => changeDirection(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button className="entry-sheet__close" type="button" data-entry-close onClick={close}>
            收起
          </button>
        </header>

        <form className="entry-form" onSubmit={handleSubmit}>
          {data === null && (
            <p
              className="entry-loadstate"
              role={query.error === null ? 'status' : 'alert'}
            >
              {query.error === null
                ? '正在加载账户和分类…'
                : '账户和分类加载失败，收起后重试。'}
            </p>
          )}
          <button
            type="button"
            className={`entry-amount${amount === '' ? ' is-empty' : ''}`}
            onClick={activateKeypad}
            aria-live="polite"
            aria-label={`金额 ${amountShown}`}
          >
            {amountShown}
          </button>
          {!keypadActive && <p className="entry-amount-hint">点金额展开数字键盘</p>}
          {errorText !== null && (
            <p className="entry-error" role="alert">
              {errorText}
            </p>
          )}

          <div className="entry-fields-wrap">
            <div className="entry-fields" ref={fieldsRef}>
            {data !== null && data.accounts.length === 0 && (
              <div className="entry-noacc">
                <span>无可用账户</span>
                <Link to="/accounts">还没有账户，先去添加一个</Link>
              </div>
            )}

            {isTransfer ? (
              <>
                <div className="entry-group">
                  <div className="entry-group__head">
                    <span>从</span>
                    {problems.fromAccountInvalid && <span className="entry-group__error">请选择</span>}
                  </div>
                  <div className="entry-chips">
                    {(data?.accounts ?? []).map(account => (
                      <button
                        key={account.id}
                        type="button"
                        className={chipClass(fromAccountId === account.id, true)}
                        data-from-account-id={account.id}
                        aria-pressed={fromAccountId === account.id}
                        onClick={() => changeFrom(account.id)}
                      >
                        {account.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="entry-group">
                  <div className="entry-group__head">
                    <span>到</span>
                    {problems.toAccountInvalid ? (
                      <span className="entry-group__error">请选择</span>
                    ) : problems.sameAccount ? (
                      <span className="entry-group__error">不能相同</span>
                    ) : null}
                  </div>
                  <div className="entry-chips">
                    {(data?.accounts ?? []).map(account => (
                      <button
                        key={account.id}
                        type="button"
                        className={chipClass(toAccountId === account.id, true)}
                        data-to-account-id={account.id}
                        aria-pressed={toAccountId === account.id}
                        onClick={() => changeTo(account.id)}
                      >
                        {account.name}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="entry-group">
                  <div className="entry-group__head">
                    <span>分类</span>
                    {problems.categoryInvalid && <span className="entry-group__error">请选择</span>}
                  </div>
                  <div className="entry-chips">
                    {topCategories.map(category => (
                      <button
                        key={category.id}
                        type="button"
                        className={chipClass(selectedTopId === category.id)}
                        data-category-id={category.id}
                        aria-pressed={selectedTopId === category.id}
                        onClick={() => changeCategory(category.id)}
                      >
                        {category.name}
                      </button>
                    ))}
                  </div>
                </div>

                {subCategories.length > 0 && (
                  <div className="entry-group">
                    <div className="entry-group__head">
                      <span>细分（可不选）</span>
                    </div>
                    <div className="entry-chips">
                      <button
                        type="button"
                        className={chipClass(categoryId === selectedTopId, true)}
                        data-subcategory-id=""
                        aria-pressed={categoryId === selectedTopId}
                        onClick={() => changeCategory(selectedTopId)}
                      >
                        不细分
                      </button>
                      {subCategories.map(category => (
                        <button
                          key={category.id}
                          type="button"
                          className={chipClass(categoryId === category.id, true)}
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

                <div className="entry-group">
                  <div className="entry-group__head">
                    <span>账户</span>
                    {problems.accountInvalid && <span className="entry-group__error">请选择</span>}
                  </div>
                  <div className="entry-chips">
                    {(data?.accounts ?? []).map(account => (
                      <button
                        key={account.id}
                        type="button"
                        className={chipClass(accountId === account.id, true)}
                        data-account-id={account.id}
                        aria-pressed={accountId === account.id}
                        onClick={() => changeAccount(account.id)}
                      >
                        {account.name}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="entry-group">
                  <div className="entry-group__head">
                    <span>标签</span>
                    {tagError !== null && <span className="entry-group__error">{tagError}</span>}
                  </div>
                  <div className="entry-chips" ref={tagRowRef}>
                    {knownTags.map(tag => (
                      <button
                        key={tag.id}
                        type="button"
                        className={chipClass(tagIds.includes(tag.id), true)}
                        data-tag-id={tag.id}
                        aria-pressed={tagIds.includes(tag.id)}
                        onClick={() => toggleTag(tag.id)}
                      >
                        {tag.name}
                      </button>
                    ))}
                    {!tagOpen && (
                      <button
                        type="button"
                        className="entry-chip is-ghost"
                        data-tag-new="true"
                        onClick={() => setTagOpen(true)}
                      >
                        ＋ 新标签
                      </button>
                    )}
                  </div>
                  {tagOpen && (
                    <div className="entry-tag-create">
                      <input
                        ref={newTagRef}
                        className="entry-tagin"
                        type="text"
                        maxLength={12}
                        placeholder="新标签"
                        aria-label="新标签"
                        enterKeyHint="done"
                        value={newTag}
                        disabled={creatingTag}
                        onFocus={deactivateKeypad}
                        onChange={event => {
                          setNewTag(event.target.value);
                          setTagError(null);
                        }}
                        onKeyDown={event => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void createInlineTag();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="entry-tag-add"
                        data-tag-add="true"
                        disabled={creatingTag}
                        onClick={() => void createInlineTag()}
                      >
                        {creatingTag ? '添加中' : '添加'}
                      </button>
                    </div>
                  )}
                </div>

                <div className="entry-group">
                  <div className="entry-group__head">
                    <span>项目</span>
                    </div>
                    <div className="entry-chips">
                      <button
                        type="button"
                        className={chipClass(projectId === null, true)}
                        data-project-clear="true"
                        aria-pressed={projectId === null}
                        onClick={() => changeProject(null)}
                      >
                        不归项目
                      </button>
                      {activeProjects.map(project => (
                        <button
                          key={project.id}
                          type="button"
                          className={chipClass(projectId === project.id, true)}
                          data-project-id={project.id}
                          aria-pressed={projectId === project.id}
                          onClick={() => changeProject(project.id)}
                        >
                          {project.name}
                        </button>
                      ))}
                    </div>
                  </div>
              </>
            )}

            <div className="entry-group">
              <div className="entry-group__head">
                <span>日期</span>
              </div>
              <div className="entry-date-row">
                {quickDates.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    className={chipClass(date === option.value, true)}
                    data-date={option.value}
                    aria-pressed={date === option.value}
                    onClick={() => changeDate(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
                <input
                  id="add-date"
                  className="entry-date"
                  type="date"
                  value={date}
                  max={today}
                  aria-label="日期"
                  aria-describedby={dateHint === null ? undefined : 'add-date-hint'}
                  onFocus={deactivateKeypad}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    changeDate(event.target.value)
                  }
                />
              </div>
              {dateHint !== null && (
                <p className="entry-date-hint" id="add-date-hint">
                  {dateHint}
                </p>
              )}
            </div>

            <div className="entry-group entry-group--note">
              <label className="entry-label" htmlFor="add-note">
                备注
              </label>
              <input
                id="add-note"
                className="entry-note"
                type="text"
                value={note}
                placeholder="备注（可不填）"
                autoComplete="off"
                onFocus={deactivateKeypad}
                onChange={(event: ChangeEvent<HTMLInputElement>) => changeNote(event.target.value)}
              />
            </div>

            <Link className="entry-ledger-link" to="/ledger">
              记错了？去流水里改
            </Link>
            </div>
            {fieldsOverflow && <div className="entry-fade" aria-hidden="true" />}
          </div>

          {keypadActive ? (
            <AmountKeypad
              value={amount}
              onChange={changeAmountDraft}
              actionLabel={submitting ? '保存中…' : '保存'}
              actionDisabled={submitting || db === null || data === null}
              actionType="submit"
            />
          ) : (
            <div className="entry-savebar">
              <button
                type="submit"
                className="entry-savebar__button"
                data-action="save"
                disabled={submitting || db === null || data === null}
              >
                {submitting ? '保存中…' : '保存'}
              </button>
            </div>
          )}
        </form>
      </section>
    </div>
  );
}