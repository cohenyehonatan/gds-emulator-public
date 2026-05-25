/**
 * Pricing entries (sigil "WP" — Sabre Air Pricing).  (Basic Pricing QR)
 *   WP    price the current itinerary as booked (lowest fare for booked classes)
 *   WP*   redisplay the last pricing response
 *
 * TODO (ROADMAP): bargain finder WPNC/WPNCS/WPNCB, passenger-type and
 * segment/name qualifiers (WPP…, WPS…, ¥N…), stored PQ records.
 */

import type { PricingEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parsePricing(raw: string): PricingEntry {
  const u = raw.toUpperCase();
  if (u === 'WP') return { kind: 'pricing', raw, timestamp: new Date(), mode: 'price' };
  if (u === 'WP*') return { kind: 'pricing', raw, timestamp: new Date(), mode: 'redisplay' };
  throw new ParseError(`Pricing: unsupported format "${raw}" (v2 foundation supports WP, WP*)`);
}
