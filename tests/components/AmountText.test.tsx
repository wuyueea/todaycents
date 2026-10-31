import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { AmountText, formatCentsDisplay } from '../../src/components/AmountText';
import { formatCents } from '../../src/domain/money';

describe('AmountText', () => {
  it('shows signed amounts with two decimals', () => {
    expect(renderToString(<AmountText cents={-1230} direction="expense" />)).toContain('−12.30');
    expect(renderToString(<AmountText cents={100000} direction="income" />)).toContain('+1,000.00');
    expect(renderToString(<AmountText cents={-123456} direction="expense" />)).toContain('−1,234.56');
    expect(renderToString(<AmountText cents={60000} direction="transfer" />)).toContain('+600.00');
  });

  it('uses U+2212 and digit groups in the display formatter', () => {
    expect(formatCentsDisplay(-123456)).toBe('−1,234.56');
    expect(formatCentsDisplay(123456)).toBe('1,234.56');
    expect(formatCentsDisplay(0)).toBe('0.00');

    const rendered = renderToString(<AmountText cents={-1230} direction="expense" />);
    expect(rendered).toContain('−12.30');
  });

  it('keeps the arithmetic formatter on ASCII and ungrouped', () => {
    const expense = renderToString(<AmountText cents={-1230} direction="expense" />);

    expect(expense).toContain('−12.30');
    expect(expense).not.toContain('-12.30');
    // The display swap never leaks into the single source of truth.
    expect(formatCents(-1230)).toBe('-12.30');
    // A positive number has no leading minus to swap.
    expect(renderToString(<AmountText cents={870} direction="expense" />)).toContain('8.70');
  });

  it('signs every positive movement with a plus so the two transfer legs read as a pair', () => {
    const expense = renderToString(<AmountText cents={-1230} direction="expense" />);
    const income = renderToString(<AmountText cents={30000} direction="income" />);
    const transfer = renderToString(<AmountText cents={60000} direction="transfer" />);
    const adjust = renderToString(<AmountText cents={-500} direction="adjust" />);

    expect(expense).toContain('amount-text--expense');
    expect(income).toContain('amount-text--income');
    expect(transfer).toContain('amount-text--transfer');
    expect(adjust).toContain('amount-text--adjust');
    // Every positive movement is explicitly signed, including the in leg of a
    // transfer; the two legs read "+600 / -600" and keep their direction colour.
    expect(income).toContain('+300.00');
    expect(transfer).toContain('+600.00');
    // The adjustment here is negative, so it keeps its minus and gets no plus.
    expect(adjust).not.toContain('+');
    expect(renderToString(<AmountText cents={500} direction="adjust" />)).toContain('+5.00');
  });

  it('renders integer zero as 0.00', () => {
    expect(renderToString(<AmountText cents={0} direction="adjust" />)).toContain('0.00');
  });
});