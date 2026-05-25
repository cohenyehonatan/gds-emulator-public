/**
 * Pricing entries (sigil "WP" — Sabre Air Pricing).  (Basic Pricing QR)
 *   WP     price the current itinerary as booked (lowest fare for booked classes)
 *   WP*    redisplay the last pricing response
 *   WPNC   bargain finder — advise the lowest available class
 *   WPNCS  lowest fare regardless of availability
 *   WPNCB  rebook into the lowest available class
 *
 * TODO (ROADMAP): passenger-type and segment/name qualifiers (WPP…, WPS…,
 * ¥N…), stored PQ records.
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
    default:
      throw new ParseError(`Pricing: unsupported format "${raw}"`);
  }
}
