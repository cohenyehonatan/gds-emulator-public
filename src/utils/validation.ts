/**
 * Validation / parsing helpers for Sabre cryptic argument fragments.
 *
 * Kept deliberately small for the scaffold — extend as command parsers grow.
 * Formats below are grounded in references/Sabre-Basic-Reservation-Course.pdf.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** A Sabre date token like "22JAN" or "3SEP" (day 1-31 + 3-letter month). */
const DATE_RE = /^(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/;

export interface SabreDate {
  day: number;
  month: number; // 0-based, matches Date
  raw: string; // e.g. "22JAN"
}

/** Parse a leading Sabre date token. Returns the date and the consumed length. */
export function parseSabreDate(s: string): { date: SabreDate; length: number } | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  if (day < 1 || day > 31) return null;
  return {
    date: { day, month: MONTHS.indexOf(m[2]), raw: m[1] + m[2] },
    length: m[0].length,
  };
}

/** A city pair is two 3-letter IATA codes, e.g. "JFKLAX". */
export function isCityPair(s: string): boolean {
  return /^[A-Z]{6}$/.test(s);
}

/** Split a 6-char city pair into origin/destination. */
export function splitCityPair(s: string): { origin: string; destination: string } {
  return { origin: s.slice(0, 3), destination: s.slice(3, 6) };
}

/** A booking class is a single A-Z letter (Y, J, F, ...). */
export function isBookingClass(c: string): boolean {
  return /^[A-Z]$/.test(c);
}

export { MONTHS };
