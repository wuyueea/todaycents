/**
 * The report's pure arithmetic: integer percentages that add up, the
 * top-three-plus-rest split, and the angles of the pie.
 *
 * Nothing here touches the database and nothing here draws: the repository
 * hands in integer cents, and every function returns plain numbers that the
 * screen can print or feed to an SVG path. Money never becomes a float; the
 * only divisions are a percentage and an angle, and both are display values.
 */

/** The least a report row must expose to be ordered and turned into a pie. */
export interface ReportRowLike {
  name: string;
  cents: number;
}

/**
 * The report's one ordering: most cents first, ties by name.
 *
 * The name comparison is a plain code-unit comparison, not localeCompare: the
 * report is read offline on a phone, and the same rows must produce the same
 * slices, percentages and top three on every device, whatever its locale.
 */
export function compareByCentsThenName(a: ReportRowLike, b: ReportRowLike): number {
  if (a.cents !== b.cents) return b.cents - a.cents;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/**
 * Rejects anything that is not a non-negative integer number of cents.
 *
 * The same guard the repositories apply on the way in runs here, so a caller
 * that has accidentally already divided by 100 is stopped instead of painting
 * 0.4% as a slice.
 */
function assertCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${label} must be a non-negative integer number of cents, received ${value}`
    );
  }
}

/**
 * Integer percentages of `total`, using the largest-remainder method so they
 * add up to exactly 100 instead of 99 or 101.
 *
 * Each part first receives its floor. The points still missing are then handed
 * out one each to the parts with the largest division remainder — the standard
 * largest-remainder allocation, so 16.67 / 33.33 / 50 becomes 17 / 33 / 50
 * rather than 16 / 33 / 50 and a total of 99. Remainder ties go to the earlier
 * part, so sorting the rows through compareByCentsThenName before calling this
 * makes the split fully deterministic.
 *
 * `parts` must be a partition of `total` (they are the categories of one
 * period, and their sum is that period's spending). A zero total has no
 * percentage to show, so every part reports 0 and the empty month passes in an
 * empty list.
 */
export function integerPercents(parts: readonly number[], total: number): number[] {
  assertCents(total, 'total');
  let sum = 0;
  parts.forEach((part, index) => {
    assertCents(part, `parts[${index}]`);
    sum += part;
  });
  if (sum !== total) {
    throw new RangeError(`parts must add up to total: ${sum} !== ${total}`);
  }
  if (total === 0) return parts.map(() => 0);

  // The division is done on integers: every numerator and denominator is an
  // exact safe integer, and the remainder is the integer remainder rather than
  // a floating-point fraction.
  const scaled = parts.map(part => part * 100);
  const percents = scaled.map(value => Math.floor(value / total));
  const remainders = scaled.map(value => value % total);
  const deficit = 100 - percents.reduce((count, percent) => count + percent, 0);

  // Stable order for the leftover points: biggest remainder first, earlier
  // part first on a tie. With a true partition the deficit is smaller than the
  // number of parts, so every point has a candidate.
  const byRemainder = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < deficit; i++) {
    percents[byRemainder[i].index] += 1;
  }
  return percents;
}

/** The three labelled slices, the rest of the pie, and the one-line summary. */
export interface Top3WithRest<T extends ReportRowLike> {
  /** The three largest rows, already ordered by compareByCentsThenName. */
  top: T[];
  /** Every row after the third, in the same order. */
  rest: T[];
  /** The rest's names joined for the `其他 X 通讯 Y 订阅 Z` line; '' when none. */
  restNames: string;
  /** Sum of the rest in integer cents; 0 when the rest is empty. */
  restCents: number;
}

/**
 * Splits report rows into the three the pie labels and the rest it summarises.
 *
 * A copy is sorted, so the caller's array keeps the repository's order. The
 * rest rows stay available because the summary line prints their amounts too;
 * restNames is the joined string in the same order, with U+0020 between names.
 */
export function top3WithRest<T extends ReportRowLike>(rows: readonly T[]): Top3WithRest<T> {
  const sorted = [...rows].sort(compareByCentsThenName);
  const top = sorted.slice(0, 3);
  const rest = sorted.slice(3);
  return {
    top,
    rest,
    restNames: rest.map(row => row.name).join(' '),
    restCents: rest.reduce((sum, row) => sum + row.cents, 0),
  };
}

/**
 * A share as tenths of a percent (86.7% -> 867).
 *
 * Used by the horizontal share bars that 项目详情 and the old 统计 screen drew:
 * the denominator is the period's total spending, so rounding each share to one
 * decimal never hides a division by zero — a zero or negative total reports 0
 * and no bars are drawn. Display maths over integer cents; no amount is stored
 * as a float.
 */
export function sharePercentTenths(cents: number, totalCents: number): number {
  if (!Number.isSafeInteger(cents) || !Number.isSafeInteger(totalCents)) return 0;
  if (cents <= 0 || totalCents <= 0) return 0;
  return Math.round((cents * 1000) / totalCents);
}

/** One pie slice in degrees: 0 is 12 o'clock, angles grow clockwise. */
export interface PieSlice {
  /** Where the slice begins, 0 <= startAngle <= 360. */
  startAngle: number;
  /** How far it sweeps; the last slice ends exactly at 360. */
  sweepAngle: number;
}

/**
 * Turns report rows into cumulative SVG angles.
 *
 * Angles accumulate from the cents instead of being rounded per slice: the
 * start of one slice is the end of the one before, and the last end is fixed at
 * 360° so a row of tiny slices can never leave a hairline gap at the top. A
 * zero-cent slice keeps its place with a zero sweep. As in integerPercents,
 * `rows` must be a partition of `total`.
 */
export function pieSlices(
  rows: readonly { cents: number }[],
  total: number
): PieSlice[] {
  assertCents(total, 'total');
  let sum = 0;
  rows.forEach((row, index) => {
    assertCents(row.cents, `rows[${index}].cents`);
    sum += row.cents;
  });
  if (sum !== total) {
    throw new RangeError(`rows must add up to total: ${sum} !== ${total}`);
  }
  if (total === 0) return rows.map(() => ({ startAngle: 0, sweepAngle: 0 }));

  // One multiplication before the division keeps the angle as close to the
  // exact value as a double allows (cumulative/total*360 rounds twice).
  const angleOf = (cents: number): number => (cents * 360) / total;

  const slices: PieSlice[] = [];
  let cumulative = 0;
  rows.forEach((row, index) => {
    const startAngle = angleOf(cumulative);
    cumulative += row.cents;
    // The final slice is closed against 360 rather than against the rounded
    // cumulative ratio, so the donut always ends where it began.
    const endAngle = index === rows.length - 1 ? 360 : angleOf(cumulative);
    slices.push({ startAngle, sweepAngle: endAngle - startAngle });
  });
  return slices;
}
