/**
 * Cryptic-entry parser.
 *
 * Sabre entries are sigil-prefixed free-form strings (not fixed-width AEA
 * codes), so dispatch is by LONGEST-PREFIX sigil match: multi-char sigils
 * (SI, SO, IG, ER, ET) are tried before single-char ones, and the alphabetic
 * E-family is matched before falling through.
 *
 * Each handler receives the full raw string (including its sigil) and returns
 * a discriminated ParsedEntry. Unknown leading characters → ParseError, which
 * the host surfaces as the canned "FORMAT" response.
 */

import type { ParsedEntry } from './entry.js';
import { ParseError } from './errors.js';
import { parseAvailability } from './commands/availability.js';
import { parseSell } from './commands/sell.js';
import { parseName } from './commands/name.js';
import { parsePhone } from './commands/phone.js';
import { parseTicketing } from './commands/ticketing.js';
import { parseReceivedFrom } from './commands/received-from.js';
import { parseEndTransaction } from './commands/end-tx.js';
import { parseDisplay } from './commands/retrieve.js';
import { parseIgnore } from './commands/ignore.js';
import { parseSignIn, parseSignOut } from './commands/signin.js';
import { parseCancel } from './commands/cancel.js';
import { parseSegmentStatus } from './commands/segment-status.js';

type EntryParser = (raw: string) => ParsedEntry;

/**
 * Ordered dispatch table. Each rule matches on a prefix; the first match in
 * declaration order wins, so multi-char and more-specific rules come first.
 */
interface DispatchRule {
  match: (raw: string) => boolean;
  parse: EntryParser;
}

const startsWith = (p: string) => (raw: string) => raw.toUpperCase().startsWith(p);
const equals = (p: string) => (raw: string) => raw.toUpperCase() === p;
const firstChar = (c: string) => (raw: string) => raw.startsWith(c);

const RULES: DispatchRule[] = [
  // Multi-char alphabetic sigils first (longest / most specific).
  { match: startsWith('SI'), parse: parseSignIn },
  { match: equals('SO'), parse: parseSignOut },
  { match: equals('ER'), parse: parseEndTransaction },
  { match: equals('ET'), parse: parseEndTransaction },
  { match: equals('E'), parse: parseEndTransaction },
  { match: equals('IG'), parse: parseIgnore },
  { match: equals('I'), parse: parseIgnore },
  // Single-char sigils.
  { match: firstChar('1'), parse: parseAvailability },
  { match: firstChar('0'), parse: parseSell },
  { match: firstChar('-'), parse: parseName },
  { match: firstChar('9'), parse: parsePhone },
  { match: firstChar('7'), parse: parseTicketing },
  { match: firstChar('6'), parse: parseReceivedFrom },
  { match: firstChar('*'), parse: parseDisplay },
  { match: firstChar('X'), parse: parseCancel },
  { match: firstChar('.'), parse: parseSegmentStatus },
];

export function parseEntry(raw: string): ParsedEntry {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new ParseError('Empty entry');

  for (const rule of RULES) {
    if (rule.match(trimmed)) return rule.parse(trimmed);
  }

  throw new ParseError(`Unrecognized entry: "${trimmed}"`);
}

export { ParseError };
