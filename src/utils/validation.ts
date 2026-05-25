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

/**
 * Parse a Sabre clock token to minutes-since-midnight.
 * Accepts 24h ("9", "09", "0900", "1400") and 12h ("9A", "900A", "1230P",
 * "1100A", "600P"). Returns null if unparseable. (Workbook: "the time may be
 * written either as 9, 09, 0900 or 9A".)
 */
export function parseClockToMinutes(s: string): number | null {
  const m = /^(\d{1,4})\s*([AP])?$/i.exec(s.trim());
  if (!m) return null;
  const digits = m[1];
  const mer = m[2]?.toUpperCase();
  let hh: number;
  let mm: number;
  if (digits.length <= 2) {
    hh = parseInt(digits, 10);
    mm = 0;
  } else {
    hh = parseInt(digits.slice(0, digits.length - 2), 10);
    mm = parseInt(digits.slice(-2), 10);
  }
  if (mer) {
    if (hh === 12) hh = mer === 'A' ? 0 : 12;
    else if (mer === 'P') hh += 12;
  }
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/** Format a clock token as 24-hour HHMM, e.g. "700A" → "0700", "520P" → "1720". */
export function to24h(clock: string): string {
  const m = parseClockToMinutes(clock);
  if (m == null) return clock;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
}

export { MONTHS };
