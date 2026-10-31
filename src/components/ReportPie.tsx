import { pieSlices } from '../domain/report';
import type { ReportCategory } from '../db/repos/reports';

/**
 * 钱去哪了: one pie in six steps of ink, three labels on thin leader lines.
 *
 * The screen hands in the rows repository/reports already sorted and already
 * carrying integer percentages; domain/report already turned the cents into
 * cumulative angles. This module owns only the drawing: an angle becomes a
 * point, a sweep becomes a wedge, and each of the first three wedges gets a
 * leader line out to a label. No colour is introduced — every slice is a shade
 * of ink, and the gap between two slices is a 1.5 paper-coloured stroke.
 *
 * The geometry is constants instead of measured text: the pie lives in a fixed
 * 320x178 viewBox (the width of a 360dp phone minus its 20dp padding), so the
 * same numbers hold on every device and the picture is identical to the one in
 * docs/prototypes/shots/a/reports.png.
 */

/** The drawing's box, in user units. 0° is 12 o'clock and angles grow clockwise. */
export const PIE_VIEW = {
  width: 320,
  height: 178,
  cx: 160,
  cy: 68,
  radius: 60,
} as const;

/**
 * Where a leader starts: just outside the ring, and where its elbow sits.
 *
 * The line leaves along the slice's own radius and only then turns horizontal.
 * The earlier version fixed each label to a row and solved the elbow's x from
 * that row, which made a long diagonal cut straight across the pie whenever a
 * slice's mid angle pointed somewhere else — the line crossed the very wedge it
 * described.
 */
const LEADER_RADIUS = PIE_VIEW.radius + 4;

/**
 * The two vertical rails the leaders turn at, and where the text begins.
 *
 * Both sit outside the pie's own x-range (100–220), which is what makes the
 * routing safe: the first segment only ever moves away from the centre
 * horizontally, and the second runs down a rail the pie never reaches. No
 * diagonal exists that could cross a wedge.
 */
const RIGHT_EDGE = 240;
const RIGHT_TEXT = 243;
const LEFT_EDGE = 80;
const LEFT_TEXT = 77;

/** Labels must stay inside the drawing and far enough apart to read. */
const LABEL_TOP = 14;
const LABEL_BOTTOM = PIE_VIEW.height - 14;
const LABEL_MIN_GAP = 28;

/** How much horizontal room a label's first line has, in user units. */
export const LABEL_WIDTH = PIE_VIEW.width - RIGHT_TEXT - 2;

/**
 * Cuts a name to the room its label actually has.
 *
 * SVG text does not wrap or ellipsise, so a long category name simply ran off
 * the drawing — the phone showed 「医疗1111348464…」 hanging past the edge. A CJK
 * glyph is about one em wide and Latin about 0.55, which is close enough to
 * decide where to stop.
 */
export function fitLabelName(name: string, widthUnits: number, fontSize = 11.5): string {
  const widthOf = (char: string): number => (/[⺀-￯]/.test(char) ? fontSize : fontSize * 0.55);
  const ellipsis = widthOf('…');
  let total = 0;
  let kept = '';
  for (const char of name) {
    const next = total + widthOf(char);
    if (next + ellipsis > widthUnits) {
      return kept === '' ? '…' : `${kept}…`;
    }
    kept += char;
    total = next;
  }
  return name;
}

