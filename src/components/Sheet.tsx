import type { ReactNode, RefObject } from 'react';
import { useDialogFocus } from './useDialogFocus';

export interface SheetProps {
  /** Kept as an explicit id so existing aria-labelledby values stay stable. */
  titleId?: string;
  /** Bottom-sheet title; the entry variant renders its own header in children. */
  title?: ReactNode;
  /** Keypad overlays use aria-label instead of a visible title. */
  ariaLabel?: string;
  /** Rendered after the title inside `.sheet__head`; caller owns the span class. */
  meta?: ReactNode;
  /** Used by the scrim, Escape and Android back. */
  onClose: () => void;
  /** Passed through to useDialogFocus. */
  initialFocus?: 'first' | 'last' | 'panel';
  /** Passed through to useDialogFocus; false swallows Escape/back while busy. */
  canClose?: () => boolean;
  /** Default true. Set false when the scrim must stop closing while busy. */
  scrimDismiss?: boolean;
  /** Bottom sheet, full-screen entry, or the compact keypad overlay. */
  variant?: 'bottom' | 'entry' | 'keypad';
  /** Entry sheets can be deactivated while still mounted under another page. */
  open?: boolean;
  /** Skip focus restore when a temporary deactivation must leave it alone. */
  restoreFocus?: () => boolean;
  /** Filter hidden controls out of the Tab trap. */
  focusableFilter?: (element: HTMLElement) => boolean;
  className?: string;
  panelClassName?: string;
  children: ReactNode;
}

/**
 * The shared bottom-sheet shell: same DOM, classes and aria as the screens it
 * replaces, with focus trapping, Escape and Android back handled centrally.
 * Business copy and actions stay in children.
 */
export function Sheet({
  titleId,
  title,
  ariaLabel,
  meta,
  onClose,
  initialFocus,
  canClose,
  scrimDismiss = true,
  variant = 'bottom',
  open = true,
  restoreFocus,
  focusableFilter,
  className,
  panelClassName,
  children,
}: SheetProps) {
  const panelRef = useDialogFocus({
    open,
    onClose,
    initial: initialFocus,
    canClose,
    restoreFocus,
    focusableFilter,
  });

  if (variant === 'keypad') {
    const layerClass =
      className === undefined ? 'txn-keypad-layer' : `txn-keypad-layer ${className}`;
    const panelClass =
      panelClassName === undefined
        ? 'txn-keypad-panel'
        : `txn-keypad-panel ${panelClassName}`;
    return (
      <div className={layerClass} role="dialog" aria-modal="true" aria-label={ariaLabel}>
        <div
          className="txn-keypad-scrim"
          aria-hidden="true"
          onClick={scrimDismiss ? onClose : undefined}
        />
        <div className={panelClass} ref={panelRef} tabIndex={-1}>
          {children}
        </div>
      </div>
    );
  }

  if (variant === 'entry') {
    const layerClass = className === undefined ? 'entry-layer' : `entry-layer ${className}`;
    const panelClass =
      panelClassName === undefined ? 'entry-sheet' : `entry-sheet ${panelClassName}`;
    return (
      <div className={layerClass}>
        <div
          className="entry-scrim"
          aria-hidden="true"
          onClick={scrimDismiss ? onClose : undefined}
        />
        <section
          className={panelClass}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          ref={panelRef as unknown as RefObject<HTMLElement>}
          tabIndex={-1}
        >
          {children}
        </section>
      </div>
    );
  }

  const sheetClass = className === undefined ? 'sheet' : `sheet ${className}`;
  const panelClass = panelClassName === undefined ? 'sheet__panel' : `sheet__panel ${panelClassName}`;

  return (
    <div className={sheetClass} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div
        className="sheet__scrim"
        aria-hidden="true"
        onClick={scrimDismiss ? onClose : undefined}
      />
      <div className={panelClass} ref={panelRef} tabIndex={-1}>
        <div className="sheet__head">
          <h2 className="sheet__title" id={titleId}>
            {title}
          </h2>
          {meta}
        </div>
        {children}
      </div>
    </div>
  );
}
