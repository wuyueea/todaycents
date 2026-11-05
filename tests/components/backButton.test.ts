import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  backDestination,
  createBackHandler,
  EXIT_WINDOW_MS,
  installBackHandler,
  isTabPath,
  registerBackHandler,
  runBackHandlers,
} from '../../src/components/backButton';

/**
 * The back key is a stack: whichever sheet opened last gets the press first,
 * then a pushed page walks to its parent — never through the tab history.
 * On a tab the first press only warns; the second one lets Android close.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  vi.unstubAllGlobals();
});

function register(handler: () => boolean): () => void {
  const release = registerBackHandler(handler);
  cleanups.push(release);
  return release;
}

function newBack(pathname = '/', state: unknown = null) {
  let now = 1_000;
  let currentPath = pathname;
  let currentState = state;
  let currentKey = 'nav-0';
  let navigations = 0;
  const navigate = vi.fn();
  const historyBack = vi.fn();
  const onExitPrompt = vi.fn();
  const back = createBackHandler({
    navigate,
    historyBack,
    current: () => ({ pathname: currentPath, state: currentState, key: currentKey }),
    onExitPrompt,
    now: () => now,
  });

  return {
    back,
    navigate,
    historyBack,
    onExitPrompt,
    tick(ms: number) {
      now += ms;
    },
    moveTo(path: string, nextState: unknown = null) {
      currentPath = path;
      currentState = nextState;
      navigations += 1;
      currentKey = `nav-${navigations}`;
    },
  };
}

describe('sheet stack', () => {
  it('offers the press to the newest handler first', () => {
    const order: string[] = [];
    register(() => {
      order.push('older');
      return true;
    });
    register(() => {
      order.push('newer');
      return true;
    });

    expect(runBackHandlers()).toBe(true);
    expect(order).toEqual(['newer']);
  });

  it('falls through to an older handler when the newest declines', () => {
    const older = vi.fn(() => true);
    const newer = vi.fn(() => false);
    register(older);
    register(newer);

    expect(runBackHandlers()).toBe(true);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).toHaveBeenCalledTimes(1);
  });

  it('stops calling a handler after it is released', () => {
    const released = vi.fn(() => true);
    const release = register(released);
    release();
    cleanups.pop();

    expect(runBackHandlers()).toBe(false);
    expect(released).not.toHaveBeenCalled();
  });
});

describe('back destinations', () => {
  it('treats only the four dock tabs as roots', () => {
    for (const path of ['/', '/ledger', '/reports', '/settings']) {
      expect(isTabPath(path)).toBe(true);
      expect(backDestination(path, null)).toBeNull();
    }
    expect(isTabPath('/ledger/')).toBe(true);
    expect(isTabPath('/settings/backup')).toBe(false);
    expect(isTabPath('/accounts')).toBe(false);
  });

  it('sends 账户 to 设置, not to whatever history entry came before', () => {
    expect(backDestination('/accounts', null)).toEqual({ kind: 'path', path: '/settings' });
  });

  it('keeps the 随手记 draft when 账户 is a detour from it', () => {
    expect(backDestination('/accounts', { quickEntryOpen: true })).toEqual({ kind: 'history' });
  });

  it('closes 随手记 onto the tab it covered', () => {
    expect(
      backDestination('/add', {
        backgroundLocation: { pathname: '/ledger', search: '?month=2026-11', hash: '' },
      })
    ).toEqual({ kind: 'path', path: '/ledger?month=2026-11' });
    expect(backDestination('/add', null)).toEqual({ kind: 'path', path: '/' });
  });

  it('takes a settings child back to 设置', () => {
    expect(backDestination('/settings/categories', null)).toEqual({
      kind: 'path',
      path: '/settings',
    });
    expect(backDestination('/settings/backup', null)).toEqual({
      kind: 'path',
      path: '/settings',
    });
  });

  it('takes 项目详情 back to 项目, not straight to 设置', () => {
    expect(backDestination('/settings/projects/project-a', null)).toEqual({
      kind: 'path',
      path: '/settings/projects',
    });
  });

  it('takes 编辑流水 back to 流水', () => {
    expect(backDestination('/txn/txn-a', null)).toEqual({ kind: 'path', path: '/ledger' });
  });
});

describe('createBackHandler', () => {
  it('lets the open sheet consume the press without touching the route', () => {
    register(() => true);
    const back = newBack('/settings/categories');

    expect(back.back()).toBe(1);
    expect(back.navigate).not.toHaveBeenCalled();
    expect(back.historyBack).not.toHaveBeenCalled();
    expect(back.onExitPrompt).not.toHaveBeenCalled();
  });

  it('steps a pushed page to its parent with replace', () => {
    const back = newBack('/settings/categories');

    expect(back.back()).toBe(1);
    expect(back.navigate).toHaveBeenCalledWith('/settings', { replace: true });
    expect(back.historyBack).not.toHaveBeenCalled();
  });

  it('reveals the retained 随手记 instead of remounting it', () => {
    const back = newBack('/accounts', { quickEntryOpen: true });

    expect(back.back()).toBe(1);
    expect(back.historyBack).toHaveBeenCalledTimes(1);
    expect(back.navigate).not.toHaveBeenCalled();
  });

  it('closes 随手记 onto its background tab', () => {
    const back = newBack('/add', {
      backgroundLocation: { pathname: '/reports', search: '', hash: '' },
    });

    expect(back.back()).toBe(1);
    expect(back.navigate).toHaveBeenCalledWith('/reports', { replace: true });
  });

  it('warns once on a tab, then lets Android close on the next press', () => {
    const back = newBack('/ledger');

    expect(back.back()).toBe(1);
    expect(back.onExitPrompt).toHaveBeenCalledTimes(1);
    back.tick(EXIT_WINDOW_MS);
    expect(back.back()).toBe(0);
  });

  it('warns again when the second press comes too late', () => {
    const back = newBack('/settings');

    expect(back.back()).toBe(1);
    back.tick(EXIT_WINDOW_MS + 1);
    expect(back.back()).toBe(1);
    expect(back.onExitPrompt).toHaveBeenCalledTimes(2);
  });

  it('does not carry the exit arm across tabs', () => {
    const back = newBack('/');

    expect(back.back()).toBe(1);
    back.moveTo('/ledger');
    expect(back.back()).toBe(1);
    expect(back.onExitPrompt).toHaveBeenCalledTimes(2);
  });

  it('re-arms after leaving a tab and returning to the same pathname', () => {
    const back = newBack('/');

    expect(back.back()).toBe(1);
    back.moveTo('/ledger');
    back.moveTo('/');
    expect(back.back()).toBe(1);
    expect(back.onExitPrompt).toHaveBeenCalledTimes(2);
  });

  it('resets the exit arm when a sheet consumed a press in between', () => {
    const back = newBack('/reports');
    expect(back.back()).toBe(1);

    const release = register(() => true);
    expect(back.back()).toBe(1);
    release();
    expect(back.back()).toBe(1);
    expect(back.onExitPrompt).toHaveBeenCalledTimes(2);
  });
});

describe('installBackHandler', () => {
  it('installs the handler the shell calls, then removes it', () => {
    vi.stubGlobal('window', {});
    const navigate = vi.fn();
    const uninstall = installBackHandler({
      navigate,
      historyBack: vi.fn(),
      current: () => ({ pathname: '/settings/backup', state: null }),
      onExitPrompt: vi.fn(),
    });

    expect(window.__todaycentsBack?.()).toBe(1);
    expect(navigate).toHaveBeenCalledWith('/settings', { replace: true });
    uninstall();
    expect(window.__todaycentsBack).toBeUndefined();
  });

  it('does not remove a newer install', () => {
    vi.stubGlobal('window', {});
    const environment = {
      navigate: vi.fn(),
      historyBack: vi.fn(),
      current: () => ({ pathname: '/settings', state: null }),
      onExitPrompt: vi.fn(),
    };
    const first = installBackHandler(environment);
    const second = installBackHandler(environment);

    first();
    expect(window.__todaycentsBack).toBeTypeOf('function');
    second();
    expect(window.__todaycentsBack).toBeUndefined();
  });
});