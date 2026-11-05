/**
 * The hardware back key, routed through the page.
 *
 * The native shell ships without Capacitor's App plugin, so nothing in JS
 * ever saw the back press: Android finished the activity instead, which quits
 * the app even when a sheet is open or the screen was pushed from 设置.
 * MainActivity now asks the page first, through window.__todaycentsBack, and
 * only finishes when the page answers 0.
 *
 * The page answers in this order: let the newest open sheet close itself;
 * then walk one level up the page hierarchy (never through the tab history);
 * on a dock tab, the first press only warns and the second one closes.
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

/** How long the tab exit warning stays armed, in milliseconds. */
export const EXIT_WINDOW_MS = 2000;

/** The four routes that own a dock icon; they are the roots of the app. */
const TAB_PATHS: ReadonlySet<string> = new Set(['/', '/ledger', '/reports', '/settings']);

function normalisePath(pathname: string): string {
  if (pathname.length <= 1) return pathname === '' ? '/' : pathname;
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** True for the four dock tabs, the only pages where back means exit. */
export function isTabPath(pathname: string): boolean {
  return TAB_PATHS.has(normalisePath(pathname));
}

/**
 * One step up from a pushed page.
 *
 * - history: reveal the still-mounted 随手记 sheet (the 账户 detour from its
 *   empty-account link must not reset the draft);
 * - path: replace the current entry with the page's structural parent, so
 *   back never walks through every tab the owner visited on the way here.
 */
export type BackDestination =
  | { kind: 'history' }
  | { kind: 'path'; path: string };

function backgroundPath(state: unknown): string | null {
  const background = (state as { backgroundLocation?: unknown } | null)?.backgroundLocation;
  if (background === null || typeof background !== 'object') return null;

  const { pathname, search, hash } = background as {
    pathname?: unknown;
    search?: unknown;
    hash?: unknown;
  };
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;

  return `${pathname}${typeof search === 'string' ? search : ''}${typeof hash === 'string' ? hash : ''}`;
}

/**
 * The structural parent of a route. Null means a dock tab; the caller then
 * owns the double-press exit gesture. 账户 is the one stateful exception:
 * when it was opened from 随手记's empty-account link, stepping history back
 * reveals the sheet that is still mounted underneath, draft intact.
 */
export function backDestination(pathname: string, state: unknown): BackDestination | null {
  const path = normalisePath(pathname);

  if (TAB_PATHS.has(path)) return null;

  if (path === '/add') {
    return { kind: 'path', path: backgroundPath(state) ?? '/' };
  }

  if (path === '/accounts') {
    const fromQuickEntry =
      (state as { quickEntryOpen?: unknown } | null)?.quickEntryOpen === true;
    return fromQuickEntry ? { kind: 'history' } : { kind: 'path', path: '/settings' };
  }

  if (path === '/transfer') return { kind: 'path', path: '/add' };
  if (path === '/txn' || path.startsWith('/txn/')) {
    return { kind: 'path', path: '/ledger' };
  }

  if (path === '/settings/projects') return { kind: 'path', path: '/settings' };
  if (path.startsWith('/settings/projects/')) {
    return { kind: 'path', path: '/settings/projects' };
  }
  if (path.startsWith('/settings/')) return { kind: 'path', path: '/settings' };

  // An unknown route is not a tab, but there is no parent to name; 今天 is the
  // only safe landing place. The router itself also redirects unknown paths.
  return { kind: 'path', path: '/' };
}

export interface BackEnvironment {
  /** react-router's navigate, used to replace the current route with a parent. */
  navigate: (to: string, options?: { replace?: boolean }) => void;
  /** react-router's history step, used only to reveal the retained 随手记. */
  historyBack: () => void;
  /**
   * The route as it is right now; called on each press, never captured stale.
   * key is react-router's per-navigation identity. It lets the exit arm notice
   * that the owner left a tab and came back even when the pathname is the same.
   */
  current: () => { pathname: string; state: unknown; key?: string };
  /** Shows the tab exit warning. */
  onExitPrompt: () => void;
  /** Test seam; defaults to the real clock. */
  now?: () => number;
  /** Test seam; defaults to EXIT_WINDOW_MS. */
  exitWindowMs?: number;
}

/**
 * Builds the function Android calls. 1 means the page handled the press; 0
 * means the owner pressed back twice on a tab and the activity may finish.
 */
export function createBackHandler({
  navigate,
  historyBack,
  current,
  onExitPrompt,
  now = Date.now,
  exitWindowMs = EXIT_WINDOW_MS,
}: BackEnvironment): () => number {
  let armedAt: number | null = null;
  let armedKey: string | null = null;

  return () => {
    if (runBackHandlers()) {
      // A sheet used the press; it must not count as the first half of an exit.
      armedAt = null;
      armedKey = null;
      return 1;
    }

    const { pathname, state, key } = current();
    const path = normalisePath(pathname);
    // Every navigation gets a fresh key. The fallback keeps the pure-function
    // tests (and any caller without a router) working on path alone.
    const routeKey = key ?? path;
    if (armedKey !== routeKey) {
      armedAt = null;
      armedKey = routeKey;
    }

    if (TAB_PATHS.has(path)) {
      const pressedAt = now();
      if (armedAt !== null && pressedAt - armedAt >= 0 && pressedAt - armedAt <= exitWindowMs) {
        armedAt = null;
        return 0;
      }
      armedAt = pressedAt;
      onExitPrompt();
      return 1;
    }

    armedAt = null;
    const destination = backDestination(path, state);
    if (destination === null) return 0;

    if (destination.kind === 'history') historyBack();
    else navigate(destination.path, { replace: true });
    return 1;
  };
}

/** Installs the handler for the native shell; returns its uninstaller. */
export function installBackHandler(environment: BackEnvironment): () => void {
  const handler = createBackHandler(environment);
  window.__todaycentsBack = handler;
  return () => {
    if (window.__todaycentsBack === handler) delete window.__todaycentsBack;
  };
}
