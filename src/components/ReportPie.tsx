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
 * 320x178 viewBox (the width of a 360dp phone minus its 20dp padding), with
 * the centre at y=88 so the top labels have room above the ring.
 */

/** The drawing's box, in user units. 0° is 12 o'clock and angles grow clockwise. */
export const PIE_VIEW = {
  width: 320,
  height: 236,
  cx: 160,
  cy: 140,
  radius: 60,
} as const;

/**
 * The anchor sits just outside the ring at the slice's mid-angle, and the bend
 * a little farther out on the same radius. The horizontal run starts at the
 * bend's x; spreadLabels may move the bend's y, but the start still belongs to
 * the wedge it labels.
 */
const LEADER_RADIUS = PIE_VIEW.radius + 4;

/**
 * Where the text begins on each side. The bend's x comes from the slice's own
 * radius, so each leader starts from the wedge it describes; the horizontal
 * run lands on the text edge at the spread label row.
 */
const RIGHT_TEXT = 243;
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
  /** SVG polyline points: ring anchor, rail elbow, then the horizontal run to the text. */
  points: string;
  labelX: number;
  labelY: number;
  anchor: 'start' | 'end';
  side: 'left' | 'right';
}

/** A label's anchor and bend, before the labels are spread. */
interface LeaderDraft {
  anchor: { x: number; y: number };
  bend: { x: number; y: number };
  side: 'left' | 'right';
}

function draftFor(midAngleDeg: number): LeaderDraft {
  // The prototype: leave the wedge at its mid-angle, then run out to r+14.
  // The bend keeps the radial x even when spreadLabels moves its y later, so
  // the start of each line still belongs to the wedge it labels.
  const anchor = piePoint(midAngleDeg, LEADER_RADIUS);
  const bend = piePoint(midAngleDeg, PIE_VIEW.radius + 14);
  return {
    anchor,
    bend,
    side: bend.x >= PIE_VIEW.cx ? 'right' : 'left',
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
 * Places each side's labels above or below the pie centre according to the
 * direction of its anchor's radius. Upward anchors get rows above the anchor;
 * downward anchors get rows below. This is what makes the diagonal pull out in
 * the same vertical direction as the wedge instead of folding every label to
 * one side.
 */
function placeLabels(drafts: readonly LeaderDraft[]): number[] {
  const result = drafts.map(() => 0);

  for (const side of ['left', 'right'] as const) {
    const indexes = drafts
      .map((draft, index) => ({ draft, index }))
      .filter(entry => entry.draft.side === side)
      .sort((a, b) => a.draft.anchor.y - b.draft.anchor.y);

    const up = indexes.filter(entry => entry.draft.anchor.y < PIE_VIEW.cy);
    const down = indexes.filter(entry => entry.draft.anchor.y >= PIE_VIEW.cy);

    if (up.length > 0) {
      const last = Math.min(LABEL_BOTTOM, up[up.length - 1]!.draft.anchor.y - 8);
      let first = last - (up.length - 1) * LABEL_MIN_GAP;
      if (first < LABEL_TOP) first = LABEL_TOP;
      up.forEach((entry, row) => {
        result[entry.index] = round2(first + row * LABEL_MIN_GAP);
      });
    }

    if (down.length > 0) {
      const first = Math.max(LABEL_TOP, down[0]!.draft.anchor.y + 8);
      down.forEach((entry, row) => {
        result[entry.index] = round2(Math.min(LABEL_BOTTOM, first + row * LABEL_MIN_GAP));
      });
    }
  }

  return result;
}

/**
 * Routes every label out of its slice in one pass.
 *
 * The prototype shape is two segments: leave the correct wedge at its mid-angle
 * and run out along that radius, then turn horizontal on the label's row.
 * Because the second segment is at the spread label's own y, neighbouring
 * leaders no longer share one vertical rail and cannot pile up on each other.
 * The geometry test pins the anchor to the wedge mid-angle and the bend to the
 * r+14 radial x.
 */
export function layoutLeaders(midAngles: readonly number[]): LeaderGeometry[] {
  const drafts = midAngles.map(draftFor);
  const spread = placeLabels(drafts);

  return drafts.map((draft, index) => {
    const side = draft.side;
    const labelY = spread[index]!;
    const labelX = side === 'right' ? RIGHT_TEXT : LEFT_TEXT;
    const bendX = round2(draft.bend.x);
    return {
      // Prototype routing: anchor on the wedge mid-angle, bend on the same
      // radius's x, then horizontal on the spread label row.
      points: `${draft.anchor.x},${draft.anchor.y} ${bendX},${labelY} ${labelX},${labelY}`,
      labelX,
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