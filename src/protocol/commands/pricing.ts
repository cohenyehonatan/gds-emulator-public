/**
 * Pricing entries (sigil "WP" — Sabre Air Pricing).  (Basic Pricing QR)
 *   WP     price the current itinerary as booked (lowest fare for booked classes)
 *   WP*    redisplay the last pricing response
 *   WPNC   bargain finder — advise the lowest available class
 *   WPNCS  lowest fare regardless of availability
 *   WPNCB  rebook into the lowest available class
 *   WPP…   passenger-type pricing (WPPADT/C05/INF)
 *   WPS…   segment selection (WPS1-3/5)
 *   WPRQ   price as booked and store a PQ record
 *   PQ     store the last pricing response as a PQ record (*PQ displays them)
 *
 * TODO (ROADMAP): name qualifier ¥N… and ¥-combined qualifiers.
 */

import type { PricingEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parsePricing(raw: string): PricingEntry {
  const u = raw.toUpperCase();
  const base = { kind: 'pricing' as const, raw, timestamp: new Date() };
  switch (u) {
    case 'WP':
      return { ...base, mode: 'price' };
    case 'WP*':
      return { ...base, mode: 'redisplay' };
    case 'WPNC': // advise the lowest available class
      return { ...base, mode: 'bargain', rebook: false, ignoreAvailability: false };
    case 'WPNCS': // lowest fare regardless of availability
      return { ...base, mode: 'bargain', rebook: false, ignoreAvailability: true };
    case 'WPNCB': // rebook into the lowest available class
      return { ...base, mode: 'bargain', rebook: true, ignoreAvailability: false };
    case 'WPRQ': // price as booked and store a PQ record
      return { ...base, mode: 'price', store: true };
    case 'PQ': // store the last pricing response as a PQ record
      return { ...base, mode: 'store' };
  }

  // WPP<type>/<type>… — price specific passenger types.
  if (u.startsWith('WPP')) {
    const types = u
      .slice(3)
      .split('/')
      .map((t) => t.trim())
      .filter(Boolean);
    if (types.length === 0) throw new ParseError(`Pricing: no passenger types in "${raw}"`);
    return { ...base, mode: 'price', passengerTypes: types };
  }

  // WPS<segspec> — price selected segments (N, N-M, lists with /).
  if (u.startsWith('WPS')) {
    return { ...base, mode: 'price', segments: parseSegmentSpec(u.slice(3), raw) };
  }

  throw new ParseError(`Pricing: unsupported format "${raw}"`);
}

/** Parse a segment selection like "1-3/5" into [1,2,3,5]. */
function parseSegmentSpec(spec: string, raw: string): number[] {
  const out: number[] = [];
  for (const part of spec.split('/')) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const from = parseInt(range[1], 10);
      const to = parseInt(range[2], 10);
      if (to < from) throw new ParseError(`Pricing: bad segment range "${raw}"`);
      for (let n = from; n <= to; n++) out.push(n);
    } else if (/^\d+$/.test(part)) {
      out.push(parseInt(part, 10));
    } else {
      throw new ParseError(`Pricing: bad segment spec "${raw}"`);
    }
  }
  if (out.length === 0) throw new ParseError(`Pricing: empty segment spec "${raw}"`);
  return out;
}
