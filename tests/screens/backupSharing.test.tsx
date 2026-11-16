// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BackupScreen from '../../src/screens/BackupScreen';
import { runBackHandlers } from '../../src/components/backButton';
import { readBackupMeta, recordBackupMeta } from '../../src/backup/meta';
import { seedDefaults } from '../../src/db/seed';
import { createTestDb } from '../helpers/nodeDb';
import { failingDb } from '../helpers/failingDb';
import type { Db } from '../../src/db/driver';
import type { CachedBackup } from '../../src/backup/device';

const mocks = vi.hoisted(() => ({
  db: null as Db | null,
  export: vi.fn(),
  list: vi.fn(),
  share: vi.fn(),
}));
vi.mock('../../src/db', () => ({ getDb: () => Promise.resolve(mocks.db) }));
vi.mock('../../src/backup/device', () => ({
  AUTO_BEFORE_CACHE_LIMIT: 10,
  deviceFileWriter: { writeForShare: mocks.export },
  cachedBackups: { list: mocks.list, share: mocks.share },
}));
vi.mock('../../src/storage/folder', () => ({ deviceFolder: { current: async () => null } }));

const previous = { at: '2026-01-01T12:00:00.000Z', rows: 12, bytes: 2048 };
const file: CachedBackup = {
  name: '记账本-20260101-120000-before.ledger',
  uri: 'file:///cache/before.ledger', bytes: 1024, modifiedAt: 1000,
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
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<MemoryRouter><BackupScreen /></MemoryRouter>); });
  await waitFor(() => !button('导出到文件').disabled);
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
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.share.mockReset().mockResolvedValue('shared');
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  mocks.db = null;
  document.body.innerHTML = '';
  expect(runBackHandlers()).toBe(false);
});

describe('backup share confirmation with real metadata', () => {
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
    mocks.export.mockResolvedValue({ kind: 'canceled' });
    await mount();
    await click(button('导出到文件'));
    await waitFor(() => document.body.textContent!.includes('已取消导出'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(await readBackupMeta(db)).toEqual(previous);
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
    expect(mocks.share).toHaveBeenCalledWith(file);
    expect(await readBackupMeta(db)).toEqual(previous);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain(outcome === 'shared' ? '不代表已保存' : '已取消分享');
  });
});
