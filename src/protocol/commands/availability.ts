/**
 * Availability entry (sigil '1').
 *
 * Format (workbook p.6):  1(date)(citypair)[time]
 *   122JANFRAMAD          → avail 22JAN FRA-MAD
 *   123SEPLOSJNB2030      → avail 3SEP LOS-JNB, prefer 2030
 *
 * TODO: schedule-only display ('1' variants), return-date, connections,
 * and the '1*' scroll handled by the parser as a DisplayEntry/own kind.
 */

import { parseSabreDate, isCityPair, splitCityPair } from '../../utils/validation.js';
import type { AvailabilityEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parseAvailability(raw: string): AvailabilityEntry {
  const base = { kind: 'availability' as const, raw, timestamp: new Date() };
  const u = raw.toUpperCase();
  if (u === '1*') return { ...base, mode: 'more' };
  if (u === '1*R' || u === '1*OA') return { ...base, mode: 'redisplay' };

  // Return availability: 1R<date> or 1R¥<days> (reverses the last city pair).
  if (u.startsWith('1R')) {
    const after = raw.slice(2);
    const days = /^¥(\d+)$/.exec(after);
    if (days) return { ...base, mode: 'return', returnDays: parseInt(days[1], 10) };
    const d = parseSabreDate(after);
    if (d && d.length === after.length) return { ...base, mode: 'return', date: d.date };
    throw new ParseError(`Availability return: bad "${raw}"`);
  }

  const args = raw.slice(1); // drop leading '1'
  const dateMatch = parseSabreDate(args);
  if (!dateMatch) throw new ParseError(`Availability: bad date in "${raw}"`);

  const rest = args.slice(dateMatch.length);
  const cityPair = rest.slice(0, 6);
  if (!isCityPair(cityPair)) throw new ParseError(`Availability: bad city pair in "${raw}"`);
  const { origin, destination } = splitCityPair(cityPair);

  // Tail may carry a time, a class qualifier ("-Y"), and/or a preferred-airline
  // qualifier ("¥AA" or "¥UADLBA"). The airline qualifier comes last.
  let tail = rest.slice(6);

  let carriers: string[] | undefined;
  const carrierMatch = /¥([A-Z0-9]{2,})/.exec(tail); // IATA codes are 2 alphanumeric (e.g. B6, U2)
  if (carrierMatch) {
    carriers = carrierMatch[1].match(/.{2}/g) ?? undefined; // split into 2-letter codes
    tail = tail.slice(0, carrierMatch.index) + tail.slice(carrierMatch.index + carrierMatch[0].length);
  }

  let bookingClass: string | undefined;
  const classMatch = /-([A-Z])$/.exec(tail);
  if (classMatch) {
    bookingClass = classMatch[1];
    tail = tail.slice(0, classMatch.index);
  }

  const time = tail.replace(/[^0-9AP].*$/i, '') || undefined; // leading clock token

  return { ...base, mode: 'display', date: dateMatch.date, origin, destination, time, bookingClass, carriers };
}
