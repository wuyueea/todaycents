// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BackupScreen from '../../src/screens/BackupScreen';
import SettingsScreen from '../../src/screens/SettingsScreen';
import { runBackHandlers } from '../../src/components/backButton';
import { readBackupMeta, recordBackupMeta } from '../../src/backup/meta';
import { buildBackup, serializeBackup } from '../../src/db/backup';
import { listAccounts } from '../../src/db/repos/accounts';
import { recordAdjustment } from '../../src/db/repos/txns';
import { seedDefaults } from '../../src/db/seed';
import { createTestDb } from '../helpers/nodeDb';
import { failingDb } from '../helpers/failingDb';
import type { Db } from '../../src/db/driver';
import type { CachedBackup } from '../../src/backup/device';

const mocks = vi.hoisted(() => ({
  db: null as Db | null,
  export: vi.fn(),
  writeCopy: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  share: vi.fn(),
  openFolder: vi.fn(),
}));
vi.mock('../../src/db', () => ({ getDb: () => Promise.resolve(mocks.db) }));
vi.mock('../../src/backup/device', () => ({
  AUTO_BEFORE_CACHE_LIMIT: 10,
  deviceFileWriter: { writeForShare: mocks.export, writeCopy: mocks.writeCopy },
  cachedBackups: { list: mocks.list, read: mocks.read, share: mocks.share },
}));
vi.mock('../../src/storage/folder', () => ({
  deviceFolder: { current: async () => null, open: mocks.openFolder },
}));

const previous = { at: '2026-01-01T12:00:00.000Z', rows: 12, bytes: 2048 };
const file: CachedBackup = {
  name: '记账本-20260101-120000-before.ledger',
  uri: 'file:///cache/before.ledger', bytes: 1024, modifiedAt: 1000,
};
const newCopy: CachedBackup = {
  ...file,
  name: '记账本-20260101-120000-before (2).ledger',
  uri: 'file:///cache/before-2.ledger',
  modifiedAt: 2000,
};
let root: Root | null = null;
let db: Db;

async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 60; i++) {
    if (check()) return;
    await flush();
  }
  throw new Error('未等到备份页面更新');
}
async function mount(path = '/settings/backup') {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/backup" element={<BackupScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
        </Routes>
      </MemoryRouter>
    );
  });
  if (path === '/settings/backup') await waitFor(() => !button('导出到文件').disabled);
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
  if (!found) throw new Error(`找不到按钮：${text}`);
  return found;
}
async function click(element: Element) {
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
}
async function exportToShare() {
  await click(button('导出到文件'));
  await waitFor(() => document.querySelector('#export-confirm-title') !== null);
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  db = await createTestDb();
  await seedDefaults(db);
  await recordBackupMeta(db, previous);
  mocks.db = db;
  mocks.export.mockReset().mockResolvedValue({ kind: 'share' });
  mocks.writeCopy.mockReset().mockResolvedValue({
    kind: 'cache', fileName: newCopy.name, uri: newCopy.uri,
  });
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.read.mockReset();
  mocks.share.mockReset().mockResolvedValue('shared');
  mocks.openFolder.mockReset().mockResolvedValue(true);
});

