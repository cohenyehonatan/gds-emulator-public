/**
 * Sell-segment entry (sigil '0').
 *
 * Format (Selling Air Reservations QR, workbook p.11):
 *   0(nbr of seats)(class of service)(CPA line nbr)
 *   01Y1   → sell 1 seat, Y class, availability line 1
 *
 * TODO (later): connection sell (01Y1*, 01Y1F2), waitlist (...LL),
 * long sell by flight number, passive (GK/BK), open segments.
 */

import { isBookingClass } from '../../utils/validation.js';
import type { SellEntry } from '../entry.js';
import { ParseError } from '../errors.js';

const SHORT_SELL_RE = /^0(\d+)([A-Z])(\d+)$/; // 0 seats class line

export function parseSell(raw: string): SellEntry {
  const m = SHORT_SELL_RE.exec(raw);
  if (!m) throw new ParseError(`Sell: unsupported format "${raw}" (v1 supports 0<seats><class><line>)`);

  const seats = parseInt(m[1], 10);
  const bookingClass = m[2];
  const line = parseInt(m[3], 10);
  if (!isBookingClass(bookingClass)) throw new ParseError(`Sell: bad class "${bookingClass}"`);

  return { kind: 'sell', raw, timestamp: new Date(), seats, bookingClass, line };
}
