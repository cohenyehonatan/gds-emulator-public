/**
 * Sell-segment entry (sigil '0').
 *
 * Availability sell (Selling Air Reservations QR):
 *   0(seats)(class)(line)        01Y1     sell from CPA line
 *   0(seats)(class)(line)LL      01V2LL   waitlist from CPA line (→ HL at ET)
 *
 * Direct / long sell, passive, and open (workbook "LONG SELL" / "PASSIVE"):
 *   0(carrier)(flight)(class)(date)(citypair)(status)(seats)[*locator]
 *     0BA074Y14FEBLOSLHRNN2            long sell (status NN)
 *     0VS651Y6OCTLHRLOSGK1*AB123C      passive (GK/BK) + airline locator
 *   0(carrier)OPEN(class)(date)(citypair)DS(seats)
 *     0AFOPENJ9JULLOSCDGDS2            open segment
 *
 * TODO (ROADMAP): connection sells 01K1* and 01L1K2.
 */

import { isBookingClass, parseSabreDate, splitCityPair } from '../../utils/validation.js';
import type { SellEntry } from '../entry.js';
import { ParseError } from '../errors.js';

const AVAIL_RE = /^0(\d+)([A-Z])(\d+)(LL)?$/; // 0 seats class line [LL]
// 0 carrier flight|OPEN class date citypair status seats [*locator]
const DIRECT_RE = /^0([A-Z]{2})(\d{1,4}|OPEN)([A-Z])(\d{1,2}[A-Z]{3})([A-Z]{6})([A-Z]{2})(\d{1,2})(?:\*([A-Z0-9]+))?$/;

export function parseSell(raw: string): SellEntry {
  const base = { kind: 'sell' as const, raw, timestamp: new Date() };

  const a = AVAIL_RE.exec(raw);
  if (a) {
    const bookingClass = a[2];
    if (!isBookingClass(bookingClass)) throw new ParseError(`Sell: bad class "${bookingClass}"`);
    return {
      ...base,
      mode: 'availability',
      seats: parseInt(a[1], 10),
      bookingClass,
      line: parseInt(a[3], 10),
      waitlist: a[4] === 'LL',
    };
  }

  const d = DIRECT_RE.exec(raw);
  if (d) {
    const [, carrier, flight, bookingClass, dateTok, cityPair, status, seats, locator] = d;
    const dm = parseSabreDate(dateTok);
    if (!dm) throw new ParseError(`Sell: bad date "${dateTok}" in "${raw}"`);
    const { origin, destination } = splitCityPair(cityPair);
    const open = flight === 'OPEN';
    return {
      ...base,
      mode: 'direct',
      seats: parseInt(seats, 10),
      bookingClass,
      carrier,
      flightNumber: open ? undefined : flight,
      open,
      date: dm.date,
      origin,
      destination,
      status,
      airlineLocator: locator,
    };
  }

  throw new ParseError(`Sell: unsupported format "${raw}"`);
}
