/**
 * Phone entry (sigil '9').  e.g. 9415-555-2121-H  (workbook p.6)
 * Trailing letter is the phone type (H home, B business, etc.).
 * TODO (later): city-prefixed contact (9NYC...), change (91¤...).
 */

import type { PhoneEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parsePhone(raw: string): PhoneEntry {
  const text = raw.slice(1).trim();
  if (text.length === 0) throw new ParseError(`Phone: empty entry "${raw}"`);
  return { kind: 'phone', raw, timestamp: new Date(), text };
}
