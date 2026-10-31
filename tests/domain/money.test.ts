import { describe, it, expect } from 'vitest';
import { parseAmountToCents, formatCents } from '../../src/domain/money';

describe('parseAmountToCents', () => {
  it('parses plain and decimal amounts', () => {
    expect(parseAmountToCents('12')).toBe(1200);
    expect(parseAmountToCents('12.3')).toBe(1230);
    expect(parseAmountToCents('12.30')).toBe(1230);
    expect(parseAmountToCents(' 59.88 ')).toBe(5988);
    expect(parseAmountToCents('\uFF10\uFF0E\uFF15')).toBe(50);
  });
  it('rejects malformed input instead of rounding', () => {
    expect(parseAmountToCents('12.345')).toBeNull();
    expect(parseAmountToCents('1,200')).toBeNull();
    expect(parseAmountToCents('')).toBeNull();
    expect(parseAmountToCents('0')).toBeNull();
    expect(parseAmountToCents('0.00')).toBeNull();
    expect(parseAmountToCents('-5')).toBeNull();
    expect(parseAmountToCents('abc')).toBeNull();
  });
});

describe('formatCents', () => {
  it('always shows two decimals', () => {
    expect(formatCents(1230)).toBe('12.30');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(0)).toBe('0.00');
    expect(formatCents(-700)).toBe('-7.00');
  });
});

// The cases below are not in the brief's code block; they pin down the
// decisions for this task (normalization scope, sub-unit amounts, signs).
describe('parseAmountToCents normalization', () => {
  it('accepts full-width digits and the full-width full stop', () => {
    expect(parseAmountToCents('１２．３４')).toBe(1234);
  });
  it('rejects every other non-ASCII character', () => {
    expect(parseAmountToCents('１２。３４')).toBeNull();
    expect(parseAmountToCents('12元')).toBeNull();
    expect(parseAmountToCents('\u300012\u3000')).toBeNull();
  });
  it('keeps amounts below one unit', () => {
    expect(parseAmountToCents('0.05')).toBe(5);
    expect(parseAmountToCents('0.5')).toBe(50);
  });
});

describe('formatCents guards', () => {
  it('keeps the sign in front of sub-unit values', () => {
    expect(formatCents(-5)).toBe('-0.05');
  });
  it('rejects non-integer cents instead of printing garbage', () => {
    expect(() => formatCents(12.5)).toThrow(RangeError);
  });
});
