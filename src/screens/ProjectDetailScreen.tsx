import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AmountText } from '../components/AmountText';
import { useDialogFocus } from '../components/useDialogFocus';
import { CategoryBar } from '../components/CategoryBar';
import { AmountKeypadField } from '../components/AmountKeypadField';
import { Toast, useToast } from '../components/Toast';
import { useDb, useQuery } from '../store/useDb';
import {
  archiveProject,
  projectDetail,
  projectTotals,
  renameProject,
  setProjectBudget,
  unarchiveProject,
} from '../db/repos/projects';
import type { ProjectDetail } from '../db/repos/projects';
import type { TxnRow } from '../db/repos/txns';
import type { Db } from '../db/driver';
import { formatMonthDay } from '../domain/date';
import { formatCents } from '../domain/money';
import { formatCentsDisplay } from '../components/AmountText';
import { sharePercentTenths } from '../domain/report';
import { planProjectCreate } from './ProjectsScreen';

/**
 * 项目详情: one trip, its total, where the money went and its newest rows.
 *
 * Every number is derived from the project's transactions (projectDetail), so
 * the page cannot disagree with 流水 or 统计: the hero total, the category bars
 * and the recent rows all describe the same live expense rows. The project is a
 * second axis, not a filter — 统计 still counts these rows in their month.
 *
 * The category bars reuse the 统计 drawing and its percentage helper on purpose:
 * "花在哪里" must mean the same thing on both screens. The hero is the one place
 * a project's number is a headline, so it is a plain magnitude ("花了"), never
 * a signed amount.
 *
 * Archiving is explained before it happens, in §7's words with the real count:
 * the rows do not move, the total stays readable, and 恢复归档 undoes it.
 */

/** Everything the detail renders from: the API's detail plus its row count. */
export interface ProjectDetailData {
  detail: ProjectDetail;
  /** Live rows assigned to the project, from projectTotals. */
  txnCount: number;
}

/**
 * Reads one project's detail and its row count.
 *
 * projectDetail already derives the total and the category mix, but it does not
 * carry txnCount; the hero and the archive sentence both need it, and
 * projectTotals is the one place that counts rows, so it is read rather than
 * counted here. A missing project rejects (projectDetail refuses an unknown
 * id) instead of rendering an empty page that looks real.
 */
export async function loadProjectDetailData(
  db: Db,
  id: string
): Promise<ProjectDetailData> {
  const [detail, totals] = await Promise.all([projectDetail(db, id), projectTotals(db)]);
  const total = totals.find(candidate => candidate.id === id);
  if (total === undefined) {
    throw new Error(`项目不存在：${id}`);
  }
  return { detail, txnCount: total.txnCount };
}

export interface ProjectArchiveSheetProps {
  projectName: string;
  /** Live rows the archive leaves untouched; the sentence names the number. */
  txnCount: number;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * 归档确认: §7's sentence with the real name and count.
 *
 * The months in the sample ("9—10 月") belong to that one trip; a project has
 * no date range in the data layer, so the sentence says 各月 rather than
 * inventing a span. Nothing else is reworded: the rows do not move, they keep
 * counting in the category totals, and the second line promises the undo.
 */
export function ProjectArchiveSheet({
  projectName,
  txnCount,
  busy,
  onConfirm,
  onCancel,
}: ProjectArchiveSheetProps) {
  const panelRef = useDialogFocus({
    onClose: onCancel,
    initial: 'last',
    canClose: () => !busy,
  });

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-archive-title"
    >
      <div className="sheet__scrim" aria-hidden="true" onClick={onCancel} />
      <div className="sheet__panel" ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id="project-archive-title">
            归档项目
          </h2>
          <span className="sheet__version num">{txnCount} 笔</span>
        </div>

        <p className="sheet__text">
          归档后，「{projectName}」不再出现在进行中。这趟的 {txnCount} 笔账一笔都不会动，仍然算进各月的分类统计。
        </p>
        <p className="sheet__note">随时可以反悔：在「已归档」里点开，选恢复。</p>

        <button className="sheet__primary" type="button" onClick={onConfirm} disabled={busy}>
          归档
        </button>
        <button className="sheet__secondary" type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </div>
  );
}

