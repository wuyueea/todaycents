import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import SettingsScreen, { ResetConfirmSheet, StorageRow } from '../../src/screens/SettingsScreen';

// The screen no longer reads the database: every row is a name and a link.
vi.mock('../../src/store/useDb', () => ({
  useDb: () => ({ db: { fake: true }, revision: 0, bump: () => {}, error: null }),
}));

function renderSettings(state?: unknown): string {
  return renderToString(
    <MemoryRouter
      initialEntries={[
        state === undefined ? { pathname: '/settings' } : { pathname: '/settings', state },
      ]}
    >
      <SettingsScreen />
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

function render(node: React.ReactElement): string {
  return renderToString(node).replace(/<!-- -->/g, '');
}

const RESET_COUNTS = { txn: 5, account: 7, category: 13, tag: 2, project: 2 };

describe('SettingsScreen', () => {
  it('lists every page by name alone, with no line underneath', () => {
    const html = renderSettings();

    expect(html).toContain('<h1>设置</h1>');
    for (const name of ['账户', '分类', '标签', '项目', '固定支出', '存储', '备份与恢复', '清除所有数据']) {
      expect(html).toContain(`>${name}<`);
    }
    // The meta lines (counts, last backup time) are gone for good.
    expect(html).not.toContain('settings-row__meta');
    expect(html).not.toContain('还没有备份');
    expect(html).not.toContain('个标签');
    expect(html).not.toContain('上次备份');
  });

  it('keeps the three groups and their links, in order', () => {
    const html = renderSettings();

    // The three groups, and which page opens each one.
    for (const [group, firstLink] of [
      ['结构', 'href="/accounts"'],
      ['账本', 'href="/settings/projects"'],
      ['数据', 'href="/settings/storage"'],
    ] as const) {
      expect(html.indexOf(group)).toBeLessThan(html.indexOf(firstLink));
    }

    // 结构: 账户 · 分类 · 标签
    expect(html.indexOf('href="/accounts"')).toBeLessThan(
      html.indexOf('href="/settings/categories"')
    );
    expect(html.indexOf('href="/settings/categories"')).toBeLessThan(
      html.indexOf('href="/settings/tags"')
    );

    // 账本: 项目 · 固定支出
    expect(html.indexOf('href="/settings/projects"')).toBeLessThan(
      html.indexOf('href="/settings/fixed"')
    );

    // 数据: 存储 · 备份与恢复 · 清除所有数据
    expect(html.indexOf('href="/settings/storage"')).toBeLessThan(
      html.indexOf('href="/settings/backup"')
    );
    expect(html.indexOf('href="/settings/backup"')).toBeLessThan(
      html.indexOf('settings-row--danger')
    );

    // 备份与恢复 moved out of 账本: it is below the 数据 heading now.
    expect(html.indexOf('数据')).toBeLessThan(html.indexOf('href="/settings/backup"'));
  });

  it('has no back chevron and no report row: it is a tab, 报表 is another', () => {
    const html = renderSettings();

    expect(html).not.toContain('class="add-back"');
    expect(html).not.toContain('href="/settings/reports"');
    expect(html).not.toContain('分析');
  });
  it('shows the import success toast handed over by the backup screen', () => {
    const html = renderSettings({
      imported: { fileName: '记账本-20261020-2214.ledger', rows: 231 },
    });

    expect(html).toContain('已导入「记账本-20261020-2214.ledger」 · 231 笔');
    expect(html).toMatch(/class="toast"[^>]*role="status"/);
  });

  it('ignores a malformed router state instead of printing it', () => {
    const html = renderSettings({ imported: { fileName: 42, rows: '231' } });

    expect(html).not.toContain('已导入');
    expect(html).not.toContain('class="toast"');
  });
});
describe('数据 group', () => {
  it('holds 存储 above 清除所有数据, and both are names only', () => {
    const html = renderSettings();

    expect(html).toContain('数据');
    expect(html).toContain('href="/settings/storage"');
    expect(html).toContain('清除所有数据');

    // 存储 first, the destructive row last.
    expect(html.indexOf('href="/settings/storage"')).toBeLessThan(
      html.indexOf('清除所有数据')
    );
    // The group is below 结构 and 账本, and carries no second lines.
    expect(html.indexOf('数据')).toBeGreaterThan(html.indexOf('href="/settings/categories"'));
    expect(html.indexOf('数据')).toBeGreaterThan(html.indexOf('href="/settings/projects"'));
    expect(html).not.toContain('settings-row__value');
    expect(html).not.toContain('默认（应用缓存）');
  });

  it('keeps the 存储 row a plain name, with no location underneath', () => {
    const html = render(
      <MemoryRouter>
        <StorageRow />
      </MemoryRouter>
    ).replace(/<!-- -->/g, '');

    expect(html).toContain('href="/settings/storage"');
    expect(html).toContain('>存储<');
    expect(html).not.toContain('settings-row__value');
  });

  it('keeps 清除所有数据 a button in danger text, not a link', () => {
    const html = renderSettings();

    expect(html).toContain('settings-row--danger');
    const row = html.match(/<button[^>]*class="settings-row settings-row--danger"[^>]*>/)?.[0] ?? '';
    expect(row).toContain('type="button"');
    expect(row).not.toContain('href');
  });

  it('still renders the row with no database, because the screen reads nothing', () => {
    const html = renderSettings();

    expect(html).toContain('清除所有数据');
    expect(html).toContain('settings-row--danger');
    // No query means no loading line either: the page is a list of links.
    expect(html).not.toContain('数据层未就绪');
  });
});

describe('ResetConfirmSheet', () => {
  it('states the real counts, what survives and the automatic backup', () => {
    const html = render(
      <ResetConfirmSheet counts={RESET_COUNTS} busy={false} onConfirm={() => {}} onCancel={() => {}} />
    );

    expect(html).toContain('清除所有数据');
    expect(html).toContain('将删除 5 笔流水、7 个账户、13 个分类、2 个标签、2 个项目。');
    // The starter set survives, exactly as a first launch writes it.
    expect(html).toContain('只留下 3 个账户和 12 个分类');
    expect(html).toContain('不能撤销');
    // And a backup is written before anything is deleted.
    expect(html).toContain('会先把现在的账本写成一份备份文件，再清除');

    expect(html).toContain('确认清除');
    expect(html).toContain('取消');
    expect(html).toContain('sheet__danger');
    expect(html).toContain('sheet__secondary');
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
  });

  it('makes the scrim a cancel, so only the danger button can go forward', () => {
    const html = render(
      <ResetConfirmSheet counts={RESET_COUNTS} busy={false} onConfirm={() => {}} onCancel={() => {}} />
    );

    // A plain div: tapping it can only reach onCancel, never onConfirm.
    expect(html).toContain('<div class="sheet__scrim" aria-hidden="true"></div>');
    // Exactly two buttons, and exactly one danger action.
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html.match(/sheet__danger/g)).toHaveLength(1);
  });

  it('disables both buttons while the wipe is running', () => {
    const html = render(
      <ResetConfirmSheet counts={RESET_COUNTS} busy onConfirm={() => {}} onCancel={() => {}} />
    );

    expect(html.match(/<button[^>]*disabled/g)).toHaveLength(2);
  });
});