import { useState } from 'react';

const MAX_INTEGER_DIGITS = 7;
const MAX_FRACTION_DIGITS = 2;
const LIMIT_MESSAGES = {
  integer: `整数最多 ${MAX_INTEGER_DIGITS} 位`,
  fraction: `小数最多 ${MAX_FRACTION_DIGITS} 位`,
};

type AmountKeyLimit = keyof typeof LIMIT_MESSAGES;

interface AmountKeyResult {
  value: string;
  limit: AmountKeyLimit | null;
}

/** 00 applies two zeros, retaining the first if only the second is blocked. */
function readAmountKey(current: string, key: string): AmountKeyResult {
  if (key === 'del') return { value: current.slice(0, -1), limit: null };
  if (key === 'clr') return { value: '', limit: null };
  if (key === '00') {
    const first = readAmountKey(current, '0');
    return first.limit === null ? readAmountKey(first.value, '0') : first;
  }
  const [whole, fraction] = current.split('.');
  if (key === '.') {
    return { value: fraction === undefined ? `${current || '0'}.` : current, limit: null };
  }
  if (!/^\d$/.test(key)) return { value: current, limit: null };
  if (fraction !== undefined && fraction.length >= MAX_FRACTION_DIGITS) {
    return { value: current, limit: 'fraction' };
  }
  if (fraction === undefined && whole!.replace(/^0+/, '').length >= MAX_INTEGER_DIGITS) {
    return { value: current, limit: 'integer' };
  }
  return { value: current === '0' ? key : current + key, limit: null };
}

/** Apply one keypad press to the raw draft without parsing it as money. */
export function applyAmountKey(current: string, key: string): string {
  return readAmountKey(current, key).value;
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
  /** An editor starts a new draft on its first single digit or decimal point. */
  replaceOnFirstKey?: boolean;
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
  replaceOnFirstKey = false,
}: AmountKeypadProps) {
  const [pristine, setPristine] = useState(replaceOnFirstKey);
  const [limit, setLimit] = useState<AmountKeyLimit | null>(null);

  const press = (key: string) => {
    const replacing = pristine && (key === '.' || /^\d$/.test(key));
    const next = readAmountKey(replacing ? '' : value, key);
    setPristine(false);
    if (next.limit !== null || next.value !== value) {
      setLimit(next.limit);
    }
    onChange(next.value);
  };

  return (
    <div className="entry-keypad" role="group" aria-label="数字键盘">
      <p className="entry-keypad-limit" role="status">{limit === null ? '' : LIMIT_MESSAGES[limit]}</p>
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
        onClick={onAction}
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
