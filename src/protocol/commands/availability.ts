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
  const args = raw.slice(1); // drop leading '1'
  const dateMatch = parseSabreDate(args);
  if (!dateMatch) throw new ParseError(`Availability: bad date in "${raw}"`);

  let rest = args.slice(dateMatch.length);
  const cityPair = rest.slice(0, 6);
  if (!isCityPair(cityPair)) throw new ParseError(`Availability: bad city pair in "${raw}"`);
  const { origin, destination } = splitCityPair(cityPair);

  const time = rest.slice(6).replace(/\D.*$/, '') || undefined; // leading digits only

  return {
    kind: 'availability',
    raw,
    timestamp: new Date(),
    date: dateMatch.date,
    origin,
    destination,
    time,
  };
}
