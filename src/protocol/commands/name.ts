/**
 * Name entry (sigil '-').  e.g. -ALONSO/EDITH  (workbook p.6)
 * Format: -(surname)/(first name)[(title)]
 * TODO (later): multi-name (-2SMITH/JOHN/JANE), infants (I/), name remarks.
 */

import type { NameEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parseName(raw: string): NameEntry {
  const text = raw.slice(1).trim();
  if (!text.includes('/')) throw new ParseError(`Name: expected SURNAME/FIRST in "${raw}"`);
  return { kind: 'name', raw, timestamp: new Date(), text };
}
