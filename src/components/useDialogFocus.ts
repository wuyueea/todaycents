import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

interface DialogFocusOptions {
  /** Whether the dialog is currently mounted; false keeps the effect idle. */
  open?: boolean;
  onClose: () => void;
  /** Focus the safe action (last button) instead of the first control. */
  initial?: 'first' | 'last';
  /** Optional guard for Escape while a destructive request is in flight. */
  canClose?: () => boolean;
}

/**
 * Focus management for the app's bottom sheets.
 *
 * Remembers the trigger, moves focus inside, keeps Tab inside while open,
 * closes on Escape, and returns focus to the trigger on unmount. The dialog
 * panel needs the returned ref and tabIndex={-1}.
 */
export function useDialogFocus({
  open = true,
  onClose,
  initial = 'first',
  canClose,
}: DialogFocusOptions): RefObject<HTMLDivElement | null> {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const canCloseRef = useRef(canClose);
  closeRef.current = onClose;
  canCloseRef.current = canClose;

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel === null) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
    );
    const first = initial === 'first' ? focusable[0] : focusable[focusable.length - 1];
    (first ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (canCloseRef.current === undefined || canCloseRef.current()) closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || focusable.length === 0) return;
      const firstFocusable = focusable[0]!;
      const lastFocusable = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [open, initial]);

  return panelRef;
}
