// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StorageScreen from '../../src/screens/StorageScreen';
import type { FolderAccess, StorageAccessState } from '../../src/storage/folder';

let root: Root | null = null;
let granted = false;
const getAccess = vi.fn<() => Promise<StorageAccessState>>();
const requestAccess = vi.fn<() => Promise<StorageAccessState>>();
const current = vi.fn<FolderAccess['current']>();
const folder: FolderAccess = {
  available: async () => true, getAccess, requestAccess, current,
  list: async () => ({ path: '', parent: null, dirs: [] }), choose: async () => null,
  clear: async () => {}, open: async () => false, write: async name => ({ name, saved: false }),
};
async function mount() {
  const host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<MemoryRouter><StorageScreen folder={folder} /></MemoryRouter>); });
}
function button() { return [...document.querySelectorAll('button')].find(item => item.textContent?.includes('允许访问存储'))!; }
async function click() { await act(async () => { button().click(); }); }

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); granted = false;
  getAccess.mockReset().mockImplementation(async () => ({ granted, reason: 'settings' }));
  requestAccess.mockReset().mockResolvedValue({ granted: false, reason: 'settings' });
  current.mockReset().mockResolvedValue(null);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; document.body.innerHTML = ''; vi.useRealTimers();
});

describe('storage permission request never stays busy forever', () => {
  it('times out a silent native request, re-enables the button and can retry', async () => {
    let late!: (value: StorageAccessState) => void;
    requestAccess.mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    await mount(); await click();
    expect(button().disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(125000); });
    expect(button().disabled).toBe(false);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('超时');
    await click();
    expect(requestAccess).toHaveBeenCalledTimes(2);
    expect(button().disabled).toBe(false);
    expect(document.body.textContent).toContain('还没有允许访问存储');
    await act(async () => { late({ granted: true }); });
    expect(document.body.textContent).toContain('还没有允许访问存储');
    expect(document.body.textContent).not.toContain('当前位置');
  });

  it('times out a read before opening settings and allows retry', async () => {
    await mount();
    getAccess.mockImplementationOnce(() => new Promise(() => {}));
    await click();
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(button().disabled).toBe(false);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('读取存储权限超时');
    expect(requestAccess).not.toHaveBeenCalled();
    await click();
    expect(requestAccess).toHaveBeenCalledTimes(1);
  });

  it('does not trust the system-return payload as proof that access was granted', async () => {
    requestAccess.mockResolvedValue({ granted: true });
    await mount(); await click();
    expect(getAccess).toHaveBeenCalledTimes(3); // mount, pre-check, fresh read
    expect(document.body.textContent).toContain('还没有允许访问存储');
    expect(button().disabled).toBe(false);
  });

  it('finishes busy if reading the folder stalls after permission was granted', async () => {
    await mount();
    requestAccess.mockImplementation(async () => { granted = true; return { granted: true }; });
    current.mockImplementation(() => new Promise(() => {}));
    await click();
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('读取存储目录超时');
    const change = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('更改位置'));
    expect(change).toBeDefined();
    expect(change!.disabled).toBe(false);
  });
});
