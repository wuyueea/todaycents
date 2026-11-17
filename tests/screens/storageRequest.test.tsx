// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StorageScreen from '../../src/screens/StorageScreen';
import type { FolderAccess } from '../../src/storage/folder';

let root: Root;
const empty = { folder: null, needsReselection: false };
const selected = { folder: { name: '合成目录' }, needsReselection: false };
const status = vi.fn<FolderAccess['status']>();
const choose = vi.fn<FolderAccess['choose']>();
const clear = vi.fn<FolderAccess['clear']>();
const folder: FolderAccess = {
  available: async () => true, status, choose, clear, current: async () => null,
  open: async () => false, write: async name => ({ name, saved: false }),
};
function button(label: string) {
  return [...document.querySelectorAll('button')].find(item => item.textContent === label)!;
}
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<MemoryRouter><StorageScreen folder={folder} /></MemoryRouter>); });
}
async function click(label = '选择文件夹') { await act(async () => { button(label).click(); }); }

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  status.mockReset().mockResolvedValue(empty);
  choose.mockReset().mockResolvedValue(false);
  clear.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = ''; vi.useRealTimers();
});

describe('scoped folder selection', () => {
  it('times out a silent picker and allows retry without a late result resuming the UI', async () => {
    let late!: (value: boolean) => void;
    choose.mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    await mount(); await click();
    expect(button('选择文件夹').disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(125000); });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('超时');
    expect(button('选择文件夹').disabled).toBe(false);
    await click();
    expect(choose).toHaveBeenCalledTimes(2);
    await act(async () => { late(true); });
    expect(status).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('未设置');
  });

  it('keeps the previous directory when replacing is canceled', async () => {
    status.mockResolvedValue(selected);
    await mount(); await click('更换文件夹');
    expect(document.body.textContent).toContain('合成目录');
    expect(document.body.textContent).toContain('已取消选择');
    expect(clear).not.toHaveBeenCalled();
  });

  it('refreshes the real grant after a successful choice and after revocation', async () => {
    choose.mockResolvedValue(true);
    await mount();
    status.mockResolvedValue(selected);
    await click();
    expect(document.body.textContent).toContain('已选择「合成目录」');
    status.mockResolvedValue(empty);
    await click('取消目录授权');
    expect(clear).toHaveBeenCalledOnce();
    expect(button('选择文件夹')).toBeDefined();
  });

  it('does not report success if the native choice cannot be read', async () => {
    choose.mockResolvedValue(true);
    await mount(); await click();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('授权不可用');
    expect(document.body.textContent).not.toContain('已选择');
  });

  it('finishes a stalled read after the picker and permits another attempt', async () => {
    choose.mockResolvedValue(true);
    await mount();
    status.mockImplementationOnce(() => new Promise(() => {}));
    await click();
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('读取备份目录超时');
    expect(button('选择文件夹').disabled).toBe(false);
  });
});
