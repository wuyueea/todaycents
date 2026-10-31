import type { Direction } from '../domain/types';
import { formatCents } from '../domain/money';

/**
 * The one display formatter: formatCents plus the thousands groups and the
 * typographic minus the rules require. formatCents stays the arithmetic/export
 * formatter (ASCII hyphen, no grouping), so no amount is ever re-parsed from a
 * displayed string; this function only shapes the text.
 */
export function formatCentsDisplay(cents: number): string {
  const plain = formatCents(cents);
  const negative = plain.startsWith('-');
  const unsigned = negative ? plain.slice(1) : plain;
  const [whole, fraction] = unsigned.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}${grouped}.${fraction}`;
}

/**
 * Signed money as displayed, never as computed with.
 *
 * formatCentsDisplay is the single display formatter, so every amount keeps
 * its two decimals and its digit groups; the sign is decided by the integer
 * cents alone: an expense arrives negative and an income positive because the
 * repository wrote it that way. The direction only picks the colour role
 * (expense ink, income amber, transfers and adjustments neutral), which is why
 * a transfer leg may render a sign without taking either direction colour.
 *
 * The display formatter emits the typographic minus U+2212, which sits on the
 * same baseline and width as the digits. formatCents, every input and every
 * prefill keep the ASCII hyphen; only display text carries U+2212.
 *
 * Every positive movement prints an explicit "+", so the two legs of a
 * transfer read as "+100 / −100" and an income reads as money coming in. An
 * expense stays negative because the repository wrote it that way.
 */
export interface AmountTextProps {
  /** Signed integer cents, exactly as stored. */
  cents: number;
  /** Colour role only; it never adds or removes a sign. */
  direction: Direction;
}

export function AmountText({ cents, direction }: AmountTextProps) {
  const signed =
    cents > 0 && direction !== 'expense'
      ? `+${formatCentsDisplay(cents)}`
      : formatCentsDisplay(cents);
  // formatCentsDisplay already uses U+2212; signed keeps its leading plus.
  const display = signed;

  return (
    <span className={`amount-text amount-text--${direction} num`} data-direction={direction}>
      {display}
    </span>
  );
}