/**
 * Galileo cryptic-entry parser.
 *
 * Mirrors the architecture of `src/protocol/parser.ts` (Sabre): an ordered
 * prefix-match dispatch table feeding per-verb parsers. Returns the same
 * `ParsedEntry` discriminated kinds Sabre uses — sign_in, sign_out, etc.
 * Galileo and Sabre share the semantic operation set but parse different
 * cryptic surface syntax.
 *
 * Source: `references/galileo/Travelport-Mini-Format-Guide-v2.pdf` (Oct
 * 2025, canonical) and `Galileo-Pocket-Guide.pdf` (2009, supplementary
 * legacy verbs). Forms implemented here:
 *
 *   SON / Z<usercode>       Sign on at own office (Mini Guide p.5)
 *   SOF                     Sign off (Mini Guide p.6)
 *   SOF / Z<override>       Sign off with override (Pocket Guide p.2)
 *
 * Whitespace tolerance: the source examples sometimes show `SON / ZHA`
 * with spaces around the slash for readability. The parser strips
 * whitespace inside the entry before matching.
 *
 * Unimplemented Galileo verbs (deferred): SAI (sign back in), SB/SA/SC/...
 * (work-area switch), OP/W* (active work area), SEM (emulate PCC),
 * STD/Z... (security profile), #RESTART, #DELETEPLUGIN — all land as a
 * `ParseError` which the dialect surfaces as `FORMAT` until they're wired.
 */

import type {
  ParsedEntry,
  SignInEntry,
  SignOutEntry,
  SwitchAreaEntry,
  AvailabilityEntry,
  SellEntry,
  NameEntry,
  PhoneEntry,
  TicketingEntry,
  ReceivedFromEntry,
  EndTransactionEntry,
  IgnoreEntry,
} from '../../protocol/entry.js';
import { parseSabreDate } from '../../utils/validation.js';
import { ParseError } from '../../protocol/errors.js';

/** Galileo's documented area letters (Mini Guide v2 p.5: A-E). */
const GALILEO_AREA_LETTERS = new Set(['A', 'B', 'C', 'D', 'E']);

export function parseGalileoEntry(raw: string): ParsedEntry {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new ParseError('Empty entry');
  const upper = trimmed.toUpperCase();

  // `.`-prefixed field entries — internal whitespace is meaningful
  // (`N.HENRIQUEZ/RUDY MR`), so we parse from `trimmed` not the
  // whitespace-stripped form used for the no-whitespace verbs below.
  if (upper.startsWith('N.')) return parseNameField(trimmed);
  if (upper.startsWith('P.')) return parsePhoneField(trimmed);
  if (upper.startsWith('T.')) return parseTicketingField(trimmed);
  if (upper.startsWith('R.')) return parseReceivedFromField(trimmed);

  // End / ignore verbs — pure letters, no internal whitespace expected.
  if (upper === 'E' || upper === 'ET') return parseEnd(trimmed, false);
  if (upper === 'ER') return parseEnd(trimmed, true);
  if (upper === 'I' || upper === 'IR') return parseIgnore(trimmed);

  // No-whitespace verbs: strip internal whitespace (`SON / ZHA` →
  // `SON/ZHA`) before sigil dispatch.
  const u = trimmed.replace(/\s+/g, '').toUpperCase();
  if (u.startsWith('SON/Z')) return parseSignOn(trimmed, u);
  if (u === 'SOF' || u.startsWith('SOF/Z')) return parseSignOff(trimmed, u);
  if (isAreaSwitch(u)) return parseAreaSwitch(trimmed, u);
  if (isAvailability(u)) return parseAvailability(trimmed, u);
  if (isSell(u)) return parseSell(trimmed, u);

  throw new ParseError(`Galileo: unrecognized entry "${trimmed}"`);
}

function parseSignOn(raw: string, u: string): SignInEntry {
  // u is "SON/Z<rest>"; capture rest (usercode, possibly preceded by PCC).
  // The 2009 Pocket Guide documents `SON/ZGL4HA` (PCC + initials); the
  // 2025 Mini Guide simplifies to `SON/Z<usercode>` (own office). For v1
  // we capture the raw remainder as `argument` — handlers can later split
  // PCC from initials if a downstream verb cares.
  const argument = u.slice('SON/Z'.length);
  if (argument.length === 0) throw new ParseError(`Galileo SON/Z: missing user code in "${raw}"`);
  return { kind: 'sign_in', raw, timestamp: new Date(), argument };
}

function parseSignOff(raw: string, u: string): SignOutEntry {
  // Plain `SOF` = sign off the current work area. `SOF/Z<override>` is the
  // override form from the Pocket Guide; the override token isn't acted
  // on (we don't model multi-area sign-on credentials yet), but parsing
  // it lets transcript replay survive.
  if (u !== 'SOF' && !u.startsWith('SOF/Z')) {
    throw new ParseError(`Galileo SOF: bad form "${raw}"`);
  }
  return { kind: 'sign_out', raw, timestamp: new Date(), allAreas: false };
}

/**
 * `SA`/`SB`/`SC`/`SD`/`SE` work-area switch (Mini Format Guide v2 p.5:
 * "SB — Change to work area B"). Galileo configures 5 areas, so `SF` is
 * an invalid letter and rejected here even though the WorkArea data
 * structure has a slot for it.
 *
 * `SO` would collide with Sabre's sign-out-all sigil and Galileo's
 * sign-off uses `SOF`, so we explicitly exclude `SO` from the area-
 * switch matcher to keep the surface unambiguous.
 */
function isAreaSwitch(u: string): boolean {
  if (u.length !== 2 || u[0] !== 'S') return false;
  return GALILEO_AREA_LETTERS.has(u[1]);
}

function parseAreaSwitch(raw: string, u: string): SwitchAreaEntry {
  return {
    kind: 'switch_area',
    raw,
    timestamp: new Date(),
    targetArea: u[1],
  };
}

/**
 * Availability entries. Source: Travelport+ Mini Format Guide v2 p.11
 * + Galileo Pocket Guide p.3. Forms covered in this commit:
 *
 *   A<DDMMM><orig><dest>            basic neutral availability
 *   A<DDMMM><orig><dest>/<carrier>  carrier-filtered
 *   AD/AJ/AA/AF<DDMMM><orig><dest>  sort-mode prefix (departure / journey
 *                                    / arrival / 7-day window) — accepted
 *                                    at the parser level, currently
 *                                    rendered as default sort since the
 *                                    inventory layer only orders by
 *                                    departure time
 *
 * Deferred for follow-up commits (parser will reject for now):
 *   - same-day A<orig><dest>        (no date — "today")
 *   - connection .SIN               (.<midpoint>)
 *   - time qualifier .1400          (after that time of day)
 *   - return AR<DDMMM>              (after a previous outbound)
 *   - date deltas A#, A-1, A+5      (scroll forward/back)
 *   - class filter @V               (booking-class restrictor)
 */
const AVAIL_RE = /^A([DJAF])?(\d{1,2}[A-Z]{3})([A-Z]{3})([A-Z]{3})(?:\/([A-Z0-9]+))?$/;

function isAvailability(u: string): boolean {
  return AVAIL_RE.test(u);
}

function parseAvailability(raw: string, u: string): AvailabilityEntry {
  const m = AVAIL_RE.exec(u)!;
  const [, _sortMode, dateTok, origin, destination, carrier] = m;
  const parsed = parseSabreDate(dateTok);
  if (!parsed) throw new ParseError(`Galileo: bad date "${dateTok}" in "${raw}"`);
  return {
    kind: 'availability',
    raw,
    timestamp: new Date(),
    mode: 'display',
    date: parsed.date,
    origin,
    destination,
    carriers: carrier ? [carrier] : undefined,
  };
}

/**
 * Sell entries. Source: Mini Format Guide v2 p.12 + Pocket Guide p.3:
 *
 *   N<seats><class><line>           basic single-segment sell
 *                                    e.g. N1Y1 (1 seat Y class line 1)
 *
 * Deferred for follow-up commits:
 *   - multi-leg connecting form     N2F1F2Y3
 *   - sell-with-star-connections    N1C5*
 *   - waitlist if unavailable       (Mini Guide / Pocket Guide both
 *                                    document this implicitly)
 *   - ARNK segments                 0A
 *   - direct/long sell              (no availability cache needed)
 */
const SELL_RE = /^N(\d+)([A-Z])(\d+)$/;

function isSell(u: string): boolean {
  return SELL_RE.test(u);
}

function parseSell(raw: string, u: string): SellEntry {
  const m = SELL_RE.exec(u)!;
  const [, seatsStr, bookingClass, lineStr] = m;
  const seats = parseInt(seatsStr, 10);
  const line = parseInt(lineStr, 10);
  if (seats <= 0) throw new ParseError(`Galileo: zero seats in "${raw}"`);
  if (line <= 0) throw new ParseError(`Galileo: zero line in "${raw}"`);
  return {
    kind: 'sell',
    raw,
    timestamp: new Date(),
    mode: 'availability',
    seats,
    bookingClass,
    line,
  };
}

/**
 * `N.<surname>/<given>[<title>]` — name field. Source: Mini Format
 * Guide v2 p.14-15. The text after the `.` is forwarded to the shared
 * NameItem parser (same shape as Sabre's `-<surname>/<given>`),
 * so multi-traveler counts (`N.3MAJA/...`), the infant prefix `I/`,
 * passenger-type-code remarks (`*P-C08`), and DOB suffixes ride
 * through unchanged.
 *
 * Galileo-specific verbs that look like name entries but aren't
 * straight pushes — `N.P1@`, `N.P2@SMITH/...`, `N.P5-6@...` (delete /
 * change passenger) — fall under modify and are deferred to a follow-
 * up commit; we currently route them through the name handler which
 * will produce a malformed NameItem. Flag.
 */
function parseNameField(raw: string): NameEntry {
  const text = raw.slice(2).trim(); // strip "N."
  if (!text.includes('/')) {
    throw new ParseError(`Galileo N.: expected SURNAME/GIVEN in "${raw}"`);
  }
  return { kind: 'name', raw, timestamp: new Date(), text };
}

/**
 * `P.<rest>` — phone / contact field. Source: Mini Format Guide v2
 * p.16. Galileo's phone field is wider than Sabre's — it carries
 * agency contacts, hotel numbers, and email addresses — so the parser
 * just captures the raw remainder; the handler stores it as-is in
 * the PNR without trying to split city/number/type the way Sabre's
 * parsePhoneText does.
 */
function parsePhoneField(raw: string): PhoneEntry {
  const text = raw.slice(2).trim();
  if (text.length === 0) throw new ParseError(`Galileo P.: empty phone field in "${raw}"`);
  return { kind: 'phone', raw, timestamp: new Date(), text };
}

/**
 * `T.<rest>` — ticketing / time-limit field. Source: Mini Format
 * Guide v2 p.16. Forms documented:
 *
 *   T.T*                    minimum ticketing input
 *   T.TAU/10FEB             to ticketing queue 10 on 10FEB
 *   T.TAU/12JUN*ISSUE TKT   with remark
 *   T.@TAU/08MAR            change ticketing field
 *
 * Parser just captures the raw remainder; the handler stores it on
 * the PNR.
 */
function parseTicketingField(raw: string): TicketingEntry {
  const text = raw.slice(2).trim();
  if (text.length === 0) throw new ParseError(`Galileo T.: empty ticketing field in "${raw}"`);
  return { kind: 'ticketing', raw, timestamp: new Date(), text };
}

/**
 * `R.<rest>` — received from field. Source: Mini Format Guide v2 p.16.
 * Documented forms: `R.AGT`, `R.YY`. Parser captures the raw text.
 */
function parseReceivedFromField(raw: string): ReceivedFromEntry {
  const text = raw.slice(2).trim();
  if (text.length === 0) throw new ParseError(`Galileo R.: empty received-from in "${raw}"`);
  return { kind: 'received_from', raw, timestamp: new Date(), text };
}

/**
 * `E`/`ET` end transaction (save BF), `ER` end + retrieve same BF.
 * Source: Mini Format Guide v2 p.17.
 */
function parseEnd(raw: string, redisplay: boolean): EndTransactionEntry {
  return { kind: 'end_transaction', raw, timestamp: new Date(), redisplay };
}

/**
 * `I` ignore, `IR` ignore + retrieve previously saved BF.
 * Source: Mini Format Guide v2 p.17. The retrieve side of IR is
 * deferred — both forms currently clear the work area without the
 * subsequent retrieve.
 */
function parseIgnore(raw: string): IgnoreEntry {
  return { kind: 'ignore', raw, timestamp: new Date() };
}
