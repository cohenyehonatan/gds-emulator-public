/**
 * Sabre work-area switch parser (`¤<letter>`).
 * Source: Sabre Basic Reservation Course p.7 verbatim:
 *
 *   ¤(work area letter)     Change to a different work area: A,B,C,D,E, or F
 *   ¤D                      example
 *
 * The change-key `¤` maps from ASCII `[` via the keyboard layer, so
 * the parser sees `¤<letter>` already glyph-normalized.
 *
 * Sister verbs `*S` (display current area) and `*S*` (display all area
 * statuses) are documented on the same QR page but not yet wired —
 * they fall through to the retrieve handler and currently get a
 * `RECORD LOCATOR NOT FOUND`. Deferred to a follow-up commit.
 */

import type { SwitchAreaEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parseSwitchArea(raw: string): SwitchAreaEntry {
  // Format: ¤<letter> — single letter from the configured area set.
  // Validation of which letters are legal happens at WorkArea.switchTo;
  // the parser only enforces "exactly one letter after the sigil".
  const m = /^¤([A-Z])$/i.exec(raw);
  if (!m) throw new ParseError(`Switch area: expected ¤<letter> in "${raw}"`);
  return {
    kind: 'switch_area',
    raw,
    timestamp: new Date(),
    targetArea: m[1].toUpperCase(),
  };
}
