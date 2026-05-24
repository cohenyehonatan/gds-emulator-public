/**
 * Display / retrieve entry (sigil '*').  (workbook p.6)
 *   *ABCDEF   retrieve PNR by record locator
 *   *-SANCHEZ retrieve by surname
 *   *A        redisplay all  (*I itinerary, *N names, *P phones, *T ticketing)
 *
 * This parser just captures the argument; the retrieve handler decides
 * locator vs. name vs. section redisplay.
 */

import type { DisplayEntry } from '../entry.js';

export function parseDisplay(raw: string): DisplayEntry {
  return { kind: 'display', raw, timestamp: new Date(), argument: raw.slice(1).trim() };
}
