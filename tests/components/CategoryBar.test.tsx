import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CategoryBar } from '../../src/components/CategoryBar';

/**
 * CategoryBar is a pure render component: it takes the numbers the stats
 * screen computed and paints one row. It never queries, and it never divides:
 * `percent` arrives already rounded to one decimal.
 */
describe('CategoryBar', () => {
  it('renders name, amount and one-decimal percent', () => {
    const html = renderToString(<CategoryBar name="饮食" cents={2290} percent={86.7} />);
    expect(html).toContain('饮食');
    expect(html).toContain('22.90');
    expect(html).toContain('86.7%');
  });

  it('normalises the bar width to the largest share in the list', () => {
    const largest = renderToString(
      <CategoryBar name="饮食" cents={2290} percent={86.7} maxPercent={86.7} />
    );
    expect(largest).toContain('width:100%');

    const smaller = renderToString(
      <CategoryBar name="交通" cents={350} percent={13.3} maxPercent={86.7} />
    );
    const width = /width:([\d.]+)%/.exec(smaller)?.[1];
    expect(Number(width)).toBeCloseTo(15.3, 1);
  });

  it('keeps exactly one decimal for zero and full shares', () => {
    expect(renderToString(<CategoryBar name="未分类" cents={5} percent={0} />)).toContain('0.0%');
    expect(renderToString(<CategoryBar name="未分类" cents={5} percent={100} />)).toContain('100.0%');
  });

  it('treats the track as the whole and never overflows it', () => {
    const html = renderToString(
      <CategoryBar name="饮食" cents={2290} percent={120} maxPercent={86.7} />
    );
    expect(html).toContain('width:100%');
    expect(html).toContain('100.0%');
  });
});
