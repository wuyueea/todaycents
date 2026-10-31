import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';

function renderAt(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe('app shell', () => {
  it('renders the four tabs and the centre +, and opens on 今天', () => {
    const html = renderAt('/');
    const nav = html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
    // Four labels around the one centre button: the button is an anchor too.
    expect((nav.match(/class="dock__link/g) ?? []).length).toBe(4);
    expect((nav.match(/<a /g) ?? []).length).toBe(5);
    for (const tab of ['今天', '流水', '报表', '设置']) {
      expect(nav).toContain(tab);
    }
    expect(nav).toContain('class="dock__plus"');
    expect(nav).toContain('aria-label="记一笔"');
    expect(html).toContain('<h1>今天</h1>');
  });

  it('renders each tab screen without a working database', () => {
    // 流水 has no page title: the ink bar opens the screen.
    expect(renderAt('/ledger')).toContain('class="ledger-hero"');
    expect(renderAt('/reports')).toContain('<h1>报表</h1>');
    expect(renderAt('/settings')).toContain('<h1>设置</h1>');
  });

  it('renders 存储 as a pushed settings page', () => {
    const html = renderAt('/settings/storage');
    expect(html).toContain('<h1>存储</h1>');
    expect(html).toContain('正在检查权限');
    expect(html).not.toContain('class="dock"');
    expect(html).toContain('class="add-back"');
  });

  it('keeps the centre + in the dock on every tab, never on a pushed page', () => {
    const plus = renderAt('/').match(/<a[^>]*class="dock__plus"[^>]*>/)?.[0] ?? '';
    expect(plus).toContain('href="/add"');
    expect(plus).toContain('aria-label="记一笔"');

    for (const path of ['/ledger', '/reports', '/settings']) {
      expect(renderAt(path)).toContain('class="dock__plus"');
    }
    for (const path of ['/accounts', '/add', '/txn/txn-a', '/settings/storage']) {
      expect(renderAt(path)).not.toContain('class="dock__plus"');
    }
    expect(renderAt('/')).not.toContain('class="fab"');
  });

  // 转账 moved into 随手记; /transfer is only a redirect and must not render
  // the retired screen (the redirect itself is pinned in the quick-entry tests).
  it('does not render the retired transfer page at /transfer', () => {
    const html = renderAt('/transfer');
    expect(html).not.toContain('<h1>转账</h1>');
    expect(html).not.toContain('transfer-screen');
    expect(html).not.toContain('id="transfer-from"');
  });

  it('renders /add as a sheet over 今天 with no dock', () => {
    const html = renderAt('/add');
    expect(html).toContain('随手记');
    expect(html).toContain('class="entry-sheet"');
    expect(html).toContain('data-entry-close');
    expect(html).toContain('<h1>今天</h1>');
    expect(html).not.toContain('class="dock"');
  });

  it('keeps 设置 as the fourth tab and pushes everything under it', () => {
    // 设置 is a tab now: it keeps the bar.
    const settings = renderAt('/settings');
    expect(settings).toContain('<h1>设置</h1>');
    expect(settings).toContain('备份与恢复');
    expect(settings).toContain('class="dock"');

    // 报表 took 统计's place in the bar: it keeps the bar and has no back link.
    const reports = renderAt('/reports');
    expect(reports).toContain('class="dock"');
    expect(reports).not.toContain('class="add-back"');

    // Its children are pushed pages: no bar, and a way back.
    for (const path of ['/accounts', '/settings/backup', '/settings/storage']) {
      const html = renderAt(path);
      expect(html).not.toContain('class="dock"');
      expect(html).toContain('class="add-back"');
    }
  });
});