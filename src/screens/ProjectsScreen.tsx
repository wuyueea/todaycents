import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AmountKeypadField } from '../components/AmountKeypadField';
import { Toast, useToast } from '../components/Toast';
import { useDb, useQuery } from '../store/useDb';
import { createProject, listProjects, projectTotals } from '../db/repos/projects';
import type { Project } from '../db/repos/projects';
import type { Db } from '../db/driver';
import { formatCentsDisplay } from '../components/AmountText';
import { parseAmountToCents } from '../domain/money';

/**
 * 项目: the bounded stretches of spending — a trip, a move — that the ledger can
 * belong to.
 *
 * A project owns no money. Every number on this page is read, never summed:
 * projectTotals derives each count and total from the live rows pointing at the
 * project, so the list can never disagree with 流水. Archiving is a status, not
 * a delete, so archived projects stay in a separate group with their totals
 * intact — that is the only way back for a finished trip.
 *
 * The page creates projects inline (name required, budget optional) and then
 * hands every row to the detail page; renaming, re-budgeting and archiving
 * belong there, where the number they affect is already on screen.
 */

/** One rendered project: the project plus the numbers derived from its rows. */
export interface ProjectListRow {
  project: Project;
  txnCount: number;
  totalCents: number;
}

/** Everything the list renders from, loaded as one snapshot. */
export interface ProjectsData {
  /** Active projects first, archived ones last (listProjects' order). */
  rows: ProjectListRow[];
}

/**
 * Pairs the project list with its derived totals.
 *
 * Two repository reads are joined by id rather than one wider query: the list
 * asks listProjects for names/status/budget, and projectTotals for the numbers
 * every project screen shares. A project missing from the totals (unreachable,
 * both read the same table) renders as zero rather than disappearing.
 */
export async function loadProjectsData(db: Db): Promise<ProjectsData> {
  const [projects, totals] = await Promise.all([
    listProjects(db, { includeArchived: true }),
    projectTotals(db),
  ]);
  const byId = new Map(totals.map(total => [total.id, total]));

  return {
    rows: projects.map(project => {
      const total = byId.get(project.id);
      return {
        project,
        txnCount: total?.txnCount ?? 0,
        totalCents: total?.totalCents ?? 0,
      };
    }),
  };
}

/** A trimmed create draft and its optional cap, or the sentence refusing it. */
export interface ProjectCreatePlan {
  name: string | null;
  budgetCents: number | null;
  error: string | null;
}

/**
 * The user-facing half of createProject's rules.
 *
 * The repository repeats the name rule, so a stale caller cannot store a blank
 * name. The budget is empty or a positive amount: parseAmountToCents already
 * refuses zero, negatives and more than two decimals, and money stays integer
 * cents here — no "2,000" string is ever turned into a float.
 */
export function planProjectCreate(rawName: string, rawBudget: string): ProjectCreatePlan {
  const name = rawName.trim();
  if (name === '') {
    return { name: null, budgetCents: null, error: '项目名不能为空' };
  }

  const budgetText = rawBudget.trim();
  if (budgetText === '') {
    return { name, budgetCents: null, error: null };
  }

  const budgetCents = parseAmountToCents(budgetText);
  if (budgetCents === null) {
    return {
      name: null,
      budgetCents: null,
      error: '预算必须是大于 0 的数字，最多两位小数',
    };
  }

  return { name, budgetCents, error: null };
}

/** The list says nothing here; the sentence explained the model, not the work. */
export const PROJECT_NO_EFFECT_NOTE = '';

