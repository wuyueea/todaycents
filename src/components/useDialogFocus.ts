import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { registerBackHandler } from './backButton';

interface DialogFocusOptions {
  /** Whether the dialog is currently mounted; false keeps the effect idle. */
  open?: boolean;
  onClose: () => void;
  /** Focus the panel, the first control, or the safe action (last button). */
  initial?: 'first' | 'last' | 'panel';
  /** Optional guard for Escape while a destructive request is in flight. */
  canClose?: () => boolean;
  /** Skip restoring focus when a temporary deactivation must leave it alone. */
  restoreFocus?: () => boolean;
  /** Exclude elements hidden by the screen (for example an inactive tab panel). */
  focusableFilter?: (element: HTMLElement) => boolean;
}

/**
 * Focus management for the app's bottom sheets.
 *
 * Remembers the trigger, moves focus inside, keeps Tab inside while open,
 * closes on Escape and the Android back key, and returns focus to the trigger
 * on unmount. The dialog panel needs the returned ref and tabIndex={-1}.
 */
export function useDialogFocus({
  open = true,
  onClose,
  initial = 'first',
  canClose,
  restoreFocus,
  focusableFilter,
}: DialogFocusOptions): RefObject<HTMLDivElement | null> {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const canCloseRef = useRef(canClose);
  const restoreFocusRef = useRef(restoreFocus);
  const focusableFilterRef = useRef(focusableFilter);
  closeRef.current = onClose;
  canCloseRef.current = canClose;
  restoreFocusRef.current = restoreFocus;
  focusableFilterRef.current = focusableFilter;

  useEffect(() => {
    if (!open) return;
    // Register before the panel check: an open sheet owns the back key even
    // if its panel ref has not landed yet, so the press can never fall past
    // it to the route.
    const releaseBack = registerBackHandler(() => {
      // A dialog that is mid-write (a destructive request or an import)
      // swallows the press instead of closing: falling through would navigate
      // the page out from under the request that the dialog is waiting for.
      if (canCloseRef.current === undefined || canCloseRef.current()) closeRef.current();
      return true;
    });
    const panel = panelRef.current;
    if (panel === null) return releaseBack;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(element => focusableFilterRef.current?.(element) ?? true);
    const target =
      initial === 'panel'
        ? panel
        : initial === 'first'
          ? focusable[0]
          : focusable[focusable.length - 1];
    (target ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (canCloseRef.current === undefined || canCloseRef.current()) closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || focusable.length === 0) return;
      const firstFocusable = focusable[0]!;
      const lastFocusable = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === firstFocusable || document.activeElement === panel)) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      releaseBack();
      document.removeEventListener('keydown', onKeyDown);
      if (restoreFocusRef.current === undefined || restoreFocusRef.current()) previous?.focus();
    };
  }, [open, initial]);

  return panelRef;
}
