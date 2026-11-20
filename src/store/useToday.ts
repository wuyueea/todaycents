import { useSyncExternalStore } from 'react';
import { todayLocalISO } from '../domain/date';

const listeners = new Set<() => void>();
let timer: number | undefined;

function refreshToday() {
  window.clearTimeout(timer);
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  timer = window.setTimeout(refreshToday, midnight.getTime() - now.getTime());
  listeners.forEach(notify => notify());
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', refreshToday);
    document.addEventListener('todaycents:resume', refreshToday);
    window.addEventListener('focus', refreshToday);
    refreshToday();
  }

  return () => {
    listeners.delete(notify);
    if (listeners.size !== 0) return;
    window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', refreshToday);
    document.removeEventListener('todaycents:resume', refreshToday);
    window.removeEventListener('focus', refreshToday);
  };
}

/** A shared local calendar day for 今天 and the sheet that can cover it. */
export function useToday(): string {
  return useSyncExternalStore(subscribe, todayLocalISO, todayLocalISO);
}
