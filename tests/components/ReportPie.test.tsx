import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  PIE_VIEW,
  fitLabelName,
  layoutLeaders,
  leaderGeometry,
  piePoint,
  slicePath,
  sliceShade,
  spreadLabels,
  ReportPie,
} from '../../src/components/ReportPie';
import type { ReportCategory } from '../../src/db/repos/reports';

/**
 * The pie is pure geometry over integer cents: report.ts already turned the
 * amounts into cumulative angles, and this module only maps an angle to a
 * point, a wedge to a path, and a slice to one of the six ink steps.
 */

const ROWS: ReportCategory[] = [
  { categoryId: 'c-food', name: '饮食', cents: 48620, percent: 40 },
  { categoryId: 'c-transport', name: '交通', cents: 24400, percent: 20 },
  { categoryId: 'c-daily', name: '日用', cents: 17810, percent: 15 },
  { categoryId: 'c-comm', name: '通讯', cents: 8988, percent: 7 },
  { categoryId: 'c-sub', name: '订阅', cents: 6000, percent: 5 },
  { categoryId: 'c-med', name: '医疗', cents: 15812, percent: 13 },
];
const TOTAL = 121630;

describe('piePoint', () => {
  it('starts at 12 o’clock and grows clockwise', () => {
    expect(piePoint(0)).toEqual({ x: 160, y: 8 });
    expect(piePoint(90)).toEqual({ x: 220, y: 68 });
    expect(piePoint(180)).toEqual({ x: 160, y: 128 });
    expect(piePoint(270)).toEqual({ x: 100, y: 68 });
  });

  it('keeps the radius the caller asks for, the label ring sits outside the pie', () => {
    expect(piePoint(0, PIE_VIEW.radius)).toEqual({ x: 160, y: 8 });
    expect(piePoint(0, PIE_VIEW.radius + 4)).toEqual({ x: 160, y: 4 });
  });
});

describe('slicePath', () => {
  it('draws a wedge from the centre, with the large-arc flag only past half', () => {
    expect(slicePath({ startAngle: 0, sweepAngle: 90 })).toBe(
      'M 160 68 L 160 8 A 60 60 0 0 1 220 68 Z'
    );
    expect(slicePath({ startAngle: 0, sweepAngle: 270 })).toContain('A 60 60 0 1 1 100 68 Z');
    // 0 -> 90 and 90 -> 180 share the point in between: slices close on each other.
    expect(slicePath({ startAngle: 90, sweepAngle: 90 })).toContain('L 220 68 A 60 60 0 0 1 160 128');
  });

  it('paints one slice as a full circle instead of a zero-length arc', () => {
    const full = slicePath({ startAngle: 0, sweepAngle: 360 });
    expect(full.match(/A /g)).toHaveLength(2);
    expect(full).not.toContain('L ');
  });

  it('draws nothing for a slice that sweeps nothing', () => {
    expect(slicePath({ startAngle: 42, sweepAngle: 0 })).toBe('');
  });
});

describe('spreadLabels', () => {
  it('fits six labels on one side without overlap', () => {
    const spread = spreadLabels(
      Array.from({ length: 6 }, (_, index) => ({ side: 'right' as const, y: 50 + index * 2 }))
    );
    expect(new Set(spread).size).toBe(6);
    for (let i = 1; i < spread.length; i += 1) {
      expect(spread[i]! - spread[i - 1]!).toBeGreaterThanOrEqual(28);
    }
    expect(spread[0]!).toBeGreaterThanOrEqual(14);
    expect(spread[5]!).toBeLessThanOrEqual(PIE_VIEW.height - 14);
  });
});

describe('sliceShade', () => {
  it('cycles the six ink steps in order', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(sliceShade)).toEqual([1, 2, 3, 4, 5, 6, 1, 2]);
  });
});

/** Distance from the pie's centre, for proving a point is outside the disc. */
function radiusOf(point: string): number {
  const [x, y] = point.split(',').map(Number);
  return Math.hypot(x! - PIE_VIEW.cx, y! - PIE_VIEW.cy);
}

/** Every vertex of a leader, as "x,y" strings. */
function vertices(leader: { points: string }): string[] {
  return leader.points.split(' ');
}

describe('leaderGeometry', () => {
  // The bug this pins: the old routing solved the elbow's x from a fixed label
  // row, so a slice pointing one way and a label sitting another produced a
  // diagonal that went straight through the pie.
  it('never puts any vertex of the line inside the pie', () => {
    for (let angle = 0; angle < 360; angle += 7) {
      const leader = leaderGeometry(0, angle);
      for (const vertex of vertices(leader)) {
        expect(radiusOf(vertex)).toBeGreaterThanOrEqual(PIE_VIEW.radius);
      }
    }
  });

  it('leaves along the slice’s own radius and only turns outside the pie', () => {
    const leader = leaderGeometry(0, 73);
    const [anchor, elbow, end] = vertices(leader);

    // The first stop is the ring point at the mid angle.
    expect(radiusOf(anchor!)).toBeCloseTo(PIE_VIEW.radius + 4, 1);
    // It travels away from the centre, on that same y.
    expect(Number(anchor!.split(',')[0])).toBeLessThan(Number(elbow!.split(',')[0]!));
    expect(elbow!.split(',')[1]).toBe(anchor!.split(',')[1]);
    // Then straight down the rail, which sits outside the pie's x-range.
    expect(Number(elbow!.split(',')[0])).toBeGreaterThan(PIE_VIEW.cx + PIE_VIEW.radius);
    expect(elbow!.split(',')[0]).toBe(end!.split(',')[0]);
  });

  it('puts left-side labels on the left rail with an end anchor', () => {
    const leader = leaderGeometry(2, 244);
    expect(leader.anchor).toBe('end');
    expect(leader.side).toBe('left');
    expect(leader.labelX).toBe(77);
    // The rail itself sits left of the pie; the anchor stays on its own radius,
    // which is outside the disc even when its x is still inside the disc's span.
    const rail = vertices(leader).slice(1);
    for (const vertex of rail) {
      expect(Number(vertex.split(',')[0])).toBeLessThan(PIE_VIEW.cx - PIE_VIEW.radius);
    }
    expect(radiusOf(vertices(leader)[0]!)).toBeGreaterThanOrEqual(PIE_VIEW.radius);
  });
});

