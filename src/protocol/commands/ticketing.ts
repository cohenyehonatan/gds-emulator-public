/**
 * Ticketing-arrangement entry (sigil '7').  e.g. 7TAW22JAN/  (workbook p.6)
 *   TAW = ticket-as-instructed by a date.  '7T-' is "ticketed".
 * TODO (later): queue placement on the ticketing field, TAW with PCC.
 */

import type { TicketingEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parseTicketing(raw: string): TicketingEntry {
  const text = raw.slice(1).trim();
  if (text.length === 0) throw new ParseError(`Ticketing: empty entry "${raw}"`);
  return { kind: 'ticketing', raw, timestamp: new Date(), text };
}
