/**
 * Frequent-flyer entry (prefix FF).  (Zenon "Frequent Traveller Numbers")
 *   FFBA2345678-2.2     add: carrier BA, FQTV 2345678, passenger 2.2
 *   FF1¤CY123456-1.2    change frequent-flyer line 1
 *   FF1¤                delete frequent-flyer line 1
 */

import type { FrequentFlyerEntry } from '../entry.js';
import { ParseError } from '../errors.js';
import { CHANGE } from '../keyboard.js';

const DATA_RE = /^([A-Z0-9]{2})([A-Z0-9]+)(?:-(\d+)(?:\.(\d+))?)?$/;

function parseData(s: string): Pick<FrequentFlyerEntry, 'carrier' | 'number' | 'nameRef'> {
  const m = DATA_RE.exec(s);
  if (!m) throw new ParseError(`Frequent flyer: bad data "${s}"`);
  return {
    carrier: m[1],
    number: m[2],
    nameRef: m[3] ? { item: parseInt(m[3], 10), passenger: m[4] ? parseInt(m[4], 10) : undefined } : undefined,
  };
}

export function parseFrequentFlyer(raw: string): FrequentFlyerEntry {
  const body = raw.slice(2); // after "FF"
  const base = { kind: 'frequent_flyer' as const, raw, timestamp: new Date() };

  const ci = body.indexOf(CHANGE);
  if (ci !== -1) {
    const line = parseInt(body.slice(0, ci), 10);
    if (!Number.isInteger(line)) throw new ParseError(`Frequent flyer: bad line in "${raw}"`);
    const data = body.slice(ci + 1).trim();
    if (data.length === 0) return { ...base, operation: 'delete', line };
    return { ...base, operation: 'change', line, ...parseData(data) };
  }

  return { ...base, operation: 'add', ...parseData(body) };
}