describe('layoutLeaders', () => {
  it('routes three labels without any of them overlapping or leaving the drawing', () => {
    const leaders = layoutLeaders([20, 150, 300]);
    const bySide = { left: [] as number[], right: [] as number[] };
    for (const leader of leaders) bySide[leader.side].push(leader.labelY);

    for (const side of ['left', 'right'] as const) {
      const ys = bySide[side].slice().sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i += 1) {
        expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(28);
      }
      for (const y of ys) {
        expect(y).toBeGreaterThanOrEqual(14);
        expect(y).toBeLessThanOrEqual(PIE_VIEW.height - 14);
      }
    }
  });
});

describe('spreadLabels', () => {
  it('pushes overlapping labels apart and keeps them inside the drawing', () => {
    const spread = spreadLabels([
      { side: 'right', y: 60 },
      { side: 'right', y: 62 },
      { side: 'left', y: 10 },
    ]);
    expect(spread[1]! - spread[0]!).toBeGreaterThanOrEqual(28);
    expect(spread[2]).toBeGreaterThanOrEqual(14);
    for (const y of spread) {
      expect(y).toBeLessThanOrEqual(PIE_VIEW.height - 14);
    }
  });

  it('keeps two far-apart labels where they are', () => {
    const spread = spreadLabels([
      { side: 'right', y: 30 },
      { side: 'left', y: 120 },
    ]);
    expect(spread).toEqual([30, 120]);
  });
});

describe('fitLabelName', () => {
  it('keeps a name that fits and cuts one that does not', () => {
    expect(fitLabelName('医疗', 60)).toBe('医疗');
    const cut = fitLabelName('医疗设备维修基金', 60);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThan('医疗设备维修基金'.length);
  });

  it('counts a Latin character as narrower than a CJK one', () => {
    // 9 Latin characters are narrower than 9 CJK ones, so this fits where
    // 「一二三四五六七八九」 would not.
    expect(fitLabelName('transport', 70)).toBe('transport');
    expect(fitLabelName('一二三四五六七八九', 70)).not.toBe('一二三四五六七八九');
    expect(fitLabelName('一二三四五六七八', 60).length).toBeLessThan(8);
  });
});

describe('ReportPie', () => {
  it('draws one path per category and puts six labels in the label group', () => {
    const html = renderToString(
      <ReportPie categories={ROWS} top={ROWS} totalCents={TOTAL} />
    ).replace(/<!-- -->/g, '');

    expect(html.match(/data-slice="/g)).toHaveLength(6);
    expect(html.match(/reports-pie__slice--/g)).toHaveLength(6);
    expect(html.match(/<polyline/g)).toHaveLength(6);
    const labels = html.match(/<g class="reports-pie__labels">([\s\S]*?)<\/g>/)?.[1] ?? '';
    expect(labels.match(/<text/g)).toHaveLength(6);

    // Labels carry name and percent; amounts belong to the ranking.
    for (const row of ROWS) {
      expect(labels).toContain(row.name);
      expect(labels).toContain(`${row.percent}%`);
    }
    expect(labels).not.toContain('486.20');
    expect(labels).not.toContain('158.12');
  });

  it('never draws more than six labels even when the ranking has more rows', () => {
    const extra: ReportCategory = {
      categoryId: 'c-extra',
      name: '额外分类',
      cents: 1000,
      percent: 1,
    };
    const many = [...ROWS, extra];
    const html = renderToString(
      <ReportPie categories={many} top={many} totalCents={TOTAL + extra.cents} />
    ).replace(/<!-- -->/g, '');
    const labels = html.match(/<g class="reports-pie__labels">([\s\S]*?)<\/g>/)?.[1] ?? '';
    expect(labels.match(/<text/g)).toHaveLength(6);
    expect(labels).not.toContain(extra.name);
  });

  it('offers the six labels as text to a screen reader', () => {
    const html = renderToString(
      <ReportPie categories={ROWS} top={ROWS} totalCents={TOTAL} />
    ).replace(/<!-- -->/g, '');
    expect(html).toContain(
      '钱去哪了：饮食 40%，交通 20%，日用 15%，通讯 7%，订阅 5%，医疗 13%'
    );
  });

  it('leaves the slice-gap stroke to CSS instead of an inline colour', () => {
    const html = renderToString(
      <ReportPie categories={ROWS} top={ROWS.slice(0, 3)} totalCents={TOTAL} />
    );
    expect(html).toContain('reports-pie__slices');
    expect(html).not.toContain('stroke=');
  });

  it('draws a single-category pie as a whole circle', () => {
    const one: ReportCategory[] = [
      { categoryId: 'c-food', name: '饮食', cents: 48620, percent: 100 },
    ];
    const html = renderToString(<ReportPie categories={one} top={one} totalCents={48620} />).replace(
      /<!-- -->/g,
      ''
    );
    expect(html.match(/data-slice="/g)).toHaveLength(1);
    expect(html).toContain('100%');
  });
});