export default function ProjectsScreen() {
  const { db, bump } = useDb();
  const query = useQuery<ProjectsData>(loadProjectsData, []);
  const { toast, showToast } = useToast();

  const [name, setName] = useState('');
  const [budget, setBudget] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);

  const data = query.data;
  const rows = data?.rows ?? [];
  const liveRows = rows.filter(row => row.project.status === 'active');
  const archivedRows = rows.filter(row => row.project.status === 'archived');

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (db === null || busy) return;

    const plan = planProjectCreate(name, budget);
    if (plan.name === null) {
      setFormError(plan.error);
      return;
    }

    setBusy(true);
    setFormError(null);
    try {
      await createProject(db, {
        name: plan.name,
        budgetCents: plan.budgetCents,
      });
      setName('');
      setBudget('');
      bump();
      showToast(`已新建项目「${plan.name}」`);
    } catch (reason) {
      setFormError(`新建失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const renderRow = (row: ProjectListRow) => {
    const { project } = row;
    const archived = project.status === 'archived';
    const budgetCents = project.budgetCents;
    const total = `${row.txnCount} 笔 · 已花 ${formatCentsDisplay(row.totalCents)}`;

    return (
      <li
        className={archived ? 'project-row project-row--archived' : 'project-card'}
        key={project.id}
        data-project-id={project.id}
      >
        <Link
          className="project-row__link"
          to={`/settings/projects/${encodeURIComponent(project.id)}`}
        >
          <span className="project-row__head">
            <span className="project-row__name">{project.name}</span>
            {archived && <span className="project-row__archived">已归档</span>}
            <span className="project-row__arrow" aria-hidden="true">
              ›
            </span>
          </span>
          <span className="project-row__meta">{total}</span>
          {budgetCents !== null && (
            <span className="project-row__budget num">
              预算 {formatCentsDisplay(budgetCents)} · 已用 {formatCentsDisplay(row.totalCents)}
            </span>
          )}
        </Link>
        {budgetCents !== null && budgetCents > 0 && (
          <progress
            className={
              row.totalCents > budgetCents
                ? 'project-progress project-progress--over'
                : 'project-progress'
            }
            value={row.totalCents}
            max={budgetCents}
            aria-label={`${project.name}预算使用进度`}
          />
        )}
      </li>
    );
  };

  return (
    <div className="projects-screen projects-screen--v1">
      <header className="settings-header">
        <Link className="add-back" to="/settings" aria-label="返回设置">
          ‹
        </Link>
        <h1>项目</h1>
        {data !== null && (
          <span className="settings-header__meta">{liveRows.length} 个进行中</span>
        )}
      </header>

      {data === null ? (
        query.error !== null ? (
          <p className="projects-note projects-note--error" role="alert">
            项目暂时打不开
          </p>
        ) : (
          <p className="projects-note" role="status">
            正在加载项目…
          </p>
        )
      ) : (
        <>
          {rows.length === 0 && (
            <div className="projects-empty">
              <p className="projects-empty__title">还没有项目</p>
              <p className="projects-empty__hint">
                旅行、搬家、装修这类成段的花费，可以收在一个项目里。
              </p>
            </div>
          )}

          {liveRows.length > 0 && (
            <ul className="projects-list">{liveRows.map(renderRow)}</ul>
          )}

          {archivedRows.length > 0 && (
            <section aria-labelledby="projects-archived-title">
              <h2 className="projects-section" id="projects-archived-title">
                已归档
              </h2>
              <ul className="projects-list">{archivedRows.map(renderRow)}</ul>
            </section>
          )}
        </>
      )}

      {!showCreate && (
        <button
          className="projects-add"
          type="button"
          onClick={() => {
            setShowCreate(true);
            window.setTimeout(() => {
              document.getElementById('projects-create')?.scrollIntoView({ behavior: 'smooth' });
            }, 0);
          }}
        >
          ＋ 新建项目
        </button>
      )}

      <form
        className="projects-create"
        id="projects-create"
        hidden={!showCreate}
        onSubmit={handleCreate}
      >
        <h2 className="projects-create__title">新建项目</h2>
        <div className="projects-create__row">
          <label className="projects-create__label" htmlFor="new-project-name">
            名称
          </label>
          <input
            id="new-project-name"
            className="projects-create__input"
            type="text"
            autoComplete="off"
            placeholder="比如 国庆去成都"
            value={name}
            aria-invalid={formError === '项目名不能为空' ? 'true' : undefined}
            disabled={busy || db === null}
            onChange={event => {
              setName(event.target.value);
              setFormError(null);
            }}
          />
        </div>
        <div className="projects-create__row">
          <label className="projects-create__label" htmlFor="new-project-budget">
            预算
          </label>
          <AmountKeypadField
            id="new-project-budget"
            label="预算"
            value={budget}
            onChange={value => {
              setBudget(value);
              setFormError(null);
            }}
            invalid={formError === '预算必须是大于 0 的数字，最多两位小数'}
            placeholder="可不填"
            disabled={busy || db === null}
          />
        </div>
        {formError !== null && (
          <p className="projects-create__error" role="alert">
            {formError}
          </p>
        )}
        <button className="projects-create__button" type="submit" disabled={busy || db === null}>
          新建项目
        </button>
      </form>


      {toast !== null && <Toast text={toast} />}
    </div>
  );
}