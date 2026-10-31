import { useEffect, useRef, useState } from 'react';
import {
  AmountKeypad,
  applyAmountKey,
  formatAmountDraft,
} from './AmountKeypad';

export interface AmountKeypadFieldProps {
  /** DOM id so the visible label still points at the control. */
  id?: string;
  /** Raw draft, e.g. "12.30" or "". */
  value: string;
  /** Receives the next raw draft. */
  onChange: (next: string) => void;
  /** Text shown before anything is typed; also used as the accessible suffix. */
  label?: string;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
}

/**
 * One money control that always opens the shared keypad.
 *
 * The button is the field: there is no text input in the DOM, so the system
 * keyboard never appears. The first digit replaces an existing amount (editing
 * 12.60 by pressing 2 gives 2), while backspace and 清空 keep the old draft
 * editable. The parent still parses the raw string with parseAmountToCents.
 */
export function AmountKeypadField({
  id,
  value,
  onChange,
  label = '金额',
  placeholder = '0.00',
  invalid = false,
  disabled = false,
}: AmountKeypadFieldProps) {
  const [open, setOpen] = useState(false);
  const [pristine, setPristine] = useState(false);
  const fieldRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const firstButton = panel?.querySelector<HTMLElement>('button:not(:disabled)');
    (firstButton ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab' || panel === null) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>('button:not(:disabled)')
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      fieldRef.current?.focus();
    };
  }, [open]);

  const display = value.trim() === '' ? '' : formatAmountDraft(value);

  return (
    <>
      <button
        ref={fieldRef}
        id={id}
        className={`amount-keypad-field${display === '' ? ' is-empty' : ''}`}
        type="button"
        data-amount-open
        aria-label={`${label} ${display === '' ? placeholder : display}`}
        aria-invalid={invalid ? 'true' : undefined}
        disabled={disabled}
        onClick={() => {
          setPristine(true);
          setOpen(true);
        }}
      >
        {display === '' ? placeholder : display}
      </button>

      {open && (
        <div
          className="txn-keypad-layer"
          role="dialog"
          aria-modal="true"
          aria-label={`${label}键盘`}
        >
          <div
            className="txn-keypad-scrim"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <div className="txn-keypad-panel" ref={panelRef} tabIndex={-1}>
            <div className="txn-keypad-head">
              <span>{label}</span>
              <strong aria-live="polite">
                {value.trim() === '' ? '0.00' : formatAmountDraft(value)}
              </strong>
            </div>
            <AmountKeypad
              value={value}
              onChange={next => onChange(next)}
              onKey={key => {
                let next: string;
                if (pristine && /^\d$/.test(key)) {
                  next = key;
                } else if (pristine && key === '.') {
                  next = '0.';
                } else {
                  next = applyAmountKey(value, key);
                }
                setPristine(false);
                onChange(next);
              }}
              actionLabel="完成"
              actionType="button"
              actionData="done"
              onAction={() => setOpen(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}