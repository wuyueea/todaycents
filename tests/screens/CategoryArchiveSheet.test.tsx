import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CategoryArchiveSheet } from '../../src/screens/CategoriesScreen';

function render(node: React.ReactElement): string {
  return renderToString(node).replace(/<!-- -->/g, '');
}

describe('CategoryArchiveSheet', () => {
  it('states the child count and that restoring the parent will not bring them back', () => {
    const html = render(
      <CategoryArchiveSheet
        categoryName="运动"
        liveChildCount={2}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain('「运动」下还有 2 个未归档的二级分类');
    expect(html).toContain('归档会连同它们一起收进「已归档」');
    expect(html).toContain('历史流水不受影响');
    expect(html).toContain('恢复一级分类时，这些二级分类不会自动回来');
    expect(html).toContain('2 个二级分类');
    expect(html).toMatch(/role="dialog"/);
  });

  it('disables both actions while the archive is running', () => {
    const html = render(
      <CategoryArchiveSheet
        categoryName="运动"
        liveChildCount={1}
        busy
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toMatch(/<button[^>]*disabled[^>]*>归档/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>取消/);
  });
});
