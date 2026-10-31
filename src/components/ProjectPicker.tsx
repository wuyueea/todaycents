import { useState } from 'react';
import type { Project } from '../db/repos/projects';

/**
 * The shared project chooser for 记账 and 编辑流水.
 *
 * A transaction belongs to at most one project, and to none by default: this is
 * a single-select sheet with an explicit 不归项目 row, not a required field. The
 * sheet lists live projects only — archiving is how a finished trip retires,
 * and a new row must not be filed into one — except that the row's current
 * project is still named on the trigger (valueLabel), so an edit cannot silently
 * lose an archived assignment.
 *
 * The footnote is §7's 项目不影响统计 sentence: the project is a second axis, and
 * the statement belongs where the choice is made.
 */

/** The sheet says nothing here: the rule is invisible, not a choice to explain. */
export const PROJECT_PICKER_FOOTNOTE = '';

/** What the trigger says: the chosen project, or 不归项目 for none. */
export function projectSelectionLabel(
  projects: readonly Project[],
  value: string | null,
  valueLabel?: string
): string {
  const chosen = projects.find(project => project.id === value);
  if (chosen !== undefined) return chosen.name;
  if (value === null) return '不归项目';
  // A value that is not live can only be an archived (or vanished) project; the
  // caller is the one that knows its name.
  return valueLabel ?? '不归项目';
}

export interface ProjectSheetProps {
  /** Live projects; archived rows are filtered here as a second guard. */
  projects: readonly Project[];
  value: string | null;
  /** The current project's name when it is not in the live list (archived). */
  valueLabel?: string;
  onSelect(id: string | null): void;
  onClose(): void;
}

/**
 * The sheet's body: one row per live project, then 不归项目.
 *
 * Choosing closes the sheet, exactly as the category sheet does: this is one
 * decision, not a form. 不归项目 is always offered, even when no project exists,
 * because "no project" is a real answer rather than an empty state.
 */
export function ProjectSheet({
  projects,
  value,
  valueLabel,
  onSelect,
  onClose,
}: ProjectSheetProps) {
  const liveProjects = projects.filter(project => project.status === 'active');
  const current = liveProjects.find(project => project.id === value);
  const currentLabel = current?.name ?? (value === null ? '不归项目' : (valueLabel ?? '不归项目'));

  const choose = (id: string | null) => {
    onSelect(id);
    onClose();
  };

  return (
    <div
      className="sheet project-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-sheet-title"
    >
      <div className="sheet__scrim" aria-hidden="true" onClick={onClose} />
      <div className="sheet__panel">
        <div className="sheet__head">
          <h2 className="sheet__title" id="project-sheet-title">
            选项目
          </h2>
          <span className="sheet__version">现在：{currentLabel}</span>
        </div>

        <div className="project-sheet__list">
          {liveProjects.length === 0 ? (
            <p className="project-sheet__empty">还没有项目</p>
          ) : (
            liveProjects.map(project => {
              const selected = project.id === value;
              return (
                <button
                  key={project.id}
                  type="button"
                  className={
                    selected ? 'project-sheet__row is-selected' : 'project-sheet__row'
                  }
                  data-project-id={project.id}
                  aria-pressed={selected}
                  onClick={() => choose(project.id)}
                >
                  {project.name}
                </button>
              );
            })
          )}
          <button
            type="button"
            className="project-sheet__row project-sheet__row--none"
            data-project-clear="true"
            aria-pressed={value === null}
            onClick={() => choose(null)}
          >
            不归项目
          </button>
        </div>

        <p className="project-sheet__note">{PROJECT_PICKER_FOOTNOTE}</p>

        <button className="sheet__secondary" type="button" onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  );
}

export interface ProjectPickerProps {
  /** Live projects. Archived rows are offered by no picker. */
  projects: readonly Project[];
  /** The chosen project id, or null for 不归项目. */
  value: string | null;
  /** The current project's name when it is no longer live (archived). */
  valueLabel?: string;
  onChange(next: string | null): void;
}

/**
 * The 项目 field row plus its sheet. Tapping the row opens the single-select
 * list; choosing (or 不归项目) closes it. Nothing here writes to the database:
 * the caller keeps the choice and saves it with the row.
 */
export function ProjectPicker({
  projects,
  value,
  valueLabel,
  onChange,
}: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const label = projectSelectionLabel(projects, value, valueLabel);

  return (
    <>
      <button
        className="add-value"
        type="button"
        data-project-trigger="true"
        aria-label={`项目：${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>

      {open && (
        <ProjectSheet
          projects={projects}
          value={value}
          valueLabel={valueLabel}
          onSelect={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
