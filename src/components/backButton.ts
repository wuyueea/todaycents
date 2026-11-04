/**
 * The hardware back key, routed through the page.
 *
 * The native shell ships without Capacitor's App plugin, so nothing in JS
 * ever saw the back press: Android finished the activity instead, which quits
 * the app even when a sheet is open or the screen was pushed from 设置.
 * MainActivity now asks the page first, through window.__todaycentsBack, and
 * only finishes when the page answers 0.
 *
 * The page answers in this order: let the newest open sheet close itself; if
 * the route has somewhere to go back to, step back; otherwise let Android
 * close the app, which is what back means on a root tab.
 */

declare global {
  interface Window {
    /** Installed by App; returns 1 when the page consumed the press. */
    __todaycentsBack?: () => number;
  }
}

type BackHandler = () => boolean;

/**
 * Open sheets, newest last. Registration order is stacking order: a sheet
 * registers when it opens, so the newest is the last one on the list. A
 * handler that returns false lets the press fall through to the next one.
 */
const handlers: BackHandler[] = [];

/** Puts one handler on the stack; the returned function takes it off again. */
export function registerBackHandler(handler: BackHandler): () => void {
  handlers.push(handler);
  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index !== -1) handlers.splice(index, 1);
  };
}

/** Runs the newest handler that wants the press; true when one consumed it. */
export function runBackHandlers(): boolean {
  for (let index = handlers.length - 1; index >= 0; index -= 1) {
    if (handlers[index]!()) return true;
  }
  return false;
}

export interface BackEnvironment {
  /** react-router's navigate, used only for the history step. */
  navigate: (delta: number) => void;
  /**
   * Index of the current entry in react-router's history. 0 is the first
   * entry: stepping back from there would leave the app, so it is 0 too.
   */
  historyIndex: () => number;
}

/**
 * Builds the function Android calls. 1 means the page handled the press; 0
 * means there is nowhere left to go and the activity may finish.
 */
export function createBackHandler({ navigate, historyIndex }: BackEnvironment): () => number {
  return () => {
    if (runBackHandlers()) return 1;
    if (historyIndex() > 0) {
      navigate(-1);
      return 1;
    }
    return 0;
  };
}

/** Reads react-router's index out of the browser's history state. */
export function historyIndexNow(): number {
  const state = window.history.state as { idx?: unknown } | null;
  return typeof state?.idx === 'number' ? state.idx : 0;
}

/** Installs the handler for the native shell; returns its uninstaller. */
export function installBackHandler(navigate: (delta: number) => void): () => void {
  const handler = createBackHandler({ navigate, historyIndex: historyIndexNow });
  window.__todaycentsBack = handler;
  return () => {
    if (window.__todaycentsBack === handler) delete window.__todaycentsBack;
  };
}
