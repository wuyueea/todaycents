import { formatCentsDisplay } from './AmountText';

/**
 * One category's share of this month's spending, as a labelled bar.
 *
 * The component is a pure renderer: the amount, the percentage and the width
 * basis all arrive already computed. The percentage is display maths only —
 * the money it describes never leaves integer cents.
 *
 * Bars are drawn against the largest share in the list, not against the whole
 * month, so a month with many tiny categories stays readable while the biggest
 * one fills the track. `maxPercent` defaults to 100, which is the plain
 * "share of the total" rendering for a standalone bar.
 */
export interface CategoryBarProps {
  /** Category name, e.g. 饮食. */
  name: string;
  /** Positive integer cents spent in this category this month. */
  cents: number;
  /** Share of the month's total spending in percent, rounded to one decimal (86.7). */
  percent: number;
  /**
   * The largest share among the rows being drawn, in the same units as
   * `percent`. The fill is normalised to it (the biggest row is 100% wide).
   */
  maxPercent?: number;
}

const MIN_PERCENT = 0;
const MAX_PERCENT = 100;

/**
 * Keeps a display percentage inside the track.
 *
 * This is a rendering guard, not arithmetic: categoryShares and monthSummary
 * are computed from the same live expense rows, so the shares add up to the
 * denominator and no single share can exceed the whole. A caller that hands in
 * nonsense still must not paint a bar past the end of its track.
 */
function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return MIN_PERCENT;
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, percent));
}

/**
 * Exactly one decimal, built from integer tenths: 86.7 -> "86.7", 100 -> "100.0".
 * Integer tenths instead of toFixed keep the markup stable and locale-free.
 */
function formatPercent(percent: number): string {
  const tenths = Math.round(clampPercent(percent) * 10);
  return `${Math.trunc(tenths / 10)}.${tenths % 10}`;
}

/** Fill width relative to the widest row, rounded to one decimal for clean markup. */
function barWidth(percent: number, maxPercent: number): number {
  if (!Number.isFinite(maxPercent) || maxPercent <= 0) return MIN_PERCENT;
  const ratio = (clampPercent(percent) / maxPercent) * MAX_PERCENT;
  if (!Number.isFinite(ratio)) return MIN_PERCENT;
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(ratio * 10) / 10));
}

export function CategoryBar({
  name,
  cents,
  percent,
  maxPercent = MAX_PERCENT,
}: CategoryBarProps) {
  const width = barWidth(percent, maxPercent);

  return (
    <div className="category-bar">
      <div className="category-bar__head">
        <span className="category-bar__name">{name}</span>
        <span className="category-bar__amount num">{formatCentsDisplay(cents)}</span>
        {/* One string, not value + "%": React SSR would split adjacent text
            nodes with a comment marker and the rendered text must stay whole. */}
        <span className="category-bar__percent num">{`${formatPercent(percent)}%`}</span>
      </div>
      <div className="category-bar__track" aria-hidden="true">
        <div className="category-bar__fill" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}