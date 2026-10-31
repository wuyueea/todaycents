import { describe, it, expect } from 'vitest';
import {
  compareByCentsThenName,
  integerPercents,
  pieSlices,
  sharePercentTenths,
  top3WithRest,
} from '../../src/domain/report';

describe('integerPercents', () => {
  it('gives the only part the whole hundred', () => {
    expect(integerPercents([2640], 2640)).toEqual([100]);
  });

  it('sums to exactly 100 when a third repeats', () => {
    // 33.33% each: the floors leave one point, and the first part takes it.
    expect(integerPercents([1, 1, 1], 3)).toEqual([34, 33, 33]);
  });

  it('gives the leftover point to the largest remainder, not the largest part', () => {
    // 1/6 = 16.67%, 2/6 = 33.33%, 3/6 = 50%: after the floors only 99 is used,
    // and the 1-cent part carries the biggest remainder (0.67), so it is raised.
    expect(integerPercents([1, 2, 3], 6)).toEqual([17, 33, 50]);
  });

  it('breaks a remainder tie by position', () => {
    expect(integerPercents([1, 1, 1, 1, 1, 1], 6)).toEqual([17, 17, 17, 17, 16, 16]);
  });

  it('keeps zero cents at zero percent and has nothing to say about a zero total', () => {
    expect(integerPercents([0, 100], 100)).toEqual([0, 100]);
    expect(integerPercents([], 0)).toEqual([]);
    expect(integerPercents([0, 0], 0)).toEqual([0, 0]);
  });

  it('never produces 99 or 101, and a small part never outranks a larger one', () => {
    const partitions = [
      [1, 1, 1],
      [1000, 1, 1],
      [333, 333, 334],
      [1, 2, 3, 4],
      [5, 5, 5, 5, 5, 5, 5],
      [999999, 1],
      [120000, 1, 1, 1, 1, 1],
    ];
    for (const parts of partitions) {
      const total = parts.reduce((sum, part) => sum + part, 0);
      const percents = integerPercents(parts, total);
      expect(percents.every(Number.isInteger)).toBe(true);
      expect(percents.reduce((sum, percent) => sum + percent, 0)).toBe(100);
      for (let i = 0; i < parts.length; i++) {
        for (let j = 0; j < parts.length; j++) {
          if (parts[i] > parts[j]) expect(percents[i]).toBeGreaterThanOrEqual(percents[j]);
        }
      }
    }
  });

  it('is deterministic', () => {
    const first = integerPercents([7, 11, 13, 17, 19, 23], 90);
    const second = integerPercents([7, 11, 13, 17, 19, 23], 90);
    expect(first).toEqual(second);
    expect(first.reduce((sum, percent) => sum + percent, 0)).toBe(100);
  });

  it('refuses parts that do not partition the total, and non-integer money', () => {
    expect(() => integerPercents([1], 2)).toThrow(RangeError);
    expect(() => integerPercents([-1, 2], 1)).toThrow(RangeError);
    expect(() => integerPercents([1.5, 1.5], 3)).toThrow(RangeError);
    expect(() => integerPercents([100], -100)).toThrow(RangeError);
    expect(() => integerPercents([100], 1.5)).toThrow(RangeError);
  });
});

describe('top3WithRest', () => {
  it('takes the three largest and joins the rest into one line', () => {
    const rows = [
      { name: '通讯', cents: 8988, categoryId: 'c' },
      { name: '饮食', cents: 48620, categoryId: 'a' },
      { name: '订阅', cents: 6000, categoryId: 'd' },
      { name: '交通', cents: 24400, categoryId: 'b' },
      { name: '娱乐', cents: 3000, categoryId: 'e' },
      { name: '其他', cents: 1000, categoryId: 'f' },
    ];
    const result = top3WithRest(rows);
    expect(result.top.map(row => row.name)).toEqual(['饮食', '交通', '通讯']);
    expect(result.top.map(row => row.categoryId)).toEqual(['a', 'b', 'c']);
    expect(result.restNames).toBe('订阅 娱乐 其他');
    expect(result.rest.map(row => row.name)).toEqual(['订阅', '娱乐', '其他']);
    expect(result.restCents).toBe(10000);
  });

  it('has no rest line when three or fewer rows exist', () => {
    const one = top3WithRest([{ name: '饮食', cents: 1 }]);
    expect(one.top.map(row => row.name)).toEqual(['饮食']);
    expect(one.restNames).toBe('');
    expect(one.rest).toEqual([]);
    expect(one.restCents).toBe(0);

    const three = top3WithRest([
      { name: 'b', cents: 2 },
      { name: 'a', cents: 3 },
      { name: 'c', cents: 1 },
    ]);
    expect(three.top.map(row => row.name)).toEqual(['a', 'b', 'c']);
    expect(three.restNames).toBe('');
  });

  it('breaks a cents tie by name, never by input order', () => {
    const tied = [
      { name: 'c', cents: 100 },
      { name: 'a', cents: 100 },
      { name: 'b', cents: 100 },
      { name: 'd', cents: 100 },
    ];
    const result = top3WithRest(tied);
    expect(result.top.map(row => row.name)).toEqual(['a', 'b', 'c']);
    expect(result.restNames).toBe('d');
  });

  it('sorts by cents first and name second', () => {
    const rows = [
      { name: 'b', cents: 100 },
      { name: 'z', cents: 300 },
      { name: 'a', cents: 200 },
      { name: 'c', cents: 200 },
    ];
    expect(top3WithRest(rows).top.map(row => row.name)).toEqual(['z', 'a', 'c']);
    expect(compareByCentsThenName(rows[0], rows[2])).toBeGreaterThan(0);
    expect(compareByCentsThenName(rows[2], rows[3])).toBeLessThan(0);
  });

  it('does not reorder the rows of the caller in place', () => {
    const rows = [
      { name: 'b', cents: 1 },
      { name: 'a', cents: 2 },
    ];
    top3WithRest(rows);
    expect(rows.map(row => row.name)).toEqual(['b', 'a']);
  });

  it('handles an empty month', () => {
    expect(top3WithRest([])).toEqual({ top: [], rest: [], restNames: '', restCents: 0 });
  });
});

describe('pieSlices', () => {
  it('splits a third into three equal slices', () => {
    expect(pieSlices([{ cents: 1 }, { cents: 1 }, { cents: 1 }], 3)).toEqual([
      { startAngle: 0, sweepAngle: 120 },
      { startAngle: 120, sweepAngle: 120 },
      { startAngle: 240, sweepAngle: 120 },
    ]);
  });

  it('draws uneven slices without a gap', () => {
    expect(pieSlices([{ cents: 1 }, { cents: 2 }], 3)).toEqual([
      { startAngle: 0, sweepAngle: 120 },
      { startAngle: 120, sweepAngle: 240 },
    ]);
  });

  it('gives a zero-cent slice a zero sweep without shifting the rest', () => {
    expect(pieSlices([{ cents: 50 }, { cents: 0 }, { cents: 50 }], 100)).toEqual([
      { startAngle: 0, sweepAngle: 180 },
      { startAngle: 180, sweepAngle: 0 },
      { startAngle: 180, sweepAngle: 180 },
    ]);
  });

  it('accumulates so the last slice ends at 360 degrees', () => {
    const rows = Array.from({ length: 7 }, () => ({ cents: 1 }));
    const slices = pieSlices(rows, 7);
    expect(slices[0]).toEqual({ startAngle: 0, sweepAngle: 360 / 7 });
    for (let i = 1; i < slices.length; i++) {
      expect(slices[i].startAngle).toBeCloseTo(
        slices[i - 1].startAngle + slices[i - 1].sweepAngle,
        9
      );
    }
    expect(slices[6].startAngle).toBeCloseTo((6 / 7) * 360, 9);
    expect(slices[6].startAngle + slices[6].sweepAngle).toBeCloseTo(360, 9);
    expect(slices.reduce((sum, slice) => sum + slice.sweepAngle, 0)).toBeCloseTo(360, 9);
  });

  it('has no angles to draw for an empty or zero total', () => {
    expect(pieSlices([], 0)).toEqual([]);
    expect(pieSlices([{ cents: 0 }], 0)).toEqual([{ startAngle: 0, sweepAngle: 0 }]);
  });

  it('refuses rows that do not add up to the total, and non-integer money', () => {
    expect(() => pieSlices([{ cents: 1 }], 2)).toThrow(RangeError);
    expect(() => pieSlices([{ cents: 1 }], -1)).toThrow(RangeError);
    expect(() => pieSlices([{ cents: 1.5 }], 1.5)).toThrow(RangeError);
  });
});

// Moved here when 统计 was folded into 报表: the bar helper outlived the screen
// because 项目详情 draws the same bars.
describe('sharePercentTenths', () => {
  it('reports one decimal as integer tenths', () => {
    expect(sharePercentTenths(2640, 2640)).toBe(1000);
    expect(sharePercentTenths(867, 1000)).toBe(867);
    expect(sharePercentTenths(1, 3)).toBe(333);
  });

  it('reports nothing for a zero, negative or non-integer input', () => {
    expect(sharePercentTenths(0, 100)).toBe(0);
    expect(sharePercentTenths(100, 0)).toBe(0);
    expect(sharePercentTenths(-5, 100)).toBe(0);
    expect(sharePercentTenths(1.5, 100)).toBe(0);
    expect(sharePercentTenths(10, 3.3)).toBe(0);
  });
});