function round2(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * One point on the pie's ring. Angles are degrees clockwise from 12 o'clock,
 * matching domain/report's pieSlices; the y axis points down in SVG, hence the
 * minus on the cosine.
 */
export function piePoint(
  angleDeg: number,
  radius: number = PIE_VIEW.radius
): { x: number; y: number } {
  const radians = (angleDeg * Math.PI) / 180;
  return {
    x: round2(PIE_VIEW.cx + radius * Math.sin(radians)),
    y: round2(PIE_VIEW.cy - radius * Math.cos(radians)),
  };
}

/**
 * The SVG path of one wedge, from the centre out.
 *
 * A full circle is drawn as two half arcs: one arc from a point back to itself
 * has zero length, so the slice would silently disappear. A zero sweep returns
 * an empty path — nothing to paint.
 */
export function slicePath(slice: { startAngle: number; sweepAngle: number }): string {
  if (!(slice.sweepAngle > 0)) return '';
  const { cx, cy, radius } = PIE_VIEW;
  const start = piePoint(slice.startAngle);
  if (slice.sweepAngle >= 359.999) {
    const opposite = piePoint(slice.startAngle + 180);
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 1 1 ${opposite.x} ${opposite.y} A ${radius} ${radius} 0 1 1 ${start.x} ${start.y} Z`;
  }
  const end = piePoint(slice.startAngle + slice.sweepAngle);
  const largeArc = slice.sweepAngle > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

/** The ink step for a slice: the six shades repeat in order. */
export function sliceShade(index: number): number {
  return (index % 6) + 1;
}

/** One leader line: the polyline plus where its two text lines sit. */
export interface LeaderGeometry {
  /** SVG polyline points: ring, elbow, then the horizontal run to the text. */
  points: string;
  labelX: number;
  labelY: number;
  anchor: 'start' | 'end';
  side: 'left' | 'right';
}

/** Where a leader wants to start and turn, before the labels are spread. */
interface LeaderDraft {
  anchor: { x: number; y: number };
  elbow: { x: number; y: number };
  side: 'left' | 'right';
}

function draftFor(midAngleDeg: number): LeaderDraft {
  const anchor = piePoint(midAngleDeg, LEADER_RADIUS);
  // The side is decided where the line starts: a label belongs on the half it
  // is leaving, otherwise the line would have to cross the picture to reach it.
  return {
    anchor,
    elbow: { x: anchor.x >= PIE_VIEW.cx ? RIGHT_EDGE : LEFT_EDGE, y: anchor.y },
    side: anchor.x >= PIE_VIEW.cx ? 'right' : 'left',
  };
}

/**
 * Spreads each side's labels so two of them never overlap.
 *
 * Keeps the order the caller gave (largest slice first), pushes down whatever
 * collides with the line above it, then walks back up if the last one ran past
 * the bottom. Both passes clamp to the drawing, so a crowded side stays legible
 * instead of stacking text on text.
 */
export function spreadLabels(
  wanted: readonly { side: 'left' | 'right'; y: number }[]
): number[] {
  const result = wanted.map(entry => Math.min(Math.max(entry.y, LABEL_TOP), LABEL_BOTTOM));

  for (const side of ['left', 'right'] as const) {
    const indexes = wanted
      .map((entry, index) => (entry.side === side ? index : -1))
      .filter(index => index !== -1)
      .sort((a, b) => result[a]! - result[b]! || a - b);

    for (let i = 1; i < indexes.length; i += 1) {
      const previous = indexes[i - 1]!;
      const current = indexes[i]!;
      result[current] = Math.max(result[current]!, result[previous]! + LABEL_MIN_GAP);
    }
    for (let i = indexes.length - 1; i >= 0; i -= 1) {
      const current = indexes[i]!;
      const next = indexes[i + 1];
      const ceiling = next === undefined ? LABEL_BOTTOM : result[next]! - LABEL_MIN_GAP;
      result[current] = Math.min(result[current]!, ceiling);
      result[current] = Math.max(result[current]!, LABEL_TOP);
    }
  }

  return result.map(value => round2(value));
}

/**
 * Routes every label out of its slice in one pass.
 *
 * The line always leaves along the slice's radius and only turns once it is
 * clear of the pie, so it can never cut across a wedge. The horizontal run then
 * lands on the label's own baseline, which the spread pass has already moved
 * out of its neighbours' way.
 */
export function layoutLeaders(midAngles: readonly number[]): LeaderGeometry[] {
  const drafts = midAngles.map(draftFor);
  const spread = spreadLabels(drafts.map(draft => ({ side: draft.side, y: draft.elbow.y })));

  return drafts.map((draft, index) => {
    const side = draft.side;
    const labelY = spread[index]!;
    const rail = side === 'right' ? RIGHT_EDGE : LEFT_EDGE;
    return {
      // Out along the slice's own radius to the rail, then down the rail to the
      // label's baseline. The rail is outside the pie, so the turn is always
      // clear of it — even when the spread pass moved the label a long way.
      points: `${draft.anchor.x},${draft.anchor.y} ${rail},${draft.anchor.y} ${rail},${labelY}`,
      labelX: side === 'right' ? RIGHT_TEXT : LEFT_TEXT,
      labelY,
      anchor: side === 'right' ? 'start' : 'end',
      side,
    };
  });
}

/** One label's leader, for callers that only need the i-th. */
export function leaderGeometry(_index: number, midAngleDeg: number): LeaderGeometry {
  return layoutLeaders([midAngleDeg])[0]!;
}

export interface ReportPieProps {
  /** Every category of the period, largest first; their cents sum to totalCents. */
  categories: readonly ReportCategory[];
  /** The rows the labels describe: up to six of categories, in order. */
  top: readonly ReportCategory[];
  /** The period's spending, so the slices can be proved to close the circle. */
  totalCents: number;
}

/**
 * The figure: the pie, its leader lines and up to six labels.
 *
 * The svg carries one text alternative for the whole picture. The labels are
 * real text inside it — name and integer percent — while amounts live in the
 * ranking below. With role="img" a screen reader reads the summary instead of
 * walking the label nodes.
 */
export function ReportPie({ categories, top, totalCents }: ReportPieProps) {
  const slices = pieSlices(categories, totalCents);
  // top is the head of categories by contract (the repository builds it that
  // way), so a label's position among the labels is its slice's index.
  const labelled = top.slice(0, 6);
  // One pass for all labels: they have to be spread against each other, so
  // none of them can be routed on its own.
  const leaders = layoutLeaders(
    labelled.map(row => {
      const slice = slices[categories.indexOf(row)] ?? slices[0]!;
      return slice.startAngle + slice.sweepAngle / 2;
    })
  );
  const summary = labelled.map(row => `${row.name} ${row.percent}%`).join('，');

  return (
    <div className="reports-pie">
      <svg
        className="reports-pie__svg"
        viewBox={`0 0 ${PIE_VIEW.width} ${PIE_VIEW.height}`}
        role="img"
        aria-label={`钱去哪了：${summary}`}
      >
        <g className="reports-pie__slices">
          {categories.map((row, index) => {
            const d = slicePath(slices[index]);
            if (d === '') return null;
            return (
              <path
                key={row.categoryId === '' ? `slice-${index}` : row.categoryId}
                data-slice={index}
                className={`reports-pie__slice reports-pie__slice--${sliceShade(index)}`}
                d={d}
              />
            );
          })}
        </g>

        <g className="reports-pie__leaders">
          {leaders.map((leader, index) => (
            <polyline
              key={`leader-${labelled[index]!.categoryId === '' ? index : labelled[index]!.categoryId}`}
              data-leader={index}
              className="reports-pie__leader"
              points={leader.points}
            />
          ))}
        </g>

        <g className="reports-pie__labels">
          {labelled.map((row, index) => {
            const leader = leaders[index]!;
            // The first line carries the name and the percent; whatever does
            // not fit is cut with an ellipsis instead of running off the edge.
            const percentWidth = `${row.percent}%`.length * 10.5 * 0.62;
            const name = fitLabelName(row.name, LABEL_WIDTH - percentWidth - 5);
            return (
              <text
                key={`label-${row.categoryId === '' ? index : row.categoryId}`}
                className="reports-pie__label"
                x={leader.labelX}
                y={leader.labelY}
                textAnchor={leader.anchor}
              >
                <tspan className="reports-pie__name">{name}</tspan>
                <tspan className="reports-pie__percent" dx="5">
                  {`${row.percent}%`}
                </tspan>
              </text>
            );
          })}
        </g>
      </svg>
    </div>
  );
}