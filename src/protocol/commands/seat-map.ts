/**
 * Seat map display (Sabre Basic Course "Display Seat Maps", p.~). Two forms:
 *   4G<n>*                       segment in current PNR
 *   4G*<carrier><flight><class><date><citypair>   direct query
 *
 * Verbatim PDF examples:
 *   4G1*                        — display seat map for segment 1
 *   4G*LH1364F2NOVLGALHR        — direct, LH 1364 / class F / 2 NOV / LGA-LHR
 *
 * The seat-request side of the 4G family (4G<n>/<seat>-<name>, 4GA/<loc>,
 * etc.) is a separate verb — deferred to a follow-up chunk; only display
 * forms parse to `SeatMapEntry` for v1.
 */

import type { SeatMapEntry } from '../entry.js';
import { ParseError } from '../errors.js';

const SEGMENT = /^4G(\d{1,2})\*$/;
// Direct: 4G* + carrier(2) + flight(1-4) + class(1) + date(DDMON) + citypair(6)
const DIRECT = /^4G\*([A-Z0-9]{2})(\d{1,4})([A-Z])(\d{1,2}[A-Z]{3})([A-Z]{6})$/;

export function parseSeatMap(raw: string): SeatMapEntry {
  const u = raw.toUpperCase();
  const base = { kind: 'seat_map' as const, raw, timestamp: new Date() };

  const seg = SEGMENT.exec(u);
  if (seg) {
    return { ...base, source: 'segment', segment: parseInt(seg[1], 10) };
  }

  const direct = DIRECT.exec(u);
  if (direct) {
    return {
      ...base,
      source: 'direct',
      carrier: direct[1],
      flightNumber: direct[2],
      bookingClass: direct[3],
      date: direct[4],
      origin: direct[5].slice(0, 3),
      destination: direct[5].slice(3, 6),
    };
  }

  throw new ParseError(`Seat map: bad format "${raw}"`);
}
