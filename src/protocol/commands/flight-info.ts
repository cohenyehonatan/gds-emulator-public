/**
 * Flight information (FLIFO / verify).  (workbook ICK key 2; Zenon "Verify Flights")
 *   2UA2550/17OCT   FLIFO by flight number
 *   V*CY312/10MAR   verify by flight number
 *   VA*1 / VA*1-3   verify from availability line(s)
 *   VI*1 / VI* / VI*1-3   verify itinerary segment(s) (empty = all)
 */

import type { FlightInfoEntry } from '../entry.js';
import { ParseError } from '../errors.js';

const BY_FLIGHT = /^(?:2|V\*)([A-Z0-9]{2})(\d{1,4})(?:\/(\d{1,2}[A-Z]{3}))?$/;

/** Parse a number list like "1-3/5" → [1,2,3,5]. */
function parseSpec(spec: string, raw: string): number[] {
  const out: number[] = [];
  for (const part of spec.split('/')) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      for (let n = parseInt(range[1], 10); n <= parseInt(range[2], 10); n++) out.push(n);
    } else if (/^\d+$/.test(part)) {
      out.push(parseInt(part, 10));
    } else {
      throw new ParseError(`Flight info: bad spec "${raw}"`);
    }
  }
  return out;
}

export function parseFlightInfo(raw: string): FlightInfoEntry {
  const u = raw.toUpperCase();
  const base = { kind: 'flight_info' as const, raw, timestamp: new Date() };

  const vct = /^VCT\*(.*)$/.exec(u);
  if (vct) return { ...base, source: 'connect', lines: vct[1] ? parseSpec(vct[1], raw) : undefined };

  const va = /^VA\*(.+)$/.exec(u);
  if (va) return { ...base, source: 'availability', lines: parseSpec(va[1], raw) };

  const vi = /^VI\*(.*)$/.exec(u);
  if (vi) return { ...base, source: 'itinerary', lines: vi[1] ? parseSpec(vi[1], raw) : undefined };

  const f = BY_FLIGHT.exec(u);
  if (f) return { ...base, source: 'flight', carrier: f[1], flightNumber: f[2], date: f[3] };

  throw new ParseError(`Flight info: unsupported format "${raw}"`);
}
