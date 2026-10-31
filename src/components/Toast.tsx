import { useEffect, useState } from 'react';

/** How long a success line stays on screen, in milliseconds. */
const TOAST_MS = 4000;

export interface ToastProps {
  text: string;
  /** Optional one-tap follow-up, such as 撤销. */
  actionLabel?: string;
  onAction?(): void;
}

/**
 * One quiet line at the bottom of the screen, in the prototype's ink bar.
 * It is a status, not a page: the owner stays exactly where they were.
 *
 * A toast that carries an action (the category delete's 10-second 撤销) keeps
 * that action inside the same bar, so the undo is where the confirmation was.
 */
export function Toast({ text, actionLabel, onAction }: ToastProps) {
  const withAction = actionLabel !== undefined && onAction !== undefined;

  return (
    <div className={withAction ? 'toast toast--action' : 'toast'} role="status">
      <span className="toast__text">{text}</span>
      {withAction && (
        <button className="toast__action" type="button" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export interface ToastControls {
  toast: string | null;
  showToast(text: string): void;
  clearToast(): void;
}

/**
 * Holds one toast and dismisses it after a few seconds.
 *
 * The effect only runs in the browser, so server rendering shows the initial
 * text (which is what the SSR tests assert) without scheduling a timer.
 */
export function useToast(initialText: string | null = null): ToastControls {
  const [toast, setToast] = useState<string | null>(initialText);

  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return { toast, showToast: setToast, clearToast: () => setToast(null) };
}
