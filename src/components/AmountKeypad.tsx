import type { MouseEvent } from 'react';

/**
 * The one numeric keypad: a draft string, ten digits, backspace and clear.
 *
 * It never parses money. The string is shaped for display and handed to
 * parseAmountToCents on save; a second dot, a third decimal and more than seven
 * integer digits are ignored rather than rewritten. 00 is two presses of 0.
 */
export function applyAmountKey(current: string, key: string): string {
  if (key === 'del') return current.slice(0, -1);
  if (key === 'clr') return '';
  if (key === '00') return applyAmountKey(applyAmountKey(current, '0'), '0');
  if (key === '.') {
    if (current.includes('.')) return current;
    return `${current || '0'}.`;
  }
  if (!/^\d$/.test(key)) return current;
  if (current.includes('.') && current.split('.')[1]!.length >= 2) return current;
  if (!current.includes('.') && current.replace(/^0+/, '').length >= 7) return current;
  if (current === '0') return key;
  return current + key;
}

/**
 * The draft as it appears above the keypad: never forced to two decimals while
 * typing, with thousands groups. A signed draft gets the typographic minus.
 */
export function formatAmountDraft(current: string, signedAsExpense = false): string {
  if (current === '') return '0.00';
  const [whole, fraction] = current.split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const shown = fraction === undefined ? grouped : `${grouped}.${fraction}`;
  return signedAsExpense && /[1-9]/.test(current) ? `−${shown}` : shown;
}

export interface AmountKeypadProps {
  /** Raw draft, exactly as the parent stores it. */
  value: string;
  /** Receives the next raw draft; the parent owns parsing and error clearing. */
  onChange: (next: string) => void;
  /** Optional key-level hook, for editors that replace an existing draft on the first key. */
  onKey?: (key: string) => void;
  /** The tall amber key. Defaults to 保存, as on 随手记. */
  actionLabel?: string;
  /** What the tall key does. Omit it for a submit button. */
  onAction?: () => void;
  /** submit inside a form (随手记) or button in a sheet (编辑流水). */
  actionType?: 'button' | 'submit';
  actionDisabled?: boolean;
  /** data-action value, kept stable for the existing tests. */
  actionData?: string;
}

/** The shared 4×4 keypad. The parent owns the value and the amber action. */
export function AmountKeypad({
  value,
  onChange,
  actionLabel = '保存',
  onAction,
  actionType = 'submit',
  actionDisabled = false,
  actionData = 'save',
  onKey,
}: AmountKeypadProps) {
  const press = (key: string) => {
    if (onKey !== undefined) {
      onKey(key);
      return;
    }
    onChange(applyAmountKey(value, key));
  };
  const actionClick = onAction === undefined ? undefined : (_event: MouseEvent<HTMLButtonElement>) => onAction();

  return (
    <div className="entry-keypad" role="group" aria-label="数字键盘">
      {['1', '2', '3'].map(key => (
        <button key={key} type="button" className="entry-key" data-key={key} onClick={() => press(key)}>
          {key}
        </button>
      ))}
      <button
        type="button"
        className="entry-key entry-key--fn"
        data-key="del"
        aria-label="退格"
        onClick={() => press('del')}
      >
        ⌫
      </button>
      {['4', '5', '6'].map(key => (
        <button key={key} type="button" className="entry-key" data-key={key} onClick={() => press(key)}>
          {key}
        </button>
      ))}
      <button
        type="button"
        className="entry-key entry-key--fn"
        data-key="clr"
        onClick={() => press('clr')}
      >
        清空
      </button>
      {['7', '8', '9'].map(key => (
        <button key={key} type="button" className="entry-key" data-key={key} onClick={() => press(key)}>
          {key}
        </button>
      ))}
      <button
        className="entry-key entry-key--save"
        type={actionType}
        data-action={actionData}
        disabled={actionDisabled}
        onClick={actionClick}
      >
        {actionLabel}
      </button>
      {['00', '0', '.'].map(key => (
        <button key={key} type="button" className="entry-key" data-key={key} onClick={() => press(key)}>
          {key}
        </button>
      ))}
    </div>
  );
}