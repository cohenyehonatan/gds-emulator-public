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
import { parseModify, isModifyEntry } from './commands/modify.js';
import { parseService } from './commands/service.js';
import { parsePricing } from './commands/pricing.js';
import { parseRemark } from './commands/remark.js';
import { parseTimeLimit } from './commands/time-limit.js';
import { parseFrequentFlyer } from './commands/frequent-flyer.js';
import { parseFlightInfo } from './commands/flight-info.js';
import { parseMove } from './commands/move.js';
import { parseDivide, parseFile } from './commands/divide.js';
import { parseQueue } from './commands/queue.js';
import { parseTicket } from './commands/ticket.js';
import { parseAuditTrail } from './commands/audit-trail.js';
import { parseRefund, parseCancelRefund } from './commands/refund.js';
import { parseAccounting } from './commands/accounting.js';
import { parseTicketDocumentDisplay } from './commands/ticket-display.js';

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
  { match: startsWith('AC¤'), parse: parseAccounting }, // accounting-line delete (¤ separator)
  { match: startsWith('AC/'), parse: parseAccounting }, // accounting-line add (manual)
  { match: (raw) => /^AC\d+\//.test(raw), parse: parseAccounting }, // accounting-line modify
  { match: startsWith('SI'), parse: parseSignIn },
  { match: startsWith('SO'), parse: parseSignOut },
  { match: startsWith('WP'), parse: parsePricing },
  { match: startsWith('WFR'), parse: parseRefund }, // WFR/WFRT refunds — before bare W ticketing
  { match: startsWith('WTRX'), parse: parseCancelRefund }, // WTRX cancel refund — before bare W
  { match: startsWith('WETR*'), parse: parseTicketDocumentDisplay }, // ETR display
  { match: startsWith('WTDB*'), parse: parseTicketDocumentDisplay }, // ticket-image display
  { match: startsWith('W'), parse: parseTicket }, // W¥ ticketing (after WP pricing)
  { match: startsWith('TTP'), parse: parseTicket }, // issue all (synonym for W¥)
  { match: equals('PQ'), parse: parsePricing },
  { match: startsWith('FF'), parse: parseFrequentFlyer },
  { match: startsWith('V'), parse: parseFlightInfo }, // V* / VA* / VI* flight info
  { match: equals('ER'), parse: parseEndTransaction },
  { match: equals('ET'), parse: parseEndTransaction },
  { match: equals('E'), parse: parseEndTransaction },
  { match: equals('IG'), parse: parseIgnore },
  { match: equals('I'), parse: parseIgnore },
  { match: equals('F'), parse: parseFile }, // file a divided PNR
  { match: startsWith('DQB'), parse: parseAuditTrail }, // audit trail before D-divide
  { match: firstChar('D'), parse: parseDivide }, // divide a PNR
  { match: firstChar('Q'), parse: parseQueue }, // queue place/access/work
  // Field change/delete via '¤' must beat the plain field sigils below.
  { match: isModifyEntry, parse: parseModify },
  // Single-char sigils.
  { match: firstChar('1'), parse: parseAvailability },
  { match: firstChar('2'), parse: parseFlightInfo }, // FLIFO
  { match: firstChar('0'), parse: parseSell },
  { match: firstChar('-'), parse: parseName },
  { match: firstChar('9'), parse: parsePhone },
  { match: firstChar('7'), parse: parseTicketing },
  { match: firstChar('8'), parse: parseTimeLimit },
  { match: firstChar('6'), parse: parseReceivedFrom },
  { match: firstChar('5'), parse: parseRemark }, // remarks
  { match: firstChar('3'), parse: parseService }, // SSR / OSI (other airlines)
  { match: firstChar('4'), parse: parseService }, // SSR / OSI (American)
  { match: firstChar('*'), parse: parseDisplay },
  { match: firstChar('X'), parse: parseCancel },
  { match: firstChar('.'), parse: parseSegmentStatus },
  { match: firstChar('/'), parse: parseMove }, // move/insert segments
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
