import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Db } from '../db/driver';
import {
  confirmCandidate,
  countExpenseMonths,
  detectCandidates,
  dismissCandidate,
  listFixedCosts,
  monthlyTotalCents,
  unmarkFixed,
} from '../db/repos/fixedCosts';
import type { FixedCost, FixedCostCandidate } from '../db/repos/fixedCosts';
import { formatCentsDisplay } from '../components/AmountText';
import { formatMonthDay } from '../domain/date';
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
 * Nothing is booked here. Confirming only flags existing rows; undoing clears
 * the same flags. There is no money arithmetic in this file: the total comes
 * from monthlyTotalCents, and every displayed number is integer cents.
 */

/** One line after a confirm: enough to replace the prompt without a reload. */
export interface FixedConfirmation {
  hintId: string;
  name: string;
  nextDate: string;
}

/** Everything the screen renders from, loaded as one snapshot. */
export interface FixedCostsData {
  /** Open prompts; detection has just run. */
  candidates: FixedCostCandidate[];
  /** The confirmed list, already ordered by next date. */
  items: FixedCost[];
  /** Sum of every item's monthlyCents, from monthlyTotalCents. */
  totalCents: number;
  /** Distinct calendar months holding a live expense, for the empty state. */
  expenseMonthCount: number;
}

/**
 * §7's fixed-cost footnote, verbatim. The screen's one promise: this list is a
 * promise, not an automatic booking.
 */

/** §7's empty-state caution, verbatim. */

/** What the detector actually compares, in the owner's words. */
export const FIXED_COST_RULE = '同一个分类、金额接近、间隔约一个月。';

/** The number of months the detector needs before it dares to propose. */

/** §7's candidate title and body, in the two lines the prototype uses. */
export function candidatePromptCopy(candidate: FixedCostCandidate): {
  title: string;
  body: string;
} {
  return {
    title: `${candidate.name} 每月约 ${formatCentsDisplay(candidate.monthlyCents)}`,
    body: `连续 ${candidate.occurrences} 个月都是这个数，下次 ${formatMonthDay(
      candidate.nextDate
    )}。要加进清单吗？`,
  };
}

/**
 * Loads the page in the order the states depend on: detection writes the hint
 * rows first, then the list, total and history depth are read from the same
 * database snapshot.
 */
export async function loadFixedCostsData(db: Db): Promise<FixedCostsData> {
  const candidates = await detectCandidates(db);
  const [items, totalCents, expenseMonthCount] = await Promise.all([
    listFixedCosts(db),
    monthlyTotalCents(db),
    countExpenseMonths(db),
  ]);
  return { candidates, items, totalCents, expenseMonthCount };
}

/** Confirms one prompt and returns the line it became. */
export async function confirmFixedCost(
  db: Db,
  candidate: FixedCostCandidate
): Promise<FixedConfirmation> {
  const item = await confirmCandidate(db, candidate.id);
  return { hintId: candidate.id, name: item.name, nextDate: item.nextDate };
}

/** Undoes one confirm; the prompt is back on the next read. */
export async function undoFixedCost(
  db: Db,
  confirmation: FixedConfirmation
): Promise<FixedCostCandidate> {
  return unmarkFixed(db, confirmation.hintId);
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export interface CandidatePromptProps {
  candidate: FixedCostCandidate;
  busy: boolean;
  onConfirm(): void;
  onDismiss(): void;
}

/** One detected bill, in §7's two-line prompt with the prototype's buttons. */
export function CandidatePrompt({
  candidate,
  busy,
  onConfirm,
  onDismiss,
}: CandidatePromptProps) {
  const copy = candidatePromptCopy(candidate);
  return (
    <section
      className="fixed-prompt"
      data-fixed-prompt={candidate.id}
      aria-label="固定支出候选"
    >
      <p className="fixed-prompt__kicker">从历史里认出来的</p>
      <p className="fixed-prompt__title">{copy.title}</p>
      <p className="fixed-prompt__body">{copy.body}</p>
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
      <span className="fixed-flash__text">
        {confirmation.name} 已加入清单 · 下次 {formatMonthDay(confirmation.nextDate)}
      </span>
      <button
        className="fixed-flash__undo"
        type="button"
        disabled={busy}
        onClick={onUndo}
      >
        撤销
      </button>
    </div>
  );
}

export interface FixedCostRowProps {
  item: FixedCost;
}

/** One confirmed bill: name / day of month / amount / next date. */
export function FixedCostRow({ item }: FixedCostRowProps) {
  return (
    <li className="fixed-row">
      <span className="fixed-row__main">
        <span className="fixed-row__name">{item.name}</span>
        <span className="fixed-row__meta">
          每月 {item.dayOfMonth} 日
          {item.categoryName !== null ? ` · ${item.categoryName}` : ''}
        </span>
      </span>
      <span className="fixed-row__numbers">
        <span className="fixed-row__amount">{formatCentsDisplay(item.monthlyCents)}</span>
        <span className="fixed-row__next">下次 {formatMonthDay(item.nextDate)}</span>
      </span>
    </li>
  );
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
  onConfirm(candidate: FixedCostCandidate): void;
  onDismiss(candidate: FixedCostCandidate): void;
  onUndo(): void;
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
  onConfirm,
  onDismiss,
  onUndo,
}: FixedCostViewProps) {
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

            {data.items.length === 0 ? (
              <div className="fixed-empty-card">
                <p className="fixed-empty-card__title">还没有固定支出</p>
                <p className="fixed-empty-card__body">
                  把「固定支出」开关打开；每月同一分类、金额接近的支出会出现在建议里。
                </p>
                <Link className="fixed-manual__link" to="/ledger">
                  去流水 →
                </Link>
              </div>
            ) : (
              <>
                <section className="fixed-total" data-fixed-total>
                  <span className="fixed-total__label">
                    本月合计 · {data.items.length} 项
                  </span>
                  <span className="fixed-total__value">{formatCentsDisplay(data.totalCents)}</span>
                </section>

                <ul className="fixed-list" data-fixed-list>
                  {data.items.map(item => (
                    <FixedCostRow
                      key={[item.categoryId ?? '', item.payee ?? '', item.lastDate].join('|')}
                      item={item}
                    />
                  ))}
                </ul>
              </>
            )}
          </section>

          {notice !== null && (
            <p className="fixed-note fixed-note--error" role="alert">
              {notice}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function FixedCostsScreen() {
  const { db, bump } = useDb();
  const query = useQuery<FixedCostsData>(loadFixedCostsData, []);
  const [confirmation, setConfirmation] = useState<FixedConfirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const confirm = async (candidate: FixedCostCandidate) => {
    if (db === null || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const next = await confirmFixedCost(db, candidate);
      setConfirmation(next);
      bump();
    } catch (reason) {
      setNotice(`加入清单失败：${reasonText(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (candidate: FixedCostCandidate) => {
    if (db === null || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await dismissCandidate(db, candidate.id);
      bump();
    } catch (reason) {
      setNotice(`忽略失败：${reasonText(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (db === null || confirmation === null || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await undoFixedCost(db, confirmation);
      setConfirmation(null);
      bump();
    } catch (reason) {
      setNotice(`撤销失败：${reasonText(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FixedCostsView
      data={query.data}
      error={query.error}
      confirmation={confirmation}
      busy={busy}
      notice={notice}
      onConfirm={candidate => {
        void confirm(candidate);
      }}
      onDismiss={candidate => {
        void dismiss(candidate);
      }}
      onUndo={() => {
        void undo();
      }}
    />
  );
}