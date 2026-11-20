import { useState } from 'react';
import {
  AmountKeypad,
  formatAmountDraft,
} from './AmountKeypad';
import { Sheet } from './Sheet';

export interface AmountKeypadFieldProps {
  /** DOM id so the visible label still points at the control. */
  id?: string;
  /** Raw draft, e.g. "12.30" or "". */
  value: string;
  /** Receives the next raw draft. */
  onChange: (next: string) => void;
  label?: string;
  /** Text shown before anything is typed; also used as the accessible suffix. */
  placeholder?: string;
  /** Empty value displayed in the keypad. */
  keypadPlaceholder?: string;
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
  keypadPlaceholder = '0.00',
  invalid = false,
  disabled = false,
}: AmountKeypadFieldProps) {
  const [open, setOpen] = useState(false);
  const display = value.trim() === '' ? '' : formatAmountDraft(value);

  return (
    <>
      <button
        id={id}
        className={`amount-keypad-field${display === '' ? ' is-empty' : ''}`}
        type="button"
        data-amount-open
        aria-label={`${label} ${display === '' ? placeholder : display}`}
        aria-invalid={invalid ? 'true' : undefined}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {display === '' ? placeholder : display}
      </button>

      {open && (
        <Sheet
          variant="keypad"
          ariaLabel={`${label}键盘`}
          onClose={() => setOpen(false)}
        >
          <div className="txn-keypad-head">
            <span>{label}</span>
            <strong aria-live="polite">
              {display === '' ? keypadPlaceholder : display}
            </strong>
          </div>
          <AmountKeypad
            value={value}
            onChange={onChange}
            replaceOnFirstKey
            actionLabel="完成"
            actionType="button"
            actionData="done"
            onAction={() => setOpen(false)}
          />
        </Sheet>
      )}
    </>
  );
}
