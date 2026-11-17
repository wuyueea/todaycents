// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportsScreen from '../../src/screens/ReportsScreen';
import type { Db } from '../../src/db/driver';
import { createTestDb } from '../helpers/nodeDb';
import { seedDefaults } from '../../src/db/seed';
import { readBackupMeta, recordBackupMeta } from '../../src/backup/meta';

const mocks = vi.hoisted(() => ({
  db: null as Db | null,
  write: vi.fn(),
  list: vi.fn(),
  share: vi.fn(),
}));
vi.mock('../../src/db', () => ({ getDb: () => Promise.resolve(mocks.db) }));
vi.mock('../../src/backup/device', () => ({
  deviceBinaryFileWriter: { writeForShare: mocks.write },
  cachedReports: { list: mocks.list, share: mocks.share },
}));

const name = '记账本-2026 (2).xlsx';
const file = { name, uri: `file:///cache/${name}`, bytes: 128, modifiedAt: 1000 };
const backupMeta = { at: '2026-01-01T00:00:00.000Z', rows: 1, bytes: 128 };
let root: Root | null = null;
let db: Db;

function button(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  throw new Error('未等到报表页面更新');
}

async function mount() {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root!.render(<MemoryRouter><ReportsScreen /></MemoryRouter>));
  await waitFor(() => button('导出这个月为表格（.xlsx）')?.disabled === false);
}

async function click(text: string) {
  const control = button(text);
  if (!control) throw new Error(`找不到按钮：${text}`);
  await act(async () => control.click());
}

const status = () => document.querySelector('.reports-note[role="status"]');
const alert = () => document.querySelector('.reports-note[role="alert"]');

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  db = await createTestDb();
  await seedDefaults(db);
  await recordBackupMeta(db, backupMeta);
  mocks.db = db;
  mocks.write.mockReset().mockResolvedValue({ kind: 'canceled', fileName: name });
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.share.mockReset().mockResolvedValue('shared');
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe('report cache and share feedback', () => {
  it('shows canceled export as a status and offers the actual cached report for reshare', async () => {
    mocks.list.mockResolvedValueOnce([]).mockResolvedValue([file]);
    await mount();
    expect(button('另存')).toBeUndefined();
    await click('导出这个月为表格（.xlsx）');
    await waitFor(() => button('另存') !== undefined);
    expect(status()?.textContent).toContain(`已取消分享「${name}」`);
    expect(alert()).toBeNull();
    expect(button('另存')?.getAttribute('aria-label')).toBe(`另存 ${name}`);
    await click('另存');
    expect(mocks.share).toHaveBeenCalledExactlyOnceWith(name);
    expect(status()?.textContent).toContain('请在目标应用确认是否保存');
    expect(await readBackupMeta(db)).toEqual(backupMeta);
  });

  it('can recover a report on reentry and removes an evicted file after reshare fails', async () => {
    mocks.list.mockResolvedValueOnce([file]).mockResolvedValue([]);
    mocks.share.mockRejectedValue(new Error('报表已不在应用缓存中。'));
    await mount();
    await waitFor(() => button('另存') !== undefined);
    await click('另存');
    await waitFor(() => button('另存') === undefined);
    expect(alert()?.textContent).toContain('另存失败：报表已不在应用缓存中');
  });

  it('uses the error style for a real export failure and refreshes the cache', async () => {
    mocks.write.mockRejectedValue(new Error('系统分享暂不可用'));
    mocks.list.mockResolvedValueOnce([]).mockResolvedValue([file]);
    await mount();
    await click('导出这个月为表格（.xlsx）');
    await waitFor(() => button('另存') !== undefined);
    expect(alert()?.classList.contains('reports-note--error')).toBe(true);
    expect(alert()?.textContent).toContain('系统分享暂不可用');
    expect(await readBackupMeta(db)).toEqual(backupMeta);
  });
});
