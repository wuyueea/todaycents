import type { ChangeEvent } from 'react';

/**
 * The app's only money field: a controlled text input that opens a decimal
 * keypad on a phone.
 *
 * It deliberately does not validate or filter while the user types. A booking
 * app must let you type "12." on the way to "12.30", and rejecting keystrokes
 * is both surprising and platform-dependent. Parsing happens once, at submit
 * time, via parseAmountToCents; the only thing this field does about bad input
 * is flag it through aria-invalid so the screen can show it without moving
 * focus or discarding what was typed.
 */
export interface MoneyInputProps {
  /** Current text, exactly as typed. Never parsed here. */
  value: string;
  onChange: (value: string) => void;
  /** Marks the field for assistive tech and the error style; does not block input. */
  invalid?: boolean;
  /** DOM id, so a visible label can point at the field. */
  id?: string;
  /** Accessible name for standalone use; a visible label should use id + htmlFor. */
  label?: string;
  placeholder?: string;
  /** Greys the field out and blocks typing, e.g. a frozen opening balance. */
  disabled?: boolean;
  /** Task 11's quick-entry screen focuses the amount on open. */
  autoFocus?: boolean;
}

export function MoneyInput({
  value,
  onChange,
  invalid = false,
  id,
  label,
  placeholder,
  disabled = false,
  autoFocus = false,
}: MoneyInputProps) {
  return (
    <input
      id={id}
      className="money-input"
      // text, not number: type=number eats trailing dots, reports '' for
      // half-typed exponents and spins on desktop. inputMode is what actually
      // selects the decimal keypad on mobile.
      type="text"
      inputMode="decimal"
      autoComplete="off"
      autoFocus={autoFocus}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={label}
      // undefined rather than "false": a valid field carries no invalid state
      // at all, which is what screen readers want to hear.
      aria-invalid={invalid ? 'true' : undefined}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
    />
  );
}
