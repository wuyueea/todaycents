import { describe, it, expect } from 'vitest';
import type { RecurringRow } from '../../src/domain/recurring';
import { findRecurringRuns, monthEndClampedPlusOneMonth } from '../../src/domain/recurring';

/**
 * One row of the ledger the detector is allowed to see: a live expense, its
 * positive magnitude, the category it landed in and its payee. The helper
 * builds the same bill repeatedly so a test only states what it varies.
 */
let seq = 0;
function bill(
  date: string,
  cents: number,
  extra: Partial<Omit<RecurringRow, 'id' | 'occurredDate' | 'amountCents'>> = {}
): RecurringRow {
  seq += 1;
  return {
    id: `t${seq}`,
    occurredDate: date,
    amountCents: cents,
    categoryId: 'cat-phone',
    payee: '话费',
    ...extra,
  };
}

/** 1st of each listed month, same amount: the classic phone bill. */
function monthly(dates: readonly string[], cents: number): RecurringRow[] {
  return dates.map(date => bill(date, cents));
}

describe('monthEndClampedPlusOneMonth', () => {
  it('clamps a month-end bill to the shorter month it lands in', () => {
    expect(monthEndClampedPlusOneMonth('2026-01-31')).toBe('2026-02-28');
    expect(monthEndClampedPlusOneMonth('2028-01-31')).toBe('2028-02-29');
    expect(monthEndClampedPlusOneMonth('2026-08-31')).toBe('2026-09-30');
    expect(monthEndClampedPlusOneMonth('2026-03-31')).toBe('2026-04-30');
    expect(monthEndClampedPlusOneMonth('2026-01-30')).toBe('2026-02-28');
  });

  it('keeps the day when the next month is long enough', () => {
    expect(monthEndClampedPlusOneMonth('2026-10-01')).toBe('2026-11-01');
    expect(monthEndClampedPlusOneMonth('2026-10-15')).toBe('2026-11-15');
    expect(monthEndClampedPlusOneMonth('2026-01-28')).toBe('2026-02-28');
    expect(monthEndClampedPlusOneMonth('2026-01-29')).toBe('2026-02-28');
  });

  it('crosses the year boundary', () => {
    expect(monthEndClampedPlusOneMonth('2026-12-15')).toBe('2027-01-15');
    expect(monthEndClampedPlusOneMonth('2026-12-31')).toBe('2027-01-31');
  });

  it('refuses anything that is not a real calendar day', () => {
    for (const date of ['2026-02-30', '2026-13-01', '2026-1-01', '', '2026-10-01 ']) {
      expect(() => monthEndClampedPlusOneMonth(date)).toThrow(RangeError);
    }
  });
});

