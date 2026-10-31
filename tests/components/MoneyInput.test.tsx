import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MoneyInput } from '../../src/components/MoneyInput';

describe('MoneyInput', () => {
  it('renders a decimal keyboard field carrying its value', () => {
    const html = renderToString(<MoneyInput value="12.3" onChange={() => {}} />);
    // HTML attribute names are case-insensitive; React renders the JSX prop name.
    expect(html.toLowerCase()).toContain('inputmode="decimal"');
    expect(html).toContain('value="12.3"');
  });
  it('marks invalid input with aria-invalid', () => {
    const html = renderToString(<MoneyInput value="12.345" onChange={() => {}} invalid />);
    expect(html).toContain('aria-invalid="true"');
  });
});
