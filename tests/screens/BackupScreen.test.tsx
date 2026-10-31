import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import BackupScreen, {
  ImportConfirmSheet,
  ImportFailureSheet,
} from '../../src/screens/BackupScreen';
import type { BackupScreenData } from '../../src/screens/BackupScreen';
import { BackupSchemaTooNewError } from '../../src/db/backup';
import { importFailureCopy } from '../../src/backup/format';

const store = vi.hoisted(() => ({
  data: null as BackupScreenData | null,
  error: null as Error | null,
}));

vi.mock('../../src/store/useDb', () => ({
  useDb: () => ({ db: { fake: true }, revision: 0, bump: () => {}, error: null }),
  useQuery: () => ({
    data: store.data,
    loading: store.data === null,
    error: store.error,
  }),
}));

const NOW = new Date(2026, 9, 23, 22, 14);
// The screen reads the real clock, so this fixture must be relative to today:
// a fixed 2026-10-22 stops reading as "yesterday" the moment the suite runs on
// any later day. Subtracting from the current local date keeps the assertion
// about the copy (昨天), not about the calendar day the test happens to run.
const YESTERDAY = (() => {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  date.setHours(22, 14, 0, 0);
  return date;
})();
const META = { at: YESTERDAY.toISOString(), rows: 231, bytes: 46 * 1024 };

function renderScreen(): string {
  return renderToString(
    <MemoryRouter initialEntries={['/settings/backup']}>
      <BackupScreen />
    </MemoryRouter>
  ).replace(/<!-- -->/g, '');
}

function render(node: React.ReactElement): string {
  return renderToString(node).replace(/<!-- -->/g, '');
}

const confirmProps = {
  fileName: '记账本-20261020-2214.ledger',
  schemaVersion: 1,
  fileRows: 231,
  fileBytes: 46 * 1024,
  localRows: 12,
  // Build the fixture in local time: the sheet renders local time, so a fixed
  // +08:00 string changes to 14:14 when CI runs in UTC.
  exportedAt: new Date(2026, 9, 20, 22, 14).toISOString(),
  now: NOW,
  busy: false,
  onConfirm: () => {},
  onCancel: () => {},
};

describe('BackupScreen', () => {
  it('leads with the last backup and the two actions', () => {
    store.data = { meta: META, localRows: 231 };
    const html = renderScreen();

    expect(html).toContain('<h1>备份与恢复</h1>');
    expect(html).toContain('上次备份');
    expect(html).toContain('昨天 22:14');
    expect(html).toContain('231 笔流水 · 46 KB');
    expect(html).toContain('导出到文件');
    expect(html).toContain('从文件导入');
    expect(html).toContain('backup-button--primary');
    expect(html).toContain('backup-button--secondary');
  });

  it('still says what to do when no backup exists yet', () => {
    store.data = { meta: null, localRows: 0 };
    const html = renderScreen();

    expect(html).toContain('还没有备份');
    expect(html).not.toContain('笔流水 ·');
    expect(html).toContain('导出到文件');
  });

  it('has a hidden file picker that accepts the ledger, json and text', () => {
    store.data = { meta: null, localRows: 0 };
    const html = renderScreen();

    expect(html).toMatch(/<input[^>]*type="file"/);
    expect(html).toMatch(/<input[^>]*hidden/);
    expect(html).toContain('.ledger');
    expect(html).toContain('.json');
    expect(html).toContain('text/plain');
  });

  it('drops the offline paragraph but still links back to settings', () => {
    store.data = { meta: META, localRows: 231 };
    const html = renderScreen();

    // The promise used to be a paragraph; the buttons are self-explanatory now.
    expect(html).not.toContain('文件不会上传到任何服务器');
    const back = html.match(/<a[^>]*class="add-back"[^>]*>/)?.[0] ?? '';
    expect(back).toContain('href="/settings"');
    expect(back).toContain('aria-label="返回设置"');
  });
});

describe('ImportConfirmSheet', () => {
  it('states file rows, local rows and the whole-ledger replacement', () => {
    const html = render(<ImportConfirmSheet {...confirmProps} />);

    expect(html).toContain('从文件导入');
    expect(html).toContain('版本 1');
    expect(html).toContain('记账本-20261020-2214.ledger');
    expect(html).toContain('231 笔 · 46 KB');
    expect(html).toContain('10月20日 22:14');
    expect(html).toContain('本机现在有 12 笔');
    expect(html).toContain('会整体替换');
    expect(html).toContain('当前的记录不保留，也不能撤销');
    expect(html).toContain('会先把现在的账本导出成一份备份');
    expect(html).toContain('覆盖并导入');
    expect(html).toContain('取消');
    expect(html).toContain('sheet__danger');
    expect(html).toMatch(/role="dialog"/);
  });
});

describe('ImportFailureSheet', () => {
  it('shows 导入失败, the reason and the untouched-data promise', () => {
    const html = render(
      <ImportFailureSheet
        copy={importFailureCopy(new Error('备份文件的 tables 缺少数据表：tag。'))}
        fileName="broken.ledger"
        fileMeta="231 笔 · 46 KB"
        onClose={() => {}}
      />
    );

    expect(html).toContain('导入失败');
    expect(html).toContain('broken.ledger');
    expect(html).toContain('tables 缺少数据表');
    expect(html).toContain('本机的账一笔没动。');
    expect(html).toContain('知道了');
  });

  it('uses the plan copy verbatim and points at the App upgrade for a newer schema', () => {
    const html = render(
      <ImportFailureSheet
        copy={importFailureCopy(new BackupSchemaTooNewError(99, 1))}
        fileName="future.ledger"
        onClose={() => {}}
      />
    );

    expect(html).toContain('导入失败');
    expect(html).toContain(
      '升级 App 之后再导入，或者用导出它的那台设备重新导一份。本机的账一笔没动。'
    );
    expect(html).toContain('schemaVersion 99');
  });
});