/** What sits in a recent row's category slot, with the row's own kind first. */
function recentRowParts(row: TxnRow): { title: string; meta: string } {
  const category = row.categoryName ?? '未分类';
  const day = formatMonthDay(row.occurredDate);
  if (row.direction === 'transfer') return { title: row.note !== '' ? row.note : '转账', meta: day };
  if (row.direction === 'adjust') return { title: row.note !== '' ? row.note : '调整', meta: day };
  // A note is the title (as in the prototype); without one the category is the
  // title and the date alone is enough, so nothing is printed twice.
  return row.note !== ''
    ? { title: row.note, meta: `${day} · ${category}` }
    : { title: category, meta: day };
}

export default function ProjectDetailScreen() {
  const { db, bump } = useDb();
  const params = useParams<{ id: string }>();
  const id = params.id ?? '';
  const query = useQuery<ProjectDetailData>(
    database => loadProjectDetailData(database, id),
    [id]
  );
  const { toast, showToast } = useToast();

  // undefined means "untouched": the loaded project keeps supplying the value.
  const [nameEdit, setNameEdit] = useState<string | undefined>(undefined);
  const [budgetEdit, setBudgetEdit] = useState<string | undefined>(undefined);
  const [editError, setEditError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const data = query.data;
  const project = data?.detail.project ?? null;
  const txnCount = data?.txnCount ?? 0;
  const totalCents = data?.detail.totalCents ?? 0;
  const budgetCents = project?.budgetCents ?? null;

  const name = nameEdit ?? project?.name ?? '';
  const budget =
    budgetEdit ?? (budgetCents === null ? '' : formatCents(budgetCents));

  // The hero answers 这趟一共花了 in one breath: the cap, what is left (or over),
  // and how many rows the number covers. 笔数 is part of the sentence because a
  // total with no count cannot be checked against the list below it.
  const heroMeta = [
    budgetCents === null ? null : `预算 ${formatCentsDisplay(budgetCents)}`,
    budgetCents === null
      ? null
      : totalCents <= budgetCents
        ? `还剩 ${formatCentsDisplay(budgetCents - totalCents)}`
        : `超出 ${formatCentsDisplay(totalCents - budgetCents)}`,
    `${txnCount} 笔`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  const hasShares = totalCents > 0 && (data?.detail.byCategory.length ?? 0) > 0;
  const maxTenths = (data?.detail.byCategory ?? []).reduce(
    (max, share) => Math.max(max, sharePercentTenths(share.cents, totalCents)),
    0
  );

  const handleEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (db === null || project === null || busy) return;

    const plan = planProjectCreate(name, budget);
    if (plan.name === null) {
      setEditError(plan.error);
      return;
    }

    const nameChanged = plan.name !== project.name;
    const budgetChanged = plan.budgetCents !== project.budgetCents;
    if (!nameChanged && !budgetChanged) {
      setEditError(null);
      showToast('没有改动');
      return;
    }

    setBusy(true);
    setEditError(null);
    try {
      if (nameChanged) await renameProject(db, project.id, plan.name);
      if (budgetChanged) await setProjectBudget(db, project.id, plan.budgetCents);
      setNameEdit(undefined);
      setBudgetEdit(undefined);
      bump();
      showToast('已保存');
    } catch (reason) {
      setEditError(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleArchive = async () => {
    if (db === null || project === null || busy) return;
    setBusy(true);
    try {
      await archiveProject(db, project.id);
      setConfirming(false);
      bump();
      showToast(`已归档「${project.name}」，这趟的 ${txnCount} 笔一笔都没动。`);
    } catch (reason) {
      showToast(`归档失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleUnarchive = async () => {
    if (db === null || project === null || busy) return;
    setBusy(true);
    try {
      await unarchiveProject(db, project.id);
      bump();
      showToast(`已恢复归档「${project.name}」，它重新出现在进行中。`);
    } catch (reason) {
      showToast(`恢复失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const renderRecent = (row: TxnRow) => {
    const { title, meta } = recentRowParts(row);
    const body = (
      <>
        <span className="project-txn__body">
          <span className="project-txn__title">{title}</span>
          <span className="project-txn__meta">{meta}</span>
        </span>
        <AmountText cents={row.amountCents} direction={row.direction} />
      </>
    );

    if (row.direction === 'transfer') {
      return (
        <li key={row.id}>
          <div className="project-txn project-txn--readonly" data-txn-id={row.id}>
            {body}
          </div>
        </li>
      );
    }

    return (
      <li key={row.id}>
        <Link
          className="project-txn"
          to={`/txn/${encodeURIComponent(row.id)}`}
          data-txn-id={row.id}
        >
          {body}
        </Link>
      </li>
    );
  };

  return (
    <div className="project-detail-screen project-detail-screen--v1">
      <header className="settings-header">
        <Link className="add-back" to="/settings/projects" aria-label="返回项目">
          ‹
        </Link>
        <h1>{project?.name ?? '项目'}</h1>
        {project !== null && (
          <span className="settings-header__meta">
            {project.status === 'archived' ? '已归档' : '进行中'}
          </span>
        )}
      </header>

      {data === null ? (
        query.error !== null ? (
          <p className="project-detail-note project-detail-note--error" role="alert">
            项目暂时打不开
          </p>
        ) : (
          <p className="project-detail-note" role="status">
            正在加载项目…
          </p>
        )
      ) : (
        <>
          <section className="project-hero" aria-label="这趟一共花了">
            <p className="project-hero__label">这趟一共花了</p>
            <p className="project-hero__value num">{formatCentsDisplay(totalCents)}</p>
            <p className="project-hero__meta">{heroMeta}</p>
            {budgetCents !== null && (
              <progress
                className={
                  totalCents > budgetCents
                    ? 'project-hero__progress project-hero__progress--over'
                    : 'project-hero__progress'
                }
                value={totalCents}
                max={budgetCents}
                aria-label="项目预算使用进度"
              />
            )}
          </section>

          <section className="project-section-block" aria-label="花在哪里">
            <h2 className="project-section">花在哪里</h2>
            {!hasShares ? (
              <p className="project-detail-note">还没有支出，暂无分类占比</p>
            ) : (
              <ul className="share-bars">
                {data.detail.byCategory.map(share => (
                  <li key={share.categoryId === '' ? 'uncategorized' : share.categoryId}>
                    <CategoryBar
                      name={share.name}
                      cents={share.cents}
                      percent={sharePercentTenths(share.cents, totalCents) / 10}
                      maxPercent={maxTenths / 10}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.detail.recentTxns.length > 0 && (
            <section className="project-section-block" aria-label="最近几笔">
              <h2 className="project-section">最近几笔</h2>
              <ul className="project-recent">{data.detail.recentTxns.map(renderRecent)}</ul>
            </section>
          )}

          <div className="project-actions">
            {data.detail.project.status === 'active' ? (
              <button
                className="project-archive"
                type="button"
                disabled={busy || db === null}
                onClick={() => setConfirming(true)}
              >
                归档这个项目
              </button>
            ) : (
              <button
                className="project-archive"
                type="button"
                disabled={busy || db === null}
                onClick={handleUnarchive}
              >
                恢复归档
              </button>
            )}
          </div>

          <section className="project-edit" aria-labelledby="project-edit-title">
            <h2 className="project-section" id="project-edit-title">
              改名与预算
            </h2>
            <form className="project-edit__form" onSubmit={handleEdit}>
              <div className="add-field">
                <label className="add-label" htmlFor="project-name">
                  名称
                </label>
                <input
                  id="project-name"
                  className="project-input"
                  type="text"
                  autoComplete="off"
                  value={name}
                  aria-invalid={editError === '项目名不能为空' ? 'true' : undefined}
                  disabled={busy || db === null}
                  onChange={event => {
                    setNameEdit(event.target.value);
                    setEditError(null);
                  }}
                />
              </div>

              <div className="add-field">
                <label className="add-label" htmlFor="project-budget">
                  预算
                </label>
                <AmountKeypadField
                  id="project-budget"
                  label="预算"
                  value={budget}
                  onChange={value => {
                    setBudgetEdit(value);
                    setEditError(null);
                  }}
                  invalid={editError === '预算必须是大于 0 的数字，最多两位小数'}
                  placeholder="不设预算"
                  disabled={busy || db === null}
                />
              </div>

              {editError !== null && (
                <p className="project-edit__error" role="alert">
                  {editError}
                </p>
              )}

              <button className="add-submit" type="submit" disabled={busy || db === null}>
                {busy ? '正在保存…' : '保存修改'}
              </button>
            </form>
          </section>
        </>
      )}

      {confirming && project !== null && (
        <ProjectArchiveSheet
          projectName={project.name}
          txnCount={txnCount}
          busy={busy}
          onConfirm={handleArchive}
          onCancel={() => {
            if (!busy) setConfirming(false);
          }}
        />
      )}

      {toast !== null && <Toast text={toast} />}
    </div>
  );
}