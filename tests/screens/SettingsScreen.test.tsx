import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import SettingsScreen, { ResetConfirmSheet, StorageRow } from '../../src/screens/SettingsScreen';

// Every row is a name and a link; the fixed-cost row is the one exception,
// because a waiting candidate must not depend on the owner opening the page.
const pendingFixedCosts = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../src/store/useDb', () => ({
  useDb: () => ({ db: { fake: true }, revision: 0, bump: () => {}, error: null }),
  useQuery: () => ({ data: pendingFixedCosts.count, loading: false, error: null }),
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

  it('shows how many fixed-cost candidates are waiting', () => {
    pendingFixedCosts.count = 2;

    const html = renderSettings();
    const row =
      html.match(/<a[^>]*href="\/settings\/fixed"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';

    expect(row).toContain('固定支出');
    expect(row).toContain('2 条待确认');
    pendingFixedCosts.count = 0;
  });

  it('keeps the fixed-cost row plain when nothing is waiting', () => {
    const html = renderSettings();

    expect(html).not.toContain('条待确认');
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

  it('warns when the automatic before-copy fell back to the app cache', () => {
    const html = renderSettings({
      imported: {
        fileName: 'x.ledger',
        rows: 231,
        beforeDestination: { kind: 'cache' },
      },
    });

    expect(html).toContain('导入前的备份在应用缓存，系统可能清理');
  });

  it('does not repeat a folder the confirmation already promised', () => {
    const html = renderSettings({
      imported: {
        fileName: 'x.ledger',
        rows: 231,
        beforeDestination: { kind: 'folder', folderName: 'Books' },
      },
    });

    expect(html).toContain('已导入「x.ledger」 · 231 笔');
    expect(html).not.toContain('导入前的备份');
  });

  it('ignores an unreadable before-copy location', () => {
    const html = renderSettings({
      imported: {
        fileName: 'x.ledger',
        rows: 231,
        beforeDestination: { kind: 'folder', folderName: 42 },
      },
    });

    expect(html).toContain('已导入「x.ledger」 · 231 笔');
    expect(html).not.toContain('导入前的备份');
  });

  it('names the repaired project links the backup screen handed over', () => {
    const html = renderSettings({
      imported: {
        fileName: '记账本-20261020-2214.ledger',
        rows: 231,
        clearedProjectRefs: 2,
      },
    });

    expect(html).toContain('231 笔；2 笔流水的项目在文件里找不到，已清空');
  });

  it('treats a nonsense repaired count as nothing repaired', () => {
    for (const bad of ['2', -1, 2.5, Number.NaN]) {
      const html = renderSettings({
        imported: { fileName: 'x.ledger', rows: 231, clearedProjectRefs: bad },
      });
      expect(html).toContain('已导入「x.ledger」 · 231 笔');
      expect(html).not.toContain('项目在文件里找不到');
    }
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
  it('states the real counts, what survives and where the automatic backup goes', () => {
    const html = render(
      <ResetConfirmSheet
        counts={RESET_COUNTS}
        folderName="Books"
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain('清除所有数据');
    expect(html).toContain('将删除 5 笔流水、7 个账户、13 个分类、2 个标签、2 个项目。');
    // The starter set survives, exactly as a first launch writes it.
    expect(html).toContain('只留下 3 个账户和 12 个分类');
    expect(html).toContain('不能撤销');
    // And a backup is written before anything is deleted, into the chosen folder.
    expect(html).toContain('会先把现在的账本写成一份备份文件，再清除');
    expect(html).toContain('这一份会存到「Books」文件夹。');

    expect(html).toContain('确认清除');
    expect(html).toContain('取消');
    expect(html).toContain('sheet__danger');
    expect(html).toContain('sheet__secondary');
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
  });

  it('warns when the automatic backup can only go to the app cache', () => {
    const html = render(
      <ResetConfirmSheet
        counts={RESET_COUNTS}
        folderName={null}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain('只会放进应用缓存，系统可能清理');
    expect(html).not.toContain('这一份会存到');
  });

  it('makes the scrim a cancel, so only the danger button can go forward', () => {
    const html = render(
      <ResetConfirmSheet
        counts={RESET_COUNTS}
        folderName="Books"
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    // A plain div: tapping it can only reach onCancel, never onConfirm.
    expect(html).toContain('<div class="sheet__scrim" aria-hidden="true"></div>');
    // Exactly two buttons, and exactly one danger action.
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html.match(/sheet__danger/g)).toHaveLength(1);
  });

  it('disables both buttons while the wipe is running', () => {
    const html = render(
      <ResetConfirmSheet
        counts={RESET_COUNTS}
        folderName="Books"
        busy
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html.match(/<button[^>]*disabled/g)).toHaveLength(2);
  });
});