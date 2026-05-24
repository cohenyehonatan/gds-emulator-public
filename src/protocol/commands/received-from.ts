/**
 * Received-from entry (sigil '6').  e.g. 6NIGEL  (workbook p.6)
 * The last mandatory field before End Transaction is permitted.
 */

import type { ReceivedFromEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parseReceivedFrom(raw: string): ReceivedFromEntry {
  const text = raw.slice(1).trim();
  if (text.length === 0) throw new ParseError(`Received from: empty entry "${raw}"`);
  return { kind: 'received_from', raw, timestamp: new Date(), text };
}
