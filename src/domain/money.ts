const FULL_WIDTH_DIGITS = /[\uFF10-\uFF19]/g;
const FULL_WIDTH_FULL_STOP = /\uFF0E/g;
const NON_ASCII = /[^\x20-\x7E]/;
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

/**
 * Parses user input into positive integer cents.
 *
 * The fraction is split off the string, so money never goes through floating
 * point arithmetic (no `* 100`). Input that is not exactly "digits" or
 * "digits.fraction" is rejected with null instead of being rounded or coerced;
 * zero and negative amounts are rejected as well, because the sign lives on the
 * transaction's direction, never on the parsed amount.
 */
export function parseAmountToCents(input: string): number | null {
  const normalized = input
    .replace(FULL_WIDTH_DIGITS, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(FULL_WIDTH_FULL_STOP, '.');

  // Only full-width digits and the full-width full stop get normalized. Every
  // other non-ASCII character (ideographic full stop, 元, full-width space) is
  // rejected, not silently stripped or trimmed away.
  if (NON_ASCII.test(normalized)) {
    return null;
  }

  const trimmed = normalized.trim();
  if (!AMOUNT_PATTERN.test(trimmed)) {
    return null;
  }

  const [whole, fraction = ''] = trimmed.split('.');
  const cents = Number(whole + fraction.padEnd(2, '0'));

  // Concatenating very long digit strings can exceed Number.MAX_SAFE_INTEGER;
  // reject those instead of storing imprecise cents.
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/**
 * Formats integer cents with exactly two decimals: 1230 -> "12.30",
 * 5 -> "0.05", -700 -> "-7.00". Display only; never used for arithmetic.
 */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`formatCents expects integer cents, received ${cents}`);
  }
  const sign = cents < 0 ? '-' : '';
  // Pad to at least three digits so the last two are always the fen.
  const digits = String(Math.abs(cents)).padStart(3, '0');
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
