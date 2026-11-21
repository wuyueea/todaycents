import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Db } from '../db/driver';
import {
  confirmCandidate,
  countExpenseMonths,
  detectCandidates,
  dismissCandidate,
  listDismissedCandidates,
  listFixedCosts,
  listStoppedFixedCosts,
  restoreDismissedCandidate,
  resumeFixedCost,
  stopFixedCost,
  unmarkFixed,
} from '../db/repos/fixedCosts';
import type { FixedCostCandidate, FixedCostListItem, FixedCostUndo, StoppedFixedCost } from '../db/repos/fixedCosts';
import { formatCentsDisplay } from '../components/AmountText';
import { TxnEditLink, useRestoreTxnEditScroll, type TxnEditOrigin } from '../components/TxnEditNavigation';
import { formatMonthDay, todayLocalISO } from '../domain/date';
import { useDb, useQuery } from '../store/useDb';

/**
 * 固定支出: the bills that come back every month, as a list and a total.
 *
 * The page has four states, all driven by the repository:
 *
 * - a prompt for every detected candidate (detection runs on open);
 * - the confirmed list, each line answering name / day / amount / next date;
 * - an in-place confirmation after 确认, with one 撤销, while the list and total
 *   update under it;
 * - an empty state that says how much history is missing rather than "暂无".
 *
 * Both totals are based on the active list. Stopped items and ignored
 * suggestions have their own recovery entries.
 */

/** One line after a confirm: enough to replace the prompt without a reload. */
export interface FixedConfirmation {
  hintId: string;
  name: string;
  categoryId: string | null;
  payee: string | null;
  undo: FixedCostUndo | null;
}

/** Everything the screen renders from, loaded as one snapshot. */
export interface FixedCostsData {
  /** Open prompts; detection has just run. */
  candidates: FixedCostCandidate[];
  /** The confirmed list, already ordered by estimated date. */
  items: FixedCostListItem[];
  stopped: StoppedFixedCost[];
  dismissed: FixedCostCandidate[];
  recordedCents: number;
  expectedCents: number;
  today: string;
  /** Distinct calendar months holding a live expense, for the empty state. */
  expenseMonthCount: number;
}

/** What the detector actually compares, in the owner's words. */
export const FIXED_COST_RULE = '同一个分类、金额接近、间隔约一个月。';

function estimatedDateText(bill: { lastDate: string; nextDate: string }, today: string): string {
  return bill.nextDate < today
    ? `待核对 · 上次实记 ${bill.lastDate}`
    : `预计下次 ${formatMonthDay(bill.nextDate)}`;
}

/** Run detection before reading the confirmed list and its totals. */
export async function loadFixedCostsData(db: Db, today = todayLocalISO()): Promise<FixedCostsData> {
  const candidates = await detectCandidates(db);
  const [items, stopped, dismissed, expenseMonthCount] = await Promise.all([
    listFixedCosts(db, today),
    listStoppedFixedCosts(db),
    listDismissedCandidates(db),
    countExpenseMonths(db),
  ]);
  const totals = { recordedCents: 0, expectedCents: 0 };
  for (const item of items) {
    totals.recordedCents += item.recordedCents;
    totals.expectedCents += item.monthlyCents;
  }
  return { candidates, items, stopped, dismissed, ...totals, today, expenseMonthCount };
}

/** Confirms one prompt and returns the line it became. */
export async function confirmFixedCost(
  db: Db,
  candidate: FixedCostCandidate
): Promise<FixedConfirmation> {
  const item = await confirmCandidate(db, candidate.id);
  return { hintId: candidate.id, name: item.name, categoryId: item.categoryId, payee: item.payee, undo: item.undo };
}

/** Undoes one confirm; the prompt is back on the next read. */
export async function undoFixedCost(
  db: Db,
  confirmation: FixedConfirmation
): Promise<void> {
  if (confirmation.undo !== null) await unmarkFixed(db, confirmation.undo);
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export interface CandidatePromptProps {
  candidate: FixedCostCandidate;
  today: string;
  busy: boolean;
  onConfirm(): void;
  onDismiss(): void;
}

/** One detected bill, in §7's two-line prompt with the prototype's buttons. */
export function CandidatePrompt({
  candidate,
  today,
  busy,
  onConfirm,
  onDismiss,
}: CandidatePromptProps) {
  return (
    <section
      className="fixed-prompt"
      data-fixed-prompt={candidate.id}
      aria-label="固定支出候选"
    >
      <p className="fixed-prompt__kicker">从历史里认出来的</p>
      <p className="fixed-prompt__title">
        {candidate.name} 每月约 {formatCentsDisplay(candidate.monthlyCents)}
      </p>
      <p className="fixed-prompt__body">
        连续 {candidate.occurrences} 个月有相近金额。{estimatedDateText(candidate, today)}。要加进清单吗？
      </p>
      <div className="fixed-prompt__actions">
        <button
          className="fixed-prompt__button fixed-prompt__button--primary"
          type="button"
          disabled={busy}
          onClick={onConfirm}
        >
          确认，是固定支出
        </button>
        <button
          className="fixed-prompt__button"
          type="button"
          disabled={busy}
          onClick={onDismiss}
        >
          不是
        </button>
      </div>
    </section>
  );
}

export interface ConfirmedPromptProps {
  confirmation: FixedConfirmation;
  busy: boolean;
  onUndo(): void;
}

/**
 * The prompt's other face: §7's confirmed line, in the same place, with one
 * 撤销. It is not a toast, so it stays while the owner reads the new total.
 */
export function ConfirmedPrompt({ confirmation, busy, onUndo }: ConfirmedPromptProps) {
  return (
    <div className="fixed-flash" data-fixed-confirmed role="status">
      <span className="fixed-flash__text">{confirmation.name} 已加入清单</span>
      {confirmation.undo !== null && (
        <button className="fixed-flash__undo" type="button" disabled={busy} onClick={onUndo}>
          撤销
        </button>
      )}
    </div>
  );
}

export interface FixedCostRowProps {
  item: FixedCostListItem;
  today: string;
  busy: boolean;
  onStop(): void;
}

function itemLabel(item: { name: string; categoryName: string | null }): string {
  return item.categoryName !== null && item.categoryName !== item.name
    ? `${item.name}（${item.categoryName}）`
    : item.name;
}

/** One confirmed bill: name / day of month / amount / next date. */
export function FixedCostRow({ item, today, busy, onStop }: FixedCostRowProps) {
  return (
    <li className="fixed-row">
      <TxnEditLink className="fixed-row__link" txnId={item.sourceTxnId}>
        <span className="fixed-row__main">
          <span className="fixed-row__name">{item.name}</span>
          <span className="fixed-row__meta">
            每月约 {item.dayOfMonth} 日
            {item.categoryName !== null ? ` · ${item.categoryName}` : ''}
          </span>
          <span className="fixed-row__source">查看来源流水 <span aria-hidden="true">›</span></span>
        </span>
        <span className="fixed-row__numbers">
          <span className="fixed-row__estimate">
            预计月额 <span className="fixed-row__amount">{formatCentsDisplay(item.monthlyCents)}</span>
          </span>
          <span className="fixed-row__next">{estimatedDateText(item, today)}</span>
        </span>
      </TxnEditLink>
      <button
        type="button"
        className="fixed-item-action"
        aria-label={`停用 ${itemLabel(item)}`}
        disabled={busy}
        onClick={onStop}
      >
        停用
      </button>
    </li>
  );
}

function FixedManagementList<T extends { name: string; categoryName: string | null }>({
  title,
  items,
  action,
  busy,
  itemKey,
  onAction,
}: {
  title: string;
  items: T[];
  action: string;
  busy: boolean;
  itemKey(item: T): string;
  onAction(item: T): void;
}) {
  if (items.length === 0) return null;
  return (
    <details className="fixed-management">
      <summary>{title} · {items.length} 项</summary>
      <ul className="fixed-list">
        {items.map(item => (
          <li className="fixed-row fixed-management__row" key={itemKey(item)}>
            <span className="fixed-management__name">{itemLabel(item)}</span>
            <button
              type="button"
              className="fixed-item-action"
              aria-label={`${action} ${itemLabel(item)}`}
              disabled={busy}
              onClick={() => onAction(item)}
            >
              {action}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

function itemKey(item: Pick<FixedCostListItem, 'categoryId' | 'payee'>): string {
  return JSON.stringify([item.categoryId, item.payee]);
}

export interface FixedCostEmptyProps {
  expenseMonthCount: number;
}

/**
 * The empty state. It never says 暂无: either the history is too short and the
 * gap is named, or the detector ran on a long history and found no repeat. The
 * manual route is offered in both cases, because one tap can mark a bill today.
 */
export function FixedCostEmpty({ expenseMonthCount }: FixedCostEmptyProps) {
  // The history depth no longer has its own paragraph: the section headings and
  // their one-line rules are the whole explanation.
  void expenseMonthCount;
  return (
    <section className="fixed-empty" aria-label="固定支出空态">
      <div className="fixed-empty__block">
        <h2 className="fixed-empty__heading">建议标记</h2>
        <p className="fixed-empty__copy">{FIXED_COST_RULE}</p>
      </div>
      <div className="fixed-empty__block">
        <h2 className="fixed-empty__heading">手动标记</h2>
        <p className="fixed-empty__copy">在流水里挑一笔</p>
      </div>
    </section>
  );
}

export interface FixedCostViewProps {
  data: FixedCostsData | null;
  error: Error | null;
  confirmation: FixedConfirmation | null;
  busy: boolean;
  notice: string | null;
  feedback: string | null;
  onConfirm(candidate: FixedCostCandidate): void;
  onDismiss(candidate: FixedCostCandidate): void;
  onUndo(): void;
  onStop(item: FixedCostListItem): void;
  onResume(item: StoppedFixedCost): void;
  onRestoreDetection(candidate: FixedCostCandidate): void;
}

/**
 * The whole screen as a pure function of one snapshot and one confirmation.
 *
 * Keeping the view separate is what lets the tests render the in-place state
 * without a browser: the same component that shows a prompt can be shown with
 * its confirmation, and the markup proves the list stayed put underneath.
 */
export function FixedCostsView({
  data,
  error,
  confirmation,
  busy,
  notice,
  feedback,
  onConfirm,
  onDismiss,
  onUndo,
  onStop,
  onResume,
  onRestoreDetection,
}: FixedCostViewProps) {
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (feedback !== null) feedbackRef.current?.focus({ preventScroll: true });
  }, [feedback]);

  return (
    <div className="fixed-screen fixed-screen--v1">
      <header className="settings-header">
        <Link className="add-back" to="/settings" aria-label="返回设置">
          ‹
        </Link>
        <h1>固定支出</h1>
        {data !== null && (
          <span className="settings-header__meta">{data.items.length} 项</span>
        )}
      </header>

      {feedback !== null && (
        <p className="fixed-note" role="status" tabIndex={-1} ref={feedbackRef}>
          {feedback}
        </p>
      )}
      {notice !== null && (
        <p className="fixed-note fixed-note--error" role="alert">
          {notice}
        </p>
      )}

      {data === null ? (
        error !== null ? (
          <p className="fixed-note fixed-note--error" role="alert">
            固定支出暂时打不开
          </p>
        ) : (
          <p className="fixed-note" role="status">
            正在读取固定支出…
          </p>
        )
      ) : (
        <>
          {/*
            Two blocks, each with a heading and one line: 建议标记 holds whatever
            the detector offers, 手动标记 names the other way in. Everything that
            used to explain why the list was empty (history depth, the caution,
            the footnote) is gone — the headings are the explanation.
          */}
          <section className="fixed-section" aria-labelledby="fixed-suggest-title">
            <h2 className="fixed-section__heading" id="fixed-suggest-title">
              建议标记
            </h2>
            <p className="fixed-section__copy">{FIXED_COST_RULE}</p>

            {confirmation !== null && (
              <ConfirmedPrompt confirmation={confirmation} busy={busy} onUndo={onUndo} />
            )}

            {data.candidates.length === 0 && confirmation === null && (
              <p className="fixed-section__empty">暂时没有可建议的固定支出。</p>
            )}

            {data.candidates
              .filter(candidate => candidate.id !== confirmation?.hintId)
              .map(candidate => (
                <CandidatePrompt
                  key={candidate.id}
                  candidate={candidate}
                  today={data.today}
                  busy={busy}
                  onConfirm={() => onConfirm(candidate)}
                  onDismiss={() => onDismiss(candidate)}
                />
              ))}
          </section>

          <section className="fixed-section" aria-labelledby="fixed-manual-title">
            <h2 className="fixed-section__heading" id="fixed-manual-title">
              手动标记
            </h2>
            <p className="fixed-section__copy">在流水里挑一笔</p>

            {(data.items.length > 0 || data.stopped.length > 0) && (
              <dl className="fixed-total" data-fixed-total>
                <div className="fixed-total__line">
                  <dt className="fixed-total__label">本月已记</dt>
                  <dd className="fixed-total__value">{formatCentsDisplay(data.recordedCents)}</dd>
                </div>
                <div className="fixed-total__line">
                  <dt className="fixed-total__label">预计月额</dt>
                  <dd className="fixed-total__value">{formatCentsDisplay(data.expectedCents)}</dd>
                </div>
              </dl>
            )}

            {data.items.length > 0 ? (
              <ul className="fixed-list" data-fixed-list>
                {data.items.map(item => (
                  <FixedCostRow
                    key={itemKey(item)}
                    item={item}
                    today={data.today}
                    busy={busy}
                    onStop={() => onStop(item)}
                  />
                ))}
              </ul>
            ) : data.stopped.length > 0 ? (
              <p className="fixed-section__empty">没有启用的固定支出。可在「已停用」中恢复。</p>
            ) : (
              <div className="fixed-empty-card">
                <p className="fixed-empty-card__title">还没有固定支出</p>
                <p className="fixed-empty-card__body">
                  打开「固定支出」开关并保存。每月同一分类、金额接近的支出会出现在建议里。
                </p>
                <Link className="fixed-manual__link" to="/ledger">
                  去流水 →
                </Link>
              </div>
            )}
          </section>

          <FixedManagementList<StoppedFixedCost>
            title="已停用"
            items={data.stopped}
            action="恢复启用"
            busy={busy}
            itemKey={itemKey}
            onAction={onResume}
          />
          <FixedManagementList
            title="已忽略建议"
            items={data.dismissed}
            action="恢复识别"
            busy={busy}
            itemKey={candidate => candidate.id}
            onAction={onRestoreDetection}
          />

        </>
      )}
    </div>
  );
}

export default function FixedCostsScreen({ editReturn = null }: { editReturn?: TxnEditOrigin | null }) {
  const { db, bump } = useDb();
  const query = useQuery<FixedCostsData>(loadFixedCostsData, []);
  useRestoreTxnEditScroll(editReturn, !query.loading);
  const [confirmation, setConfirmation] = useState<FixedConfirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const runAction = async (
    failure: string,
    action: (database: Db) => Promise<string | null>
  ) => {
    if (db === null || busy || query.loading) return;
    setBusy(true);
    setNotice(null);
    setFeedback(null);
    try {
      setFeedback(await action(db));
      bump();
    } catch (reason) {
      setNotice(`${failure}。${reasonText(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FixedCostsView
      data={query.data}
      error={query.error}
      confirmation={confirmation}
      busy={busy || query.loading}
      notice={notice}
      feedback={feedback}
      onConfirm={candidate => {
        void runAction('加入清单失败', async database => {
          setConfirmation(await confirmFixedCost(database, candidate));
          return null;
        });
      }}
      onDismiss={candidate => {
        void runAction('忽略建议失败', async database => {
          await dismissCandidate(database, candidate.id);
          return `已忽略${itemLabel(candidate)}。可在「已忽略建议」中恢复识别。`;
        });
      }}
      onUndo={() => {
        if (confirmation === null) return;
        void runAction('撤销加入失败', async database => {
          await undoFixedCost(database, confirmation);
          setConfirmation(null);
          return `已撤销${confirmation.name}的加入。`;
        });
      }}
      onStop={item => {
        void runAction('停用固定支出失败', async database => {
          await stopFixedCost(database, item);
          setConfirmation(current => current !== null && itemKey(current) === itemKey(item) ? null : current);
          return `${itemLabel(item)}已停用。可在「已停用」中恢复。`;
        });
      }}
      onResume={item => {
        void runAction('恢复启用失败', async database => {
          await resumeFixedCost(database, item);
          return `${itemLabel(item)}已恢复启用。`;
        });
      }}
      onRestoreDetection={candidate => {
        void runAction('恢复识别失败', async database => {
          const result = await restoreDismissedCandidate(database, candidate.id);
          if (result === 'suggested') return `已恢复识别。可在「建议标记」中查看${candidate.name}。`;
          if (result === 'stopped') return '已恢复识别。该项停用期间暂停显示建议。';
          return '已恢复识别。当前有效流水还不足以形成建议。';
        });
      }}
    />
  );
}
