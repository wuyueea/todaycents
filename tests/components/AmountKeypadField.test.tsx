import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { AmountKeypadField } from '../../src/components/AmountKeypadField';

function render(value: string, extra: Partial<Parameters<typeof AmountKeypadField>[0]> = {}): string {
  return renderToString(
    <AmountKeypadField value={value} onChange={() => {}} label="预算" {...extra} />
  );
}

describe('AmountKeypadField', () => {
  it('renders a display button, not a text input, with grouped money', () => {
    const html = render('1234.56', { id: 'budget' });

    expect(html).toContain('id="budget"');
    expect(html).toContain('data-amount-open="true"');
    expect(html).toContain('type="button"');
    expect(html).toContain('1,234.56');
    expect(html).not.toContain('<input');
  });

  it('shows the placeholder while empty and marks invalid', () => {
    const html = render('', { invalid: true, placeholder: '可不填' });

    expect(html).toContain('可不填');
    expect(html).toContain('aria-invalid="true"');
    expect(html).not.toContain('0.00</button>');
  });

  it('is disabled with the rest of the form', () => {
    expect(render('12.30', { disabled: true })).toContain('disabled=""');
  });
});