describe('findRecurringRuns', () => {
  it('finds the five-month phone bill and names it by its payee', () => {
    const rows = monthly(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'], 5988);

    expect(findRecurringRuns(rows)).toEqual([
      {
        categoryId: 'cat-phone',
        payee: '话费',
        name: '话费',
        txnIds: rows.map(row => row.id),
        firstDate: '2026-01-01',
        lastDate: '2026-05-01',
        nextDate: '2026-06-01',
        occurrences: 5,
        monthlyCents: 5988,
      },
    ]);
  });

  it('names a run by its category when no payee is recorded', () => {
    const rows = monthly(['2026-01-01', '2026-02-01', '2026-03-01'], 3000).map(row => ({
      ...row,
      payee: null,
    }));
    const runs = findRecurringRuns(rows, { categoryNames: { 'cat-phone': '通讯' } });
    expect(runs[0]).toMatchObject({ payee: null, name: '通讯' });
  });

  it('treats a blank payee as no payee at all', () => {
    const rows = monthly(['2026-01-01', '2026-02-01', '2026-03-01'], 3000).map(row => ({
      ...row,
      payee: '   ',
    }));
    const runs = findRecurringRuns(rows, { categoryNames: { 'cat-phone': '通讯' } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ payee: null, name: '通讯' });
  });

  it('trims and merges payee spellings into one identity', () => {
    const rows = [
      bill('2026-01-01', 5988, { payee: '话费' }),
      bill('2026-02-01', 5988, { payee: ' 话费 ' }),
      bill('2026-03-01', 5988, { payee: '话费' }),
    ];
    const runs = findRecurringRuns(rows);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ name: '话费', occurrences: 3 });
  });

  // The contract says 25–35 days inclusive, so both endpoints must be found.
  it('accepts gaps of exactly 25 and exactly 35 days', () => {
    const rows = monthly(['2026-01-01', '2026-01-26', '2026-03-02'], 5988);
    expect(findRecurringRuns(rows)[0]).toMatchObject({
      firstDate: '2026-01-01',
      lastDate: '2026-03-02',
      occurrences: 3,
    });
  });

  describe('near-miss: the gap window', () => {
    it('rejects a 24-day gap', () => {
      const rows = monthly(['2026-01-01', '2026-01-25', '2026-02-25'], 5988);
      expect(findRecurringRuns(rows)).toEqual([]);
    });

    it('rejects a 36-day gap', () => {
      const rows = monthly(['2026-01-01', '2026-01-26', '2026-03-03'], 5988);
      expect(findRecurringRuns(rows)).toEqual([]);
    });
  });

  describe('near-miss: the amount window around the median', () => {
    it('accepts exactly 15% above and exactly 15% below the median', () => {
      const above = monthly(['2026-01-01', '2026-02-01', '2026-03-01'], 1000);
      above[2].amountCents = 1150;
      expect(findRecurringRuns(above)[0]).toMatchObject({ occurrences: 3, monthlyCents: 1150 });

      const below = monthly(['2026-01-01', '2026-02-01', '2026-03-01'], 2000);
      below[0].amountCents = 1700;
      expect(findRecurringRuns(below)[0]).toMatchObject({ occurrences: 3, monthlyCents: 2000 });
    });

    it('rejects 16% above and 16% below the median', () => {
      const above = monthly(['2026-01-01', '2026-02-01', '2026-03-01'], 1000);
      above[2].amountCents = 1160;
      expect(findRecurringRuns(above)).toEqual([]);

      const below = monthly(['2026-01-01', '2026-02-01', '2026-03-01'], 2000);
      below[0].amountCents = 1680;
      expect(findRecurringRuns(below)).toEqual([]);
    });

    it('measures every bill against the run median, not against its neighbour', () => {
      // 900 and 1100 are each 10% from the median 1000; neither is within 15%
      // of the other, and a neighbour-based rule would throw the run away.
      const rows = monthly(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'], 1000);
      rows[0].amountCents = 900;
      rows[3].amountCents = 1100;
      expect(findRecurringRuns(rows)[0]).toMatchObject({ occurrences: 4, monthlyCents: 1100 });
    });

    it('rejects a 30% jump at the end of the run', () => {
      const rows = monthly(
        ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'],
        5900
      );
      rows[4].amountCents = 7670;
      expect(findRecurringRuns(rows)).toEqual([]);
    });

    it('rejects a 30% jump in the middle of the run', () => {
      const rows = monthly(
        ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'],
        5900
      );
      rows[2].amountCents = 7670;
      expect(findRecurringRuns(rows)).toEqual([]);
    });
  });

  describe('near-miss: the run length', () => {
    it('rejects two bills and accepts three', () => {
      expect(findRecurringRuns(monthly(['2026-01-01', '2026-02-01'], 5988))).toEqual([]);
      expect(findRecurringRuns(monthly(['2026-01-01', '2026-02-01', '2026-03-01'], 5988))).toHaveLength(1);
    });
  });

  it('keeps the most recent run when a group has two qualifying stretches', () => {
    const rows = [
      ...monthly(['2026-01-01', '2026-01-31', '2026-03-02', '2026-04-01'], 1000),
      ...monthly(['2026-07-01', '2026-07-31', '2026-08-30'], 2000),
    ];
    const runs = findRecurringRuns(rows);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      firstDate: '2026-07-01',
      lastDate: '2026-08-30',
      occurrences: 3,
      monthlyCents: 2000,
    });
  });

  it('still reports an older clean run when a newer stray charge breaks the pattern', () => {
    const rows = [
      ...monthly(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'], 5988),
      bill('2026-10-15', 1500),
    ];
    const runs = findRecurringRuns(rows);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ lastDate: '2026-04-01', occurrences: 4 });
  });

  it('splits one category into one identity per payee', () => {
    const rows = [
      ...monthly(['2026-01-01', '2026-02-01', '2026-03-01'], 5988),
      ...monthly(['2026-01-20', '2026-02-20', '2026-03-20'], 3000).map(row => ({
        ...row,
        payee: '校园网',
      })),
    ];
    const runs = findRecurringRuns(rows);
    expect(runs.map(run => [run.name, run.occurrences, run.monthlyCents]).sort()).toEqual([
      ['校园网', 3, 3000],
      ['话费', 3, 5988],
    ]);
  });

  it('keeps different categories apart', () => {
    const rows = [
      ...monthly(['2026-01-01', '2026-02-01', '2026-03-01'], 5988).map(row => ({
        ...row,
        payee: null,
      })),
      ...monthly(['2026-01-15', '2026-02-15', '2026-03-15'], 2500).map(row => ({
        ...row,
        categoryId: 'cat-subs',
        payee: null,
      })),
    ];
    const runs = findRecurringRuns(rows, {
      categoryNames: { 'cat-phone': '通讯', 'cat-subs': '订阅' },
    });
    expect(runs.map(run => run.name).sort()).toEqual(['订阅', '通讯']);
  });

  it('breaks a run when two bills share a day', () => {
    const rows = [
      bill('2026-01-01', 5988),
      bill('2026-02-01', 5988),
      bill('2026-02-01', 5988),
    ];
    expect(findRecurringRuns(rows)).toEqual([]);
  });

  it('orders runs by the most recent bill', () => {
    const rows = [
      ...monthly(['2026-01-01', '2026-02-01', '2026-03-01'], 5988),
      ...monthly(['2026-02-10', '2026-03-10', '2026-04-10'], 2500).map(row => ({
        ...row,
        categoryId: 'cat-subs',
        payee: '视频会员',
      })),
    ];
    expect(findRecurringRuns(rows).map(run => run.name)).toEqual(['视频会员', '话费']);
  });

  it('returns nothing for an empty ledger', () => {
    expect(findRecurringRuns([])).toEqual([]);
  });

  // The thresholds are defaults, not constants: the options exist so a caller
  // can tighten or loosen the rule without a second implementation.
  it('honours overridden thresholds', () => {
    const rows = monthly(['2026-01-01', '2026-02-01'], 5988);
    expect(findRecurringRuns(rows, { minOccurrences: 2 })[0]).toMatchObject({ occurrences: 2 });

    const close = monthly(['2026-01-01', '2026-01-25', '2026-02-18'], 5988);
    expect(findRecurringRuns(close, { minGapDays: 20 })).toHaveLength(1);

    const wide = monthly(['2026-01-01', '2026-02-01', '2026-03-01'], 1000);
    wide[2].amountCents = 1300;
    expect(findRecurringRuns(wide, { tolerancePercent: 30 })).toHaveLength(1);
  });

  it('refuses rows that are not real calendar days', () => {
    expect(() => findRecurringRuns([bill('2026-02-30', 100)])).toThrow(RangeError);
  });

  it('refuses negative or fractional amounts', () => {
    expect(() => findRecurringRuns([bill('2026-01-01', -100)])).toThrow(RangeError);
    expect(() => findRecurringRuns([bill('2026-01-01', 10.5)])).toThrow(RangeError);
  });
});
