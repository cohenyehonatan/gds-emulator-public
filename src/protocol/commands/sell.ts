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
 * Connection sells (01Y1* full-connection, 01Y1F2 explicit per-leg
 * classes) are landed — parsed here via the trailing `*` / class-line
 * pairs and exercised in test/session/connections.test.ts.
 */

import { isBookingClass, parseSabreDate, splitCityPair } from '../../utils/validation.js';
import type { SellEntry } from '../entry.js';
import { ParseError } from '../errors.js';

// 0 seats (class line)+ [LL] [*]   e.g. 01Y1, 01Y1F2, 01Y2K3LL, 01Y1*, 01Y1LL*
const AVAIL_RE = /^0(\d+)((?:[A-Z]\d+)+)(LL)?(\*)?$/;
// 0 carrier flight|OPEN class date citypair status seats [*locator]
const DIRECT_RE = /^0([A-Z]{2})(\d{1,4}|OPEN)([A-Z])(\d{1,2}[A-Z]{3})([A-Z]{6})([A-Z]{2})(\d{1,2})(?:\*([A-Z0-9]+))?$/;

export function parseSell(raw: string): SellEntry {
  const base = { kind: 'sell' as const, raw, timestamp: new Date() };

  const a = AVAIL_RE.exec(raw);
  if (a) {
    const legs = [...a[2].matchAll(/([A-Z])(\d+)/g)].map((m) => ({
      bookingClass: m[1],
      line: parseInt(m[2], 10),
    }));
    for (const leg of legs) {
      if (!isBookingClass(leg.bookingClass)) throw new ParseError(`Sell: bad class "${leg.bookingClass}"`);
    }
    return {
      ...base,
      mode: 'availability',
      seats: parseInt(a[1], 10),
      bookingClass: legs[0].bookingClass,
      line: legs[0].line,
      legs,
      waitlist: a[3] === 'LL',
      connectionStar: a[4] === '*',
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
