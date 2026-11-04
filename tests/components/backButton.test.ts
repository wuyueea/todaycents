import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createBackHandler,
  historyIndexNow,
  installBackHandler,
  registerBackHandler,
  runBackHandlers,
} from '../../src/components/backButton';

/**
 * The back key is a stack: whichever sheet opened last gets the press first,
 * and a sheet that refuses (a delete in flight) must not swallow it. The
 * rest is the route step, which is pure enough to test without a DOM.
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

describe('back handler stack', () => {
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

  it('falls through when a handler declines', () => {
    const older = vi.fn(() => true);
    const newer = vi.fn(() => false);
    register(older);
    register(newer);

    expect(runBackHandlers()).toBe(true);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).toHaveBeenCalledTimes(1);
  });

  it('reports an unhandled press when nothing is open', () => {
    expect(runBackHandlers()).toBe(false);
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

describe('createBackHandler', () => {
  it('lets the open sheet consume the press without touching the route', () => {
    register(() => true);
    const navigate = vi.fn();
    const back = createBackHandler({ navigate, historyIndex: () => 2 });

    expect(back()).toBe(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('steps back when the route has somewhere to go', () => {
    const navigate = vi.fn();
    const back = createBackHandler({ navigate, historyIndex: () => 1 });

    expect(back()).toBe(1);
    expect(navigate).toHaveBeenCalledWith(-1);
  });

  it('leaves the press to Android on the first entry', () => {
    const navigate = vi.fn();
    const back = createBackHandler({ navigate, historyIndex: () => 0 });

    expect(back()).toBe(0);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('historyIndexNow', () => {
  it('reads the index react-router wrote', () => {
    vi.stubGlobal('window', { history: { state: { idx: 2 } } });

    expect(historyIndexNow()).toBe(2);
  });

  it('treats a missing state as the first entry', () => {
    vi.stubGlobal('window', { history: { state: null } });

    expect(historyIndexNow()).toBe(0);
  });

  it('treats a non-numeric index as the first entry', () => {
    vi.stubGlobal('window', { history: { state: { idx: '2' } } });

    expect(historyIndexNow()).toBe(0);
  });
});

describe('installBackHandler', () => {
  it('installs the handler the shell calls, then removes it', () => {
    vi.stubGlobal('window', { history: { state: { idx: 1 } } });
    const navigate = vi.fn();
    const uninstall = installBackHandler(navigate);

    expect(window.__todaycentsBack?.()).toBe(1);
    expect(navigate).toHaveBeenCalledWith(-1);
    uninstall();
    expect(window.__todaycentsBack).toBeUndefined();
  });

  it('does not remove a newer install', () => {
    vi.stubGlobal('window', { history: { state: { idx: 0 } } });
    const first = installBackHandler(vi.fn());
    const second = installBackHandler(vi.fn());

    first();
    expect(window.__todaycentsBack).toBeTypeOf('function');
    second();
    expect(window.__todaycentsBack).toBeUndefined();
  });
});
