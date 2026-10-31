function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Today on the local calendar as YYYY-MM-DD; never derived from UTC. */
export function todayLocalISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Month bucket of a YYYY-MM-DD date, taken from the string prefix only. */
export function monthKeyOf(dateISO: string): string {
  return dateISO.slice(0, 7);
}

const ISO_DAY = /^\d{4}-(\d{2})-(\d{2})$/;

/**
 * A calendar day as people say it: "2026-10-20" -> "10月20日".
 *
 * Display only. The month and day lose their leading zeroes, while the year is
 * never printed; a caller that has to disambiguate years must do so itself.
 */
export function formatMonthLabel(monthKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (match === null) {
    throw new RangeError(`monthKey must be YYYY-MM, received ${monthKey}`);
  }
  return `${Number(match[1])}年${Number(match[2])}月`;
}

export function formatMonthDay(dateISO: string): string {
  const match = ISO_DAY.exec(dateISO);
  if (match === null) {
    throw new RangeError(`dateISO must be YYYY-MM-DD, received ${dateISO}`);
  }
  return `${Number(match[1])}月${Number(match[2])}日`;
}

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** True only for the exact YYYY-MM shape a month input produces. */
export function isMonthKey(value: string): boolean {
  return MONTH_KEY.test(value);
}

/**
 * Moves a month key by whole months, across year boundaries.
 *
 * Pure arithmetic rather than Date: a month key has no day and no time zone,
 * and the Date constructor maps years 0-99 to the 1900s. A malformed key or a
 * fractional delta is a programming error, not user input, so it throws.
 */
export function shiftMonthKey(monthKey: string, delta: number): string {
  if (!isMonthKey(monthKey)) {
    throw new RangeError(`monthKey must be YYYY-MM, received ${monthKey}`);
  }
  if (!Number.isInteger(delta)) {
    throw new RangeError(`delta must be a whole number of months, received ${delta}`);
  }
  const [year, month] = monthKey.split('-').map(Number);
  const totalMonths = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(totalMonths / 12);
  const nextMonth = totalMonths - nextYear * 12 + 1;
  return `${nextYear}-${pad2(nextMonth)}`;
}

/** First and last day of a YYYY-MM month, inclusive on both ends. */
export function monthRange(monthKey: string): { start: string; end: string } {
  const [year, month] = monthKey.split('-').map(Number);
  // Day 0 of the following month is the last day of the requested month; the
  // date is built locally, so 28/29/30/31-day months need no special casing.
  const lastDay = new Date(year, month, 0).getDate();
  const start = `${year}-${pad2(month)}-01`;
  const end = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  return { start, end };
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Gregorian leap rule, including the century exceptions. */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

interface CivilDay {
  year: number;
  month: number;
  day: number;
}

/**
 * Splits a YYYY-MM-DD string and proves it is a real calendar day.
 *
 * The shape alone is not enough: 2026-02-30 is stored happily by SQLite and
 * then falls out of every range query, so the day is checked against the
 * actual length of its month. Nothing is trimmed or coerced — a date that is
 * not exactly ten ASCII characters is a bug at the call site.
 */
function parseCivilDay(dateISO: string): CivilDay {
  const match = ISO_DAY.exec(dateISO);
  if (match === null) {
    throw new RangeError(`date must be YYYY-MM-DD, received ${dateISO}`);
  }
  const year = Number(dateISO.slice(0, 4));
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new RangeError(`date must be YYYY-MM-DD, received ${dateISO}`);
  }
  const lastDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > lastDay) {
    throw new RangeError(`date must be YYYY-MM-DD, received ${dateISO}`);
  }
  return { year, month, day };
}

/**
 * The ledger's one calendar-day guard, shared by every write that takes a date
 * and by the day counter below. Fixed-cost detection compares bill dates, so a
 * row dated 2026-02-30 must be refused rather than silently skipped later.
 */
export function assertDateISO(dateISO: string): void {
  parseCivilDay(dateISO);
}

/**
 * Days since 1970-01-01 for one civil date, by pure arithmetic.
 *
 * Howard Hinnant's days_from_civil: no Date object, so no time zone, no DST and
 * no sign quirks for years 0-99. Local midnight to local midnight across a
 * spring-forward day is 23 hours, which a Date subtraction would report as
 * 0.958 days and floor to zero.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const shiftedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * Whole calendar days from `fromISO` to `toISO`; negative when `toISO` is the
 * earlier day. Both arguments must be real YYYY-MM-DD days.
 *
 * A calendar-day count, not an elapsed-time count: 2026-10-01 to 2026-11-01 is
 * always 31, whatever a time zone or daylight-saving shift does to the hours
 * in between.
 */
export function daysBetweenISO(fromISO: string, toISO: string): number {
  const from = parseCivilDay(fromISO);
  const to = parseCivilDay(toISO);
  return (
    daysFromCivil(to.year, to.month, to.day) - daysFromCivil(from.year, from.month, from.day)
  );
}
