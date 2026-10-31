import { UNCATEGORIZED_CATEGORY_ID } from '../db/schema';
import type { TxnRow } from '../db/repos/txns';

/**
 * The two marks a transaction row can carry, shared by 流水 and 今天.
 *
 * Both are statements about missing or finished data, not about money: a row
 * that lost its category still needs re-filing, and a row that belongs to an
 * archived project still belongs to it. Keeping the rules in one module is what
 * stops the two lists from drifting apart.
 */

/**
 * Whether a row's category slot is missing rather than named.
 *
 * Two different stored values both mean 未分类: a NULL category (written without
 * one) and the system row's id (a row reflowed there when its category was
 * deleted). They are one situation to the owner, so they get one mark. A
 * transfer or an adjustment is not categorised by design and is never marked.
 */
export function isUncategorised(
  row: Pick<TxnRow, 'direction' | 'categoryId' | 'categoryName'>
): boolean {
  if (row.direction !== 'expense' && row.direction !== 'income') return false;
  // categoryName === null also catches a dangling id (a legacy file whose
  // category row is gone): there is no name to print, so the slot is missing.
  return (
    row.categoryId === null ||
    row.categoryId === UNCATEGORIZED_CATEGORY_ID ||
    row.categoryName === null
  );
}

/**
 * 未分类, with the dotted underline §4.8 asks for: it is not an error, but it
 * should not look like a normal, settled category either.
 */
export function UncategorisedLabel() {
  return <span className="uncat">未分类</span>;
}

export interface ProjectMarkProps {
  /** The row's project marks, as the repository joined them. */
  row: Pick<TxnRow, 'projectId' | 'projectName' | 'projectArchived'>;
}

/**
 * The project name appended to a row's muted line as 「· 国庆去成都」.
 *
 * Drawn only when the project can be named: a dangling project_id from an old
 * backup has no project row, and inventing a label for it would be worse than
 * saying nothing. An archived project keeps its name — the row would otherwise
 * look as if it had lost its trip — and only changes colour (--project-dead).
 */
export function ProjectMark({ row }: ProjectMarkProps) {
  if (row.projectName === null) return null;

  return (
    <span
      className={row.projectArchived ? 'project-mark project-mark--archived' : 'project-mark'}
      data-project-id={row.projectId ?? undefined}
    >
      {` · ${row.projectName}`}
    </span>
  );
}