describe('restore directly from the app cache', () => {
  async function putAdjustment(note: string) {
    const [account] = await listAccounts(db);
    await recordAdjustment(db, {
      date: '2026-01-01', accountId: account!.id, deltaCents: 500, note,
    });
  }

  const notes = async () => (await db.all<{ note: string }>('SELECT note FROM txn ORDER BY note'))
    .map(row => row.note);

  async function viewNewCopy() {
    const link = [...document.querySelectorAll('a')].find(item => item.textContent === '查看自动副本');
    expect(link).toBeDefined();
    await click(link!);
    await waitFor(() => document.activeElement?.classList.contains('backup-cache__row') === true);
    expect(document.activeElement!.textContent).toContain(newCopy.name);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  }

  it('requires confirmation and then restores a cache file, with a link to the actual new copy', async () => {
    await putAdjustment('旧账');
    mocks.read.mockResolvedValue(serializeBackup(await buildBackup(db)));
    await putAdjustment('新账');
    mocks.list.mockResolvedValue([file]);
    await mount();
    await click(button('恢复'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('从缓存恢复');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(file.name);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('流水日期 · 2026-01-01');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('未归档账户 · 3 个');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('本机现在有 2 行流水记录，备份文件有 1 行流水记录。');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('已删除的流水也计入。');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('整体替换');
    expect(mocks.read).toHaveBeenCalledWith(file.name);
    expect(mocks.writeCopy).not.toHaveBeenCalled();
    await click(button('取消'));
    expect(await notes()).toHaveLength(2);

    await click(button('恢复'));
    mocks.list.mockResolvedValue([newCopy, file]);
    await click(button('覆盖并恢复'));
    await waitFor(() => document.body.textContent!.includes('查看自动副本'));
    expect(await notes()).toEqual(['旧账']);
    expect(mocks.share).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.writeCopy.mock.calls[0]![1]).counts.txn).toBe(2);
    await viewNewCopy();
  });

  it('shows why a cache backup is unusable and leaves actions available for an intact file', async () => {
    const broken = { ...newCopy, unavailableReason: '备份文件不是有效的 JSON，无法解析。' };
    mocks.list.mockResolvedValue([broken, file]);
    await mount();

    const rows = [...document.querySelectorAll('.backup-cache__row')];
    const brokenRow = rows.find(row => row.textContent?.includes(broken.name))!;
    expect(brokenRow.textContent).toContain('无法使用 · 备份文件不是有效的 JSON');
    expect(brokenRow.querySelectorAll('button')).toHaveLength(0);
    expect(document.querySelectorAll('.backup-cache__row button')).toHaveLength(2);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.writeCopy).not.toHaveBeenCalled();
    await click(button('另存'));
    expect(mocks.share).toHaveBeenCalledExactlyOnceWith(file.name);
  });

  it.each([
    ['missing', null, '备份已不在应用缓存中'],
    ['malformed', '{', 'JSON'],
  ])('blocks a %s cache backup before opening the overwrite confirmation', async (_, contents, reason) => {
    await putAdjustment('应保留');
    mocks.list.mockResolvedValue([file]);
    if (contents === null) mocks.read.mockRejectedValue(new Error(reason));
    else mocks.read.mockResolvedValue(contents);
    await mount();
    await click(button('恢复'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('导入失败');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(reason);
    expect(document.body.textContent).not.toContain('覆盖并恢复');
    expect(mocks.writeCopy).not.toHaveBeenCalled();
    expect(await notes()).toEqual(['应保留']);
  });

  it('keeps the current ledger when the cached restore rolls back after writing the before-copy', async () => {
    const invalid = await buildBackup(db);
    invalid.counts.txn += 1;
    mocks.read.mockResolvedValue(serializeBackup(invalid));
    mocks.list.mockResolvedValue([file]);
    await putAdjustment('应保留');
    await mount();
    await click(button('恢复'));
    await click(button('覆盖并恢复'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('导入失败');
    expect(mocks.writeCopy).toHaveBeenCalledTimes(1);
    expect(await notes()).toEqual(['应保留']);
  });

  it('links to the automatic copy after a successful reset', async () => {
    await putAdjustment('清除前流水');
    mocks.list.mockResolvedValue([newCopy]);
    await mount('/settings');
    await click(button('清除所有数据'));
    await waitFor(() => document.querySelector('#reset-confirm-title') !== null);
    await click(button('确认清除'));
    await waitFor(() => document.body.textContent!.includes('查看自动副本'));
    expect(await notes()).toEqual([]);
    expect(JSON.parse(mocks.writeCopy.mock.calls[0]![1]).counts.txn).toBe(1);
    await viewNewCopy();
  });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  mocks.db = null;
  document.body.innerHTML = '';
  expect(runBackHandlers()).toBe(false);
});

describe('backup share confirmation with real metadata', () => {
  it('opens the folder from the written result and retains a way to find the file if opening fails', async () => {
    mocks.export.mockResolvedValue({
      kind: 'folder', folderName: '合成备份', folderId: 'written-tree', fileName: '本次备份 (2).ledger',
    });
    mocks.openFolder.mockResolvedValue(false);
    await mount();
    await click(button('导出到文件'));
    await waitFor(() => document.querySelector('[aria-label="导出结果"]') !== null);

    const result = document.querySelector('[aria-label="导出结果"]')!;
    expect(button('导出到文件').nextElementSibling).toBe(result);
    expect(result.textContent).toContain('合成备份');
    expect(result.textContent).toContain('本次备份 (2).ledger');
    await click(button('打开文件夹'));
    expect(mocks.openFolder).toHaveBeenCalledWith('written-tree');
    expect(result.textContent).toContain('请在文件管理器中到「合成备份」查找上方文件');
    expect(result.textContent).toContain('本次备份 (2).ledger');
  });

  it('keeps the previous record until the user confirms, with no claim of a save receipt', async () => {
    await mount();
    await exportToShare();
    expect(await readBackupMeta(db)).toEqual(previous);
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('无法确认目标应用是否已保存');
    await click(button('已保存，记下这次备份'));
    await waitFor(() => document.querySelector('[role="dialog"]') === null);
    const recorded = await readBackupMeta(db);
    expect(recorded).not.toEqual(previous);
    expect(recorded?.rows).toBe(0);
    expect(recorded!.bytes).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('已按你的确认记下这次备份');
  });

  it.each(['没有保存', '遮罩', '返回键'])('%s closes without recording a backup', async how => {
    await mount();
    await exportToShare();
    if (how === '没有保存') await click(button('没有保存'));
    else if (how === '遮罩') await click(document.querySelector('.sheet__scrim')!);
    else {
      await act(async () => { expect(runBackHandlers()).toBe(true); });
      await flush();
    }
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(await readBackupMeta(db)).toEqual(previous);
    expect(document.body.textContent).toContain('没有记录这次备份');
  });

  it('a canceled native share never opens confirmation or updates metadata', async () => {
    mocks.export.mockResolvedValue({ kind: 'canceled', fileName: newCopy.name });
    mocks.list.mockResolvedValue([file, newCopy]);
    await mount();
    await click(button('导出到文件'));
    await waitFor(() => document.body.textContent!.includes('已取消导出'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(await readBackupMeta(db)).toEqual(previous);
    const result = document.querySelector('[aria-label="导出结果"]')!;
    expect(result.textContent).toContain(newCopy.name);
    await click(button('查看缓存文件'));
    expect(document.activeElement?.querySelector('.backup-cache__name')?.textContent).toBe(newCopy.name);
    expect(document.activeElement?.querySelector('.backup-cache__share')?.textContent).toBe('另存');

    mocks.list.mockResolvedValue([file]);
    await click(button('查看缓存文件'));
    expect(result.textContent).toContain(`暂时无法查看「${newCopy.name}」`);
    expect(result.querySelector('button')).toBeNull();
  });

  it('keeps the old record when recording the user confirmation fails', async () => {
    mocks.db = failingDb(db, sql => /INSERT.*app_meta/is.test(sql), 'disk full');
    await mount();
    await exportToShare();
    await click(button('已保存，记下这次备份'));
    await waitFor(() => document.querySelector('[role="alert"]') !== null);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('没能记下这次备份');
    expect(await readBackupMeta(db)).toEqual(previous);
  });

  it.each(['shared', 'canceled'])('cached 另存 (%s) never updates last-backup metadata', async outcome => {
    mocks.list.mockResolvedValue([file]);
    mocks.share.mockResolvedValue(outcome);
    await mount();
    await waitFor(() => document.querySelector('.backup-cache__share') !== null);
    await click(button('另存'));
    await waitFor(() => mocks.share.mock.calls.length === 1);
    expect(mocks.share).toHaveBeenCalledWith(file.name);
    expect(await readBackupMeta(db)).toEqual(previous);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain(outcome === 'shared' ? '不代表已保存' : '已取消分享');
  });
});
