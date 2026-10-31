import { describe, it, expect, vi } from 'vitest';
import {
  assertDateISO,
  daysBetweenISO,
  formatMonthDay,
  formatMonthLabel,
  isMonthKey,
  monthKeyOf,
  monthRange,
  shiftMonthKey,
  todayLocalISO,
} from '../../src/domain/date';

describe('date', () => {
  it('takes month key from the literal date, not UTC', () => {
    expect(monthKeyOf('2026-10-31')).toBe('2026-10');
    expect(monthKeyOf('2026-11-01')).toBe('2026-11');
    expect(monthKeyOf('2026-02-28')).toBe('2026-02');
  });
  it('builds inclusive month ranges', () => {
    expect(monthRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(monthRange('2026-10')).toEqual({ start: '2026-10-01', end: '2026-10-31' });
  });
  it('formats today as local YYYY-MM-DD', () => {
    expect(todayLocalISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// The cases below are not in the brief's code block; they pin down the
// decisions for this task (28/29/30/31-day months, local rather than UTC).
describe('monthRange month lengths', () => {
  it('handles 29-day and 30-day months', () => {
    expect(monthRange('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(monthRange('2026-04')).toEqual({ start: '2026-04-01', end: '2026-04-30' });
    expect(monthRange('2026-12')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
  });
});

describe('formatMonthDay', () => {
  it('formats a calendar day without leading zeroes', () => {
    expect(formatMonthDay('2026-10-20')).toBe('10月20日');
    expect(formatMonthDay('2026-01-05')).toBe('1月5日');
  });

  it('rejects anything that is not a YYYY-MM-DD day', () => {
    expect(() => formatMonthDay('2026-10')).toThrow(RangeError);
    expect(() => formatMonthDay('')).toThrow(RangeError);
  });
});

describe('month browsing helpers', () => {
  it('shifts across a year boundary in both directions', () => {
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(shiftMonthKey('2026-12', 1)).toBe('2027-01');
    expect(shiftMonthKey('2026-10', 0)).toBe('2026-10');
    expect(shiftMonthKey('2024-02', 1)).toBe('2024-03');
  });

  it('accepts exactly the YYYY-MM shape a month input produces', () => {
    expect(isMonthKey('2026-10')).toBe(true);
    expect(isMonthKey('2026-12')).toBe(true);
    for (const value of ['', '2026-1', '2026-13', '2026-00', '202610', '2026-10-01']) {
      expect(isMonthKey(value)).toBe(false);
    }
  });
});

describe('todayLocalISO local calendar', () => {
  it('uses local calendar parts, never UTC', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 5, 0, 30));
      expect(todayLocalISO()).toBe('2026-01-05');
      vi.setSystemTime(new Date(2026, 5, 30, 23, 30));
      expect(todayLocalISO()).toBe('2026-06-30');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatMonthLabel', () => {
  it('names the month the way the bar shows it', () => {
    expect(formatMonthLabel('2026-10')).toBe('2026年10月');
    expect(formatMonthLabel('2026-01')).toBe('2026年1月');
    expect(formatMonthLabel('2025-12')).toBe('2025年12月');
  });

  it('refuses anything that is not a month key', () => {
    expect(() => formatMonthLabel('2026-13')).not.toThrow();
    expect(() => formatMonthLabel('2026-10-21')).toThrow(RangeError);
    expect(() => formatMonthLabel('')).toThrow(RangeError);
  });
});

// 固定支出 detection measures the distance between two bills, so the ledger
// needs one exact, time-zone-free day counter. Everything below pins the
// calendar cases a Date-based subtraction gets wrong (DST, leap days, UTC
// midnight drift).
describe('assertDateISO', () => {
  it('accepts real calendar days', () => {
    for (const date of ['2026-10-20', '2028-02-29', '2026-01-31', '2026-12-01']) {
      expect(() => assertDateISO(date)).not.toThrow();
    }
  });

  it('rejects impossible days, wrong shapes and empty input', () => {
    for (const date of [
      '2026-02-29',
      '2026-02-30',
      '2026-04-31',
      '2026-00-10',
      '2026-13-01',
      '2026-1-01',
      '2026/10/20',
      '20261020',
      '2026-10-20 ',
      '',
    ]) {
      expect(() => assertDateISO(date)).toThrow(RangeError);
    }
  });
});

describe('daysBetweenISO', () => {
  it('counts whole days forward, never through a time zone', () => {
    expect(daysBetweenISO('2026-10-01', '2026-11-01')).toBe(31);
    expect(daysBetweenISO('2026-01-31', '2026-02-28')).toBe(28);
    expect(daysBetweenISO('2026-02-28', '2026-03-28')).toBe(28);
    expect(daysBetweenISO('2026-09-01', '2026-10-07')).toBe(36);
    expect(daysBetweenISO('2026-01-01', '2027-01-01')).toBe(365);
    expect(daysBetweenISO('2026-10-20', '2026-10-20')).toBe(0);
  });

  it('handles leap days and century rules', () => {
    expect(daysBetweenISO('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetweenISO('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetweenISO('2000-02-28', '2000-03-01')).toBe(2);
    expect(daysBetweenISO('1900-02-28', '1900-03-01')).toBe(1);
  });

  it('is signed, so the caller can order either way', () => {
    expect(daysBetweenISO('2026-11-01', '2026-10-01')).toBe(-31);
    expect(daysBetweenISO('2026-03-01', '2026-02-28')).toBe(-1);
  });

  // A DST spring-forward day is 23 hours long. Subtracting local Date objects
  // would report 0.958 days and floor to 0; counting calendar days does not.
  it('ignores daylight-saving shifts', () => {
    expect(daysBetweenISO('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetweenISO('2026-10-31', '2026-11-02')).toBe(2);
  });

  it('rejects anything that is not a real YYYY-MM-DD day', () => {
    expect(() => daysBetweenISO('2026-02-30', '2026-03-01')).toThrow(RangeError);
    expect(() => daysBetweenISO('2026-10-01', '2026-13-01')).toThrow(RangeError);
    expect(() => daysBetweenISO('', '2026-10-01')).toThrow(RangeError);
  });
});
