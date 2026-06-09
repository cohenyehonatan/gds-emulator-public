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
  DisplayEntry,
  CancelEntry,
  SegmentStatusEntry,
  PassiveCancelEntry,
  PricingEntry,
  TicketEntry,
  FlightInfoEntry,
  VoidEntry,
  QueueEntry,
  DivideEntry,
  SsrEntry,
  OsiEntry,
  RemarkEntry,
  TicketModifierEntry,
  FareDisplayEntry,
  FareNotesEntry,
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

  // `*`-prefixed retrieve / display. Internal whitespace is meaningful for
  // surname forms (`*- WILLIAMS/CHRIS MR` per Mini Guide p.17), so we
  // capture from `trimmed` rather than the whitespace-stripped form.
  if (upper.startsWith('*')) return parseDisplay(trimmed);

  // `@`-prefixed modify family (Mini Guide p.17). Single-token forms in
  // this commit: @<n>XK passive cancel, @<n>HK status change. Other
  // @-modifies (class rebook, date change, pax-count change) are
  // deferred and will trip the catch-all below.
  if (upper.startsWith('@')) return parseModify(trimmed, upper);

  // No-whitespace verbs: strip internal whitespace (`SON / ZHA` →
  // `SON/ZHA`) before sigil dispatch.
  const u = trimmed.replace(/\s+/g, '').toUpperCase();
  if (u.startsWith('SON/Z')) return parseSignOn(trimmed, u);
  if (u === 'SOF' || u.startsWith('SOF/Z')) return parseSignOff(trimmed, u);
  if (isAreaSwitch(u)) return parseAreaSwitch(trimmed, u);
  // X-family cancel — checked BEFORE availability so XI / XA aren't read
  // as availability-without-date (they wouldn't match the AVAIL_RE
  // anyway, but ordering keeps the intent explicit).
  if (u.startsWith('X')) return parseCancel(trimmed, u);
  // FQ / TKP must come BEFORE the regex-matching availability so they
  // don't get mis-parsed. (FQ doesn't match AVAIL_RE anyway, but the
  // ordering keeps intent explicit.)
  if (u === 'FQ') return parsePricing(trimmed);
  if (u.startsWith('TKP')) return parseTicketIssue(trimmed, u);
  if (/^TMU\d/.test(u)) return parseTicketModifier(trimmed, u);
  if (u.startsWith('FD')) return parseFareDisplay(trimmed, u);
  if (u === 'FQN' || /^FN[*0-9]/.test(u)) return parseFareNotes(trimmed, u);
  if (u.startsWith('PQ/')) return parsePastDateRetrieve(trimmed, u);
  if (u.startsWith('TRV/')) return parseVoid(trimmed, u);
  if (u.startsWith('QEB/')) return parseQueuePlaceEnd(trimmed, u);
  if (u.startsWith('Q/')) return parseQueueAccess(trimmed, u);
  if (u === 'QX' || u === 'QXI' || u === 'QXE' || u === 'QXIR' || u === 'QXER') {
    return parseQueueExit(trimmed, u);
  }
  if (u === 'QP' || u === 'QPI') return parseQueuePrevious(trimmed, u);
  if (u === 'QCA' || /^QCA\*\d+$/.test(u)) return parseQueueCountAll(trimmed, u);
  if (u === 'QW') return parseQueueWhere(trimmed);
  if (u === 'QPB*') return parseQueueTitles(trimmed);
  if (u.startsWith('SI.')) return parseSpecialService(trimmed);
  if (u.startsWith('NP.')) return parseNotepad(trimmed);
  // QRQ/ALL must come BEFORE the generic QR/ prefix so it doesn't get
  // mis-parsed as "QR plus Q/ALL".
  if (u === 'QRQ/ALL') return parseQueueRemoveAll(trimmed);
  if (u === 'QR' || u.startsWith('QR/')) return parseQueueRemove(trimmed, u);
  if (/^DP\d+$/.test(u)) return parseDivide(trimmed, u);
  if (u.startsWith('TTL')) return parseFlightInfo(trimmed, u);
  // Galileo hotel family — HO* (Comparison Guide "Hotels" 5-way
  // table; Apollo column is identical so ApolloDialect passes
  // through). Forms implemented are the verbatim guide rows:
  //   HOA6FEB-09FEBSAN2     availability, dates + city + adults
  //   HOI<city>[/<chain>]   hotel index
  //   HOC<line>             complete availability for a display line
  // Modifier-heavy variants (/D-10M distance, /RT- rate) are accepted
  // but ignored — split off at the first `/`.
  const hoaMatch = /^HOA(\d{1,2}[A-Z]{3})-(\d{1,2}[A-Z]{3})([A-Z]{3})(\d{1,2})?(?:\/.*)?$/.exec(u);
  if (hoaMatch) {
    return {
      kind: 'hotel', raw: trimmed, timestamp: new Date(),
      action: 'availability',
      checkIn: hoaMatch[1], checkOut: hoaMatch[2],
      city: hoaMatch[3],
      adults: hoaMatch[4] ? parseInt(hoaMatch[4], 10) : undefined,
    };
  }
  const hoiMatch = /^HOI([A-Z]{3})(?:\/([A-Z]{2}))?$/.exec(u);
  if (hoiMatch) {
    return {
      kind: 'hotel', raw: trimmed, timestamp: new Date(),
      action: 'index', city: hoiMatch[1], chain: hoiMatch[2],
    };
  }
  const hocMatch = /^HOC(\d{1,2})$/.exec(u);
  if (hocMatch) {
    return {
      kind: 'hotel', raw: trimmed, timestamp: new Date(),
      action: 'detail', line: parseInt(hocMatch[1], 10),
    };
  }

  // Galileo car family — CA* (Comparison Guide "Cars" table):
  //   CAL23AUG-25AUGDEN[/quals]  availability (ARR-/DT- ignored)
  //   CAIDEN                     vendor index by city
  const calMatch = /^CAL(\d{1,2}[A-Z]{3})-(\d{1,2}[A-Z]{3})([A-Z]{3})(?:\/.*)?$/.exec(u);
  if (calMatch) {
    return {
      kind: 'car', raw: trimmed, timestamp: new Date(),
      action: 'availability',
      pickup: calMatch[1], dropoff: calMatch[2], city: calMatch[3],
    };
  }
  const caiMatch = /^CAI([A-Z]{3})$/.exec(u);
  if (caiMatch) {
    return {
      kind: 'car', raw: trimmed, timestamp: new Date(),
      action: 'index', city: caiMatch[1],
    };
  }

  // Galileo advance seat request family — `S.` (Pocket Guide H/ASR).
  // Wired in W.2 so Worldspan's 4R sigil + Apollo route here too.
  //   S.@            cancel all seat requests
  //   S.S<n>@        cancel for segment n
  //   S.<code>       add: seat label (10A) or pref (NW/NA/SA/SW/W/A/G)
  //   S.S<n>/<code>  segment-specific add
  //   S.P<n>/<code>  passenger-specific add
  //   S.S<n>P<n>/<code>  both
  if (u.startsWith('S.')) {
    const body = u.slice(2);
    if (body === '@') {
      return { kind: 'seat_request', raw: trimmed, timestamp: new Date(), action: 'cancel', cancelAll: true };
    }
    const cancelSeg = /^S(\d{1,2})@$/.exec(body);
    if (cancelSeg) {
      return {
        kind: 'seat_request', raw: trimmed, timestamp: new Date(),
        action: 'cancel', segment: parseInt(cancelSeg[1], 10),
      };
    }
    const add = /^(?:S(\d{1,2}))?(?:P(\d{1,2})(?:\.(\d{1,2}))?)?\/?([A-Z0-9]{1,4})$/.exec(body);
    if (add && add[4]) {
      return {
        kind: 'seat_request', raw: trimmed, timestamp: new Date(),
        action: 'add',
        code: add[4],
        segment: add[1] ? parseInt(add[1], 10) : undefined,
        nameRef: add[2]
          ? { item: parseInt(add[2], 10), passenger: add[3] ? parseInt(add[3], 10) : undefined }
          : undefined,
      };
    }
  }

  // Galileo seat-map family (Pocket Guide + galileoindonesia.com guide):
  //   SA*S<n>[;]                          seat map for segment n
  //   SA*S<n>/<row>[;]                    + from-row offset
  //   SA*S<n>/<pref>[/<row>][;]           + preference + offset
  //   SA*S<n>#<airport>[;]                + change-of-gauge leg
  //   SA*S<n>/<class>-<count>[;]          + pax count
  //   SA*[;]                              refresh last seat map
  //   SM*A<line>[<class>][;]              seat map from cached availability
  //   SM*A<line>[<class>]/<pref>[;]       + preference
  //   SM*A<line>[<class>]/<class>-<n>[;]  + pax count
  //
  // The trailing `;` suffix triggers Smartpoint's "traditional format"
  // mode — documented in the Travelport-Asia 2-Day Smartpoint Pro
  // training PDF p.29 (`SA*S1` = graphical, `SA*S1;` = traditional
  // format). Since our renderer always emits cryptic text the `;` is
  // a no-op alias.
  //
  // The /<pref> suffix accepts NW/NA/SW/SA/N/S/W/A (non-smoking-window
  // / smoking-aisle / etc.). Smoking/position filters have no semantic
  // effect in our emulator (we don't model smoking). The /<row> suffix
  // does — it drives the renderer's rowOffset. The /<class>-<n> pax-
  // count and #<airport> change-of-gauge filters are also accepted and
  // surface in the entry, but have no effect on the rendered output.
  const saSegMatch = /^SA\*S(\d{1,2})(.*?);?$/.exec(u);
  if (saSegMatch) {
    const filters = parseSeatMapFilters(saSegMatch[2]);
    if (filters !== null) {
      return {
        kind: 'seat_map',
        raw: trimmed,
        timestamp: new Date(),
        source: 'segment',
        segment: parseInt(saSegMatch[1], 10),
        filters: filters.empty ? undefined : filters.value,
      };
    }
    // Unrecognized suffix — fall through; no other rule will match
    // `SA*S<n>` so we'll exit the parser at the end with an unknown
    // entry per Galileo's existing fall-through convention.
  }
  if (u === 'SA*' || u === 'SA*;') {
    return { kind: 'seat_map', raw: trimmed, timestamp: new Date(), source: 'refresh' };
  }
  // SC*<seat> — display specific seat characteristic. Per the
  // galileoindonesia.com guide: `SC*10A` shows the IATA PADIS 9825
  // codes (W=window, etc.) for one seat. Source='direct' + seatLabel.
  const scMatch = /^SC\*(\d{1,3}[A-Z]);?$/.exec(u);
  if (scMatch) {
    return {
      kind: 'seat_map',
      raw: trimmed,
      timestamp: new Date(),
      source: 'direct',
      seatLabel: scMatch[1],
    };
  }
  const smAvailMatch = /^SM\*A(\d{1,2})([A-Z])?(.*?);?$/.exec(u);
  if (smAvailMatch) {
    const filters = parseSeatMapFilters(smAvailMatch[3]);
    if (filters !== null) {
      return {
        kind: 'seat_map',
        raw: trimmed,
        timestamp: new Date(),
        source: 'avail-line',
        line: parseInt(smAvailMatch[1], 10),
        bookingClass: smAvailMatch[2],
        filters: filters.empty ? undefined : filters.value,
      };
    }
  }
  // MD / MU / MB / MT — scroll the currently-displayed page. Mini
  // Format Guide v2 + Kuwait 2021 + Comparison Guide all document
  // these as bare verbs. In chunk 7 follow-up scope, only seat-map
  // scrolling is wired; other display types (fare, avail) will route
  // here too when added. Handler checks wa.lastSeatMap to decide.
  const scrollMatch = /^(MD|MU|MB|MT)$/.exec(u);
  if (scrollMatch) {
    const dirMap: Record<string, 'down' | 'up' | 'bottom' | 'top'> = {
      MD: 'down', MU: 'up', MB: 'bottom', MT: 'top',
    };
    return {
      kind: 'seat_map',
      raw: trimmed,
      timestamp: new Date(),
      source: 'scroll',
      direction: dirMap[scrollMatch[1]],
    };
  }
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
const AVAIL_RE = /^A([DJAF])?(\d{1,2}[A-Z]{3})([A-Z]{3})([A-Z]{3})(?:\.([A-Z]{3}))?(?:\/([A-Z0-9]+))?$/;

function isAvailability(u: string): boolean {
  return AVAIL_RE.test(u);
}

function parseAvailability(raw: string, u: string): AvailabilityEntry {
  const m = AVAIL_RE.exec(u)!;
  const [, _sortMode, dateTok, origin, destination, viaCity, carrier] = m;
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
    connectingCity: viaCity, // Mini Guide p.10: `.<midpoint>` filters to connections via that hub
  };
}

/**
 * Sell entries. Source: Mini Format Guide v2 p.12 + Pocket Guide p.3:
 *
 *   N<seats><class><line>                    single-segment sell
 *                                             e.g. N1Y1 (1 seat Y class line 1)
 *   N<seats><class1><line1><class2><line2>   multi-leg connecting sell
 *                                             e.g. N2F1F2Y3 (2 seats: F class
 *                                             lines 1 and 2, Y class line 3)
 *
 * Deferred for follow-up commits:
 *   - sell-with-star-connections    N1C5*
 *   - waitlist if unavailable       (Mini Guide / Pocket Guide both
 *                                    document this implicitly)
 *   - ARNK segments                 0A
 *   - direct/long sell              (no availability cache needed)
 */
const SELL_RE = /^N(\d+)((?:[A-Z]\d+)+)$/;

function isSell(u: string): boolean {
  return SELL_RE.test(u);
}

function parseSell(raw: string, u: string): SellEntry {
  const m = SELL_RE.exec(u)!;
  const seats = parseInt(m[1], 10);
  if (seats <= 0) throw new ParseError(`Galileo: zero seats in "${raw}"`);

  // Pull out every (class, line) pair: F1, F2, Y3, ... in N2F1F2Y3.
  const pairs: { bookingClass: string; line: number }[] = [];
  const pairRe = /([A-Z])(\d+)/g;
  let pm;
  while ((pm = pairRe.exec(m[2])) !== null) {
    const line = parseInt(pm[2], 10);
    if (line <= 0) throw new ParseError(`Galileo: zero line in "${raw}"`);
    pairs.push({ bookingClass: pm[1], line });
  }
  if (pairs.length === 0) throw new ParseError(`Galileo: no class/line pair in "${raw}"`);

  const base = {
    kind: 'sell' as const,
    raw,
    timestamp: new Date(),
    mode: 'availability' as const,
    seats,
    bookingClass: pairs[0].bookingClass,
    line: pairs[0].line,
  };
  return pairs.length === 1 ? base : { ...base, legs: pairs };
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
 * Source: Mini Format Guide v2 p.17.
 *
 * I  — discard the work area; live workbench DELETE'd politely.
 * IR — same as I, but also re-retrieve the BF that was on screen
 *      (by locator). The dispatch handler reads `retrieve` and
 *      invokes the same retrieve path `*<locator>` uses.
 */
function parseIgnore(raw: string): IgnoreEntry {
  const u = raw.trim().toUpperCase();
  return { kind: 'ignore', raw, timestamp: new Date(), retrieve: u === 'IR' };
}

/**
 * `*<argument>` — retrieve / display. Source: Mini Format Guide v2 p.17
 * + Smartpoint Module 2 p.27.
 *
 *   *<6-letter-locator>      retrieve booking file by locator
 *   *-<surname>              retrieve by surname (numbered list if >1)
 *   *-<surname>/<given>      retrieve by full name (parsed as the same
 *                            "surname/given" the retrieve handler already
 *                            matches against)
 *   *R                       display the entire current booking file
 *   *I                       display only the itinerary
 *
 * The Sabre DisplayEntry kind is reused — `argument` carries the post-`*`
 * text and the dispatch fans out by shape. Internal whitespace in
 * surname-with-given forms (`*- WILLIAMS/CHRIS MR`) is preserved.
 *
 * Deferred (parser still throws → FORMAT):
 *   - **HK7-<NAME>     branch-PCC retrieve
 *   - **B-<NAME>       all-branch retrieve
 *   - *28JUN-<NAME>    date-and-name retrieve
 *   - *I/<n>           single-segment subsection
 *   - *<n>             similar-name list selection
 */
function parseDisplay(raw: string): DisplayEntry {
  const argument = raw.slice(1).trim();
  return { kind: 'display', raw, timestamp: new Date(), argument };
}

/**
 * `X<sel>` — cancel segments. Source: Travelport+ Mini Format Guide v2
 * p.17. Documented forms in this commit:
 *
 *   X<n>          single segment (e.g. X2)
 *   X<n>-<m>      range (e.g. X9-11)
 *   X<n>.<m>.<p>  list, period-separated (Galileo uses `.`; Sabre uses `/`)
 *   X<n>.<m>-<p>  combined list + range (e.g. X2.5-7 = segments 2, 5, 6, 7)
 *   XI            entire itinerary
 *   XA            all air segments (Galileo uses `XA`; Sabre uses `XIA`)
 *
 * Deferred:
 *   - XH / XC (cancel all hotel / car segments — hotel/car not modeled)
 *   - cancel-and-rebook combined forms (Mini Guide doesn't document a
 *     single-entry combined form like Sabre's X3¥01F1)
 */
function parseCancel(raw: string, u: string): CancelEntry {
  const body = u.slice(1); // drop the leading 'X'
  if (body === 'I') {
    return { kind: 'cancel', mode: 'itinerary', segments: [], raw, timestamp: new Date() };
  }
  if (body === 'A') {
    return { kind: 'cancel', mode: 'all_air', segments: [], raw, timestamp: new Date() };
  }
  // Period-separated tokens; each token is either a single number or a
  // range. Empty body, trailing dots, or zero/non-number tokens reject.
  if (body.length === 0) throw new ParseError(`Galileo X: missing selection in "${raw}"`);
  const tokens = body.split('.');
  const segments: number[] = [];
  for (const tok of tokens) {
    const range = /^(\d+)-(\d+)$/.exec(tok);
    if (range) {
      const from = parseInt(range[1], 10);
      const to = parseInt(range[2], 10);
      if (from === 0 || to === 0) throw new ParseError(`Galileo X: zero segment in "${raw}"`);
      if (to < from) throw new ParseError(`Galileo X: descending range in "${raw}"`);
      for (let i = from; i <= to; i++) segments.push(i);
      continue;
    }
    if (!/^\d+$/.test(tok)) throw new ParseError(`Galileo X: bad token "${tok}" in "${raw}"`);
    const n = parseInt(tok, 10);
    if (n === 0) throw new ParseError(`Galileo X: zero segment in "${raw}"`);
    segments.push(n);
  }
  // Mode: 'segment' for one number, 'range' for one range, 'multiple' otherwise.
  const mode: CancelEntry['mode'] =
    tokens.length === 1
      ? /^\d+-\d+$/.test(tokens[0])
        ? 'range'
        : 'segment'
      : 'multiple';
  return { kind: 'cancel', mode, segments, raw, timestamp: new Date() };
}

/**
 * `@<n>HK` / `@<n>XK` — modify family, status-change subset. Source:
 * Galileo Pocket Guide p.3 (`@1HK` → SegmentStatusEntry) and Mini Guide
 * v2 p.17 (`@<n>XK` → PassiveCancelEntry: "Remove a HX segment passively
 * (for all airlines except EK)").
 *
 * Other documented @-modify forms in Mini Guide v2 p.17 are deferred and
 * trip the catch-all in this parser (→ FORMAT):
 *   @<n>/<class>        rebook in different class (needs fare lookup)
 *   @<n>/<DDMMM>        date change
 *   @<n>/<DDMMM>/<cls>  date + class change
 *   @A/<class>          change all segments to class
 *   @<n>/<seats>        change pax count
 *   @A/<seats>          change pax count all segments
 */
function parseModify(
  raw: string,
  u: string
): SegmentStatusEntry | PassiveCancelEntry {
  const m = /^@(\d+)([A-Z]{2})$/.exec(u);
  if (!m) throw new ParseError(`Galileo @: only @<n>HK and @<n>XK supported in v1 (got "${raw}")`);
  const segment = parseInt(m[1], 10);
  const status = m[2];
  if (segment === 0) throw new ParseError(`Galileo @: zero segment in "${raw}"`);
  if (status === 'XK') {
    return { kind: 'passive_cancel', raw, timestamp: new Date(), segments: [segment] };
  }
  // Default: status change. The handler validates against a known-status set.
  return { kind: 'segment_status', raw, timestamp: new Date(), segment, status };
}

/**
 * `FQ` — Fare Quote. Source: Mini Format Guide v2 p.27 verbatim:
 * "Quote applicable adult fare (private or public) for all passengers,
 * all segments, in the class booked. Plating carrier logic will be
 * used."
 *
 * The Sabre PricingEntry kind is reused. Galileo's FQ behaves like
 * Sabre's WPRQ (price-and-store) — it both produces a quote and files
 * it on the PNR for later ticketing.
 *
 * Deferred (Mini Guide p.27-31 lists many qualifier forms — passenger
 * type, segment selection, validating carrier, currency, best-buy,
 * private fares with account codes, etc.):
 *   FQBB / FQBC / FQBA / FQA / FQBB++...
 *   FQP<n>/<carrier>             plating per passenger
 *   FQP<n>-<m>.<p>               passenger selection
 *   FQP<n>*C07 / FQ*C05/ACC      passenger-type (child / accompanied)
 *   FQS<segs>                    segment-selection
 *   FQ-TO, FQ-:TO, FQ*ITX        private-fare qualifiers
 *   FQTE / FQTE-00 / FQCDL/TE-00 tax-exempt variants
 */
function parsePricing(raw: string): PricingEntry {
  return {
    kind: 'pricing',
    raw,
    timestamp: new Date(),
    mode: 'price', // Sabre's "price-as-booked"; FQ behaves the same way
    store: true, // FQ files the quote so a later TKP<n> can reference it
  };
}

/**
 * `TKP<n>` — Issue ticket and associated documents for filed fare `<n>`.
 * Source: Mini Format Guide v2 p.53.
 *
 *   TKP1                     issue from filed fare 1
 *   TKP2                     issue from filed fare 2
 *   TKP (no number)          shorthand for filed fare 1 (most recent)
 *
 * The Sabre TicketEntry kind is reused; source='pq' indicates issuance
 * from a stored quote (vs Sabre's price-as-booked W¥).
 *
 * Deferred:
 *   TKP1P2                   issue for specific passenger
 *   TKP1OKX                  issue expired filed fare (guarantee code)
 *   TKP<n>/<modifiers>       commission, FOP, ticket-designator, etc.
 *                            (Mini Guide p.53-56 ticket modifiers section)
 */
function parseTicketIssue(raw: string, u: string): TicketEntry {
  const rest = u.slice(3); // drop 'TKP'
  let pqRecord = 1;
  if (rest.length > 0) {
    if (!/^\d+$/.test(rest)) {
      throw new ParseError(`Galileo TKP: unsupported modifier "${rest}" in "${raw}"`);
    }
    pqRecord = parseInt(rest, 10);
    if (pqRecord <= 0) throw new ParseError(`Galileo TKP: filed-fare index must be ≥ 1 in "${raw}"`);
  }
  return {
    kind: 'ticket',
    raw,
    timestamp: new Date(),
    source: 'pq',
    pqRecord,
  };
}

/**
 * `TTL<n>` — Show flight information for flight on line `<n>` in the
 * cached availability. Source: Mini Format Guide v2 p.11 verbatim
 * ("TTL1 — Show flight information for flight on line 1 in
 * availability"). Reuses the Sabre FlightInfoEntry kind with source =
 * 'availability'.
 *
 * Multi-line `TTL1,2` / `TTL1-3` forms aren't documented in the Mini
 * Guide; single-line v1.
 */
function parseFlightInfo(raw: string, u: string): FlightInfoEntry {
  const m = /^TTL(\d+)$/.exec(u);
  if (!m) throw new ParseError(`Galileo TTL: expected TTL<line> in "${raw}"`);
  const line = parseInt(m[1], 10);
  if (line <= 0) throw new ParseError(`Galileo TTL: zero line in "${raw}"`);
  return {
    kind: 'flight_info',
    raw,
    timestamp: new Date(),
    source: 'availability',
    lines: [line],
  };
}

/**
 * `TRV/<13-digit>` — Void an eticket by ticket number. Source: Mini
 * Format Guide v2 p.53. Same-day window enforced server-side; the
 * emulator doesn't model wall-clock cutoffs.
 *
 * Deferred:
 *   - TRVE/<ticket> void a REISSUED ticket — Galileo-specific exchange
 *     flow not yet wired
 */
function parseVoid(raw: string, u: string): VoidEntry {
  const m = /^TRV\/(\d{13})$/.exec(u);
  if (!m) throw new ParseError(`Galileo TRV: expected TRV/<13-digit ticket> in "${raw}"`);
  return {
    kind: 'void',
    raw,
    timestamp: new Date(),
    mode: 'manual',
    ticketNumber: m[1],
  };
}

/**
 * Strip optional Galileo queue qualifiers `*C<cat>*D<n>` from the
 * tail of a queue verb. Returns `{ stem, category, dateRange }` where
 * stem is the part before any qualifier and the qualifier fields are
 * undefined when absent.
 *
 * Source (verbatim from Smartpoint Cloud Help, Smartpoint for Galileo
 * PDF, and gdshelp.blogspot, all 2026-05-29):
 *   Q/37*CDM             → Sign in to Q37 category DM
 *   Q/37*CBA*D3          → Sign in to Q37, category BA, date range 3
 *   QEB/42*CAB*D4        → Place BF on Q42, category AB, date range 4
 *
 * Category code is exactly 2 alphanumeric characters; date range is a
 * single digit 1-4 (each category supports up to 4 date ranges).
 * Order is fixed: `*C` first if present, `*D` second.
 */
function stripQueueQualifiers(
  s: string
): { stem: string; category?: string; dateRange?: number } {
  const m = /^(.*?)(?:\*C([A-Z0-9]{2}))?(?:\*D([1-4]))?$/.exec(s);
  if (!m) return { stem: s };
  return {
    stem: m[1],
    category: m[2] || undefined,
    dateRange: m[3] ? Number(m[3]) : undefined,
  };
}

/**
 * `QEB/<n>` — Universal queue-place verb (commits if no locator on
 * screen, pure place if a locator is already on screen). Source:
 * Galileo Pocket Guide p.3, Mini Format Guide v2 p.45, Smartpoint
 * Cloud Help, four-source triangulation 2026-05-29.
 *
 * Forms:
 *   QEB/<n>                  single queue
 *   QEB/<n>+<n>+<n>          multi-queue chain (Pocket Guide p.31)
 *   QEB/<PCC>/<n>            branch-PCC placement (Mini Guide v2 p.45)
 *   QEB/<PCC>/<n>+<n>...     branch-PCC + multi-queue
 *   QEB/<n>*C<cat>           with category (`QEB/42*CAB`)
 *   QEB/<n>*C<cat>*D<n>      with category + date range (`QEB/42*CAB*D4`)
 *   QEB/<PCC>/<n>*C<cat>*D<n>  branch-PCC + qualifiers
 *
 * Branch-PCC is disambiguated by structure: a two-segment stem
 * (`QEB/A/B`) treats A as the PCC and B as the queue chain. Single-
 * segment (`QEB/A`) treats A as the queue chain. The branch PCC
 * rides on `entry.pic`; category + date range on `entry.category` /
 * `entry.dateRange`. v1: qualifiers apply uniformly to every queue
 * in a multi-queue chain (per the Queue[] array shape — each element
 * can carry its own category/dateOffset, but Galileo cryptic only
 * surfaces one set of qualifiers per verb).
 */
function parseQueuePlaceEnd(raw: string, u: string): QueueEntry {
  const { stem, category, dateRange } = stripQueueQualifiers(u);
  const branchMatch = /^QEB\/([A-Z0-9]+)\/([A-Z0-9]+(?:\+[A-Z0-9]+)*)$/.exec(stem);
  if (branchMatch) {
    const [pcc, chain] = [branchMatch[1], branchMatch[2]];
    const [primary, ...rest] = chain.split('+');
    return {
      kind: 'queue',
      raw,
      timestamp: new Date(),
      op: 'place',
      queue: primary,
      pic: pcc,
      category,
      dateRange,
      additionalTargets: rest.length > 0 ? rest.map((q) => ({ queue: q })) : undefined,
    };
  }
  const m = /^QEB\/([A-Z0-9]+(?:\+[A-Z0-9]+)*)$/.exec(stem);
  if (!m) {
    throw new ParseError(
      `Galileo QEB: expected QEB/<queue>[+<queue>...] or QEB/<PCC>/<queue>[+<queue>...]` +
        ` (with optional *C<cat>*D<n> suffix) in "${raw}"`
    );
  }
  const [primary, ...rest] = m[1].split('+');
  return {
    kind: 'queue',
    raw,
    timestamp: new Date(),
    op: 'place',
    queue: primary,
    category,
    dateRange,
    additionalTargets: rest.length > 0 ? rest.map((q) => ({ queue: q })) : undefined,
  };
}

/**
 * `QX` / `QXI` / `QXE` — Sign out of the current queue cursor.
 * Source: Mini Format Guide v2 p.45 (`QXI` "Sign out of the queue and
 * ignore active booking file") + Galileo Pocket Guide p.13 (`QX`
 * "Sign out of queue", `QX+I` / `QX+E` composed forms).
 *
 * No REST equivalent — this is a pure cursor/state op. QXI composes
 * with `I` semantics (workbench DELETE + reset); QXE composes with
 * `E` semantics (commit). Plain QX just clears `wa.currentQueue` and
 * leaves the work area alone.
 *
 * Deferred: `QXIR` / `QXER` (Zenon-course redisplay variants).
 */
/**
 * `QR` — Remove the on-screen BF from the current queue. Source:
 * Galileo Pocket Guide p.13 ("QR  Remove BF from queue").
 *
 * Multi-queue form: `QR/23+77` (Mini Format Guide v2 p.45) — remove
 * from active queue PLUS queues 23 and 77 in one call. Active queue
 * comes from `wa.currentQueue` at dispatch time; the `+`-list lands
 * in `additionalTargets`.
 */
function parseQueueRemove(raw: string, u: string): QueueEntry {
  if (u === 'QR') {
    return { kind: 'queue', raw, timestamp: new Date(), op: 'remove' };
  }
  const m = /^QR\/([A-Z0-9]+(?:\+[A-Z0-9]+)*)$/.exec(u);
  if (!m) throw new ParseError(`Galileo QR: expected QR or QR/<queue>[+<queue>...] in "${raw}"`);
  const [primary, ...rest] = m[1].split('+');
  return {
    kind: 'queue',
    raw,
    timestamp: new Date(),
    op: 'remove',
    queue: primary,
    additionalTargets: rest.length > 0 ? rest.map((q) => ({ queue: q })) : undefined,
  };
}

/**
 * `QRQ/ALL` — Remove the on-screen BF from ALL queues in the agency
 * PCC. Source: Galileo Pocket Guide p.13. Pre-condition: must NOT be
 * inside a queue cursor — the source explicitly says "cannot be done
 * if in the queue". v1 derives the queue list from the local mirror
 * (`backend.queues`) and POSTs a single multi-queue removal. Server-
 * side queues that the local shadow didn't see are missed — flagged
 * in the dispatch docstring.
 */
function parseQueueRemoveAll(raw: string): QueueEntry {
  return {
    kind: 'queue',
    raw,
    timestamp: new Date(),
    op: 'remove_all_in_pcc',
  };
}

/**
 * `QP` / `QPI` — Move the queue cursor back 1. Source: Travelport
 * Smartpoint Cloud Help `Learn/14Queues/FreqFormats.htm` (verbatim
 * 2026-05-29):
 *   QP   "Move back 1 in the queue (Queue Previous)"
 *   QPI  "Ignore current booking file and move back 1 in the queue"
 *
 * Both require a queue context (Q/<n> first). At cursor 0 they
 * return "TOP OF QUEUE" (reconstructed). QPI additionally marks the
 * current BF as ignored — semantically "don't return it to the queue
 * AND don't take further action on it"; in our v1 emulation the
 * mark is informational since we don't yet model per-BF state.
 */
/**
 * `QCA` / `QCA*<n>` — Count / list all queues containing booking
 * files (with optional threshold). Source: Travelport Smartpoint
 * Cloud Help `Learn/14Queues/FreqFormats.htm` (verbatim 2026-05-29):
 *   QCA      "List all queues containing active booking files"
 *   QCA*30   "List all queues containing more than 30 booking files"
 */
function parseQueueCountAll(raw: string, u: string): QueueEntry {
  const m = /^QCA(?:\*(\d+))?$/.exec(u);
  if (!m) throw new ParseError(`Galileo QCA: expected QCA or QCA*<n> in "${raw}"`);
  return {
    kind: 'queue',
    raw,
    timestamp: new Date(),
    op: 'count_all',
    ...(m[1] ? { countThreshold: Number(m[1]) } : {}),
  };
}

/**
 * `QW` — Display every queue the on-screen BF resides on. Source:
 * Smartpoint Cloud Help (verbatim 2026-05-29): "List all queues
 * where current the booking file resides (Queue Where)."
 */
function parseQueueWhere(raw: string): QueueEntry {
  return { kind: 'queue', raw, timestamp: new Date(), op: 'where' };
}

/**
 * `QPB*` — Display queue titles. Source: Smartpoint Cloud Help
 * "Display a list of queue titles." We don't model titles in v1
 * (`backend.queues` is `Map<queueId, locator[]>` without a name
 * field) — the handler returns a `NO TITLES SET` stub (reconstructed)
 * unless emulated content carries one in the future.
 */
function parseQueueTitles(raw: string): QueueEntry {
  return { kind: 'queue', raw, timestamp: new Date(), op: 'display_titles' };
}

/**
 * `SI.<...>` — Galileo special service entry. Source: Mini Format
 * Guide v2 + Travelport Smartpoint Cloud Help (verified 2026-05-29).
 * Both SSRs and OSIs use the same `SI.` prefix in Galileo (Apollo
 * uses `:3` instead).
 *
 * **SSR vs OSI distinction** (verified verbatim from Smartpoint Cloud
 * `Learn/5OptionalFields/ServiceRequests.htm`):
 *  - **OSI** examples: `SI.YY*1 CHD AGED 5` ("Advise all airlines pax
 *    is a child aged 5"), `SI.KL*VIP STONE/- RMR FILM STAR`. Pattern:
 *    `SI.<2-letter-carrier>*<text>` — the code position holds a
 *    carrier (YY = all airlines, KL/AA/etc = specific).
 *  - **SSR** examples: `SI.VGML`, `SI.P1/VGML`, `SI.SPML*NO EGGS`.
 *    Pattern: `SI.[<scope>/]<4-char-code>[*<text>]`. The code is a
 *    documented IATA SSR (VGML, WCHR, INFT, SPML, DOCS, ...).
 *
 * Discrimination rule:
 *  - Has `<scope>/`? → SSR (OSIs don't carry P/S scope refs in the
 *    documented examples).
 *  - Code is exactly 2 alphabetic chars? → OSI (the chars are the
 *    carrier code).
 *  - Otherwise (4+ chars) → SSR.
 *
 * Forms (verbatim from Mini Guide v2):
 *   SI.<code>                  all pax, all segments — `SI.VGML`
 *   SI.P<n>/<code>             specific passenger — `SI.P1/VGML`
 *   SI.S<n>/<code>             specific segment — `SI.S3/VGML`
 *   SI.P<n>S<n>/<code>         pax + segment combo
 *   SI.<code>*<text>           with free text — `SI.SPML*NO EGGS`
 *   SI.P<n>S<n>/<code>*<text>  combination
 *
 * SSR code: 4 alpha-numeric chars per the REST schema; we accept
 * any 4-char alphanumeric to be permissive.
 *
 * Deferred (not in v1):
 *   - Modifications: `SI.<code>@HK`, `SI.<code>@XK`, `SI.<code>@`,
 *     `SI.ALL@`. Cancel-style ops mid-build.
 *   - Multi-segment ranges (`S3.4`)
 *   - Complex SSR payloads (`SSRDOCS<carrier><status>///DOB/...`)
 *     beyond the 4-char code (these come through as the free text).
 *   - OSI vs SSR routing (everything stored as SSR for now).
 *   - Live REST wiring (needs traveler-ID tracking from addTraveler).
 *     See `Future work` section in the spec doc.
 */
function parseSpecialService(raw: string): SsrEntry | OsiEntry {
  // Use `raw.trim().toUpperCase()` directly (not the no-whitespace `u`
  // variant) so free text like `SI.SPML*NO EGGS` preserves the space
  // between words.
  const upper = raw.trim().toUpperCase();
  if (!upper.startsWith('SI.')) {
    throw new ParseError(`Galileo SI: expected SI. prefix in "${raw}"`);
  }
  const body = upper.slice(3);
  const [head, ...textParts] = body.split('*');
  const text = textParts.length > 0 ? textParts.join('*').trim() : undefined;
  // Now `head` is `<scope>/<code>` or just `<code>`. Scope is optional.
  let scope = '';
  let code = head;
  const slashIdx = head.indexOf('/');
  if (slashIdx !== -1) {
    scope = head.slice(0, slashIdx);
    code = head.slice(slashIdx + 1);
  }

  // OSI discrimination: no scope + 2-char-alphabetic code = carrier
  // → emit OsiEntry. Per Smartpoint Cloud verbatim, OSI carries
  // free text addressed to a carrier; the BF position holds the
  // carrier code (YY = all airlines, KL/AA/etc = specific).
  if (scope === '' && /^[A-Z]{2}$/.test(code)) {
    if (!text || text.length === 0) {
      throw new ParseError(`Galileo SI: OSI requires free text after * in "${raw}"`);
    }
    return {
      kind: 'osi',
      raw,
      timestamp: new Date(),
      carrier: code,
      text,
    };
  }

  if (!/^[A-Z0-9]{2,}$/.test(code)) {
    throw new ParseError(`Galileo SI: expected SSR code (≥2 alphanumeric) in "${raw}"`);
  }
  // Parse scope: `P<n>`, `S<n>`, `P<n>S<n>`. Empty scope = all.
  let nameRef: SsrEntry['nameRef'] = undefined;
  let segmentRef: number | undefined;
  if (scope.length > 0) {
    const m = /^(?:P(\d+))?(?:S(\d+))?$/.exec(scope);
    if (!m) {
      throw new ParseError(`Galileo SI: malformed scope "${scope}" in "${raw}"`);
    }
    if (m[1]) nameRef = { item: Number(m[1]) };
    if (m[2]) segmentRef = Number(m[2]);
  }
  return {
    kind: 'ssr',
    raw,
    timestamp: new Date(),
    code,
    carrier: 'YY', // default to "all airlines"; per-carrier qualifier deferred
    text,
    nameRef,
    segmentRef,
  };
}

/**
 * `NP.<text>` — Notepad item / remark. Source: Mini Format Guide
 * v2 (verbatim 2026-05-29).
 *
 * Forms:
 *   NP.<text>          basic notepad item (`general` remark)
 *                      "Will not show in history of the booking file
 *                      when deleted."
 *   NP.C**<text>       confidential notepad (treated as `general` in
 *                      our model; the C qualifier is informational —
 *                      we don't yet model visibility tiers)
 *   NP.H**<text>       historical — "saved in the history of the
 *                      booking file when removed" (`historical`
 *                      remark)
 *
 * Deferred:
 *   - NP.F**<text>     credit-card secure notepad (needs PAN masking)
 *   - NP.HX**<text>    historical with additional qualifier
 *     (qualifier semantics unclear from Mini Guide)
 *
 * Like `SI.`, we work on `raw.trim()` to preserve internal spaces in
 * the free text — Mini Guide explicitly shows multi-line notepad
 * entries spanning multiple words.
 */
function parseNotepad(raw: string): RemarkEntry {
  const body = raw.trim().slice(3); // strip "NP."
  // Qualifier: a single letter followed by `**` (e.g. `H**`, `C**`).
  let remarkType: 'general' | 'fop' | 'historical' = 'general';
  let text = body;
  const qm = /^([A-Z]+)\*\*(.*)$/s.exec(body);
  if (qm) {
    const qualifier = qm[1].toUpperCase();
    text = qm[2];
    switch (qualifier) {
      case 'H':
        remarkType = 'historical';
        break;
      case 'C':
        remarkType = 'general'; // confidential — informational; visibility tier deferred
        break;
      default:
        throw new ParseError(`Galileo NP: unsupported qualifier "${qualifier}" in "${raw}"`);
    }
  }
  if (text.trim().length === 0) {
    throw new ParseError(`Galileo NP: notepad text required in "${raw}"`);
  }
  return {
    kind: 'remark',
    raw,
    timestamp: new Date(),
    remarkType,
    text: text.trim(),
  };
}

/**
 * `TMU<n>F<form>` — Ticket Modifier Update: attach a form of payment
 * to filed fare `<n>` before issue. Source: Mini Format Guide v2
 * (verbatim 2026-05-29):
 *
 *   TMU1FS               FOP Cash for filed fare 1
 *   TMU1FNONREF          FOP Nonref (cash, non-refundable) for filed fare 1
 *   TMU2FAX2739122345 6789*D1228
 *                        Credit card for filed fare 2
 *
 * Credit card grammar: `F<2-letter-brand><pan>*D<MMYY>`. Brand codes
 * mirror IATA: VI (Visa), AX (Amex), MC (Mastercard), CA (per Mini
 * Guide example shows AX), DC (Diners), JC (JCB), etc. We don't
 * validate brand-vs-PAN-length here.
 *
 * Deferred:
 *   - TMU<n>FGR<...>     Government warrant — v11 REST shape not
 *                        captured in `APIRef_AddFOP.htm`
 *   - TMU<n>C<carrier>   Change ticketing carrier (different modifier
 *                        family — Mini Guide separates from F)
 *   - TMU<n>             Bare update without F (no documented effect
 *                        in our sources)
 */
function parseTicketModifier(raw: string, u: string): TicketModifierEntry {
  const m = /^TMU(\d+)F(.+)$/.exec(u);
  if (!m) {
    throw new ParseError(`Galileo TMU: expected TMU<n>F<form> in "${raw}"`);
  }
  const filedFare = Number(m[1]);
  if (filedFare < 1) {
    throw new ParseError(`Galileo TMU: filed-fare index must be ≥ 1 in "${raw}"`);
  }
  const formStr = m[2];

  // Cash variants first (cheap to check).
  if (formStr === 'S') {
    return {
      kind: 'ticket_modifier',
      raw,
      timestamp: new Date(),
      filedFare,
      fop: { kind: 'cash' },
    };
  }
  if (formStr === 'NONREF') {
    return {
      kind: 'ticket_modifier',
      raw,
      timestamp: new Date(),
      filedFare,
      fop: { kind: 'cash', nonRefundable: true },
    };
  }

  // Credit card: <2-letter brand><PAN>*D<MMYY>
  const cc = /^([A-Z]{2})(\d{12,19})\*D(\d{4})$/.exec(formStr);
  if (cc) {
    const [brand, pan, expiry] = [cc[1], cc[2], cc[3]];
    return {
      kind: 'ticket_modifier',
      raw,
      timestamp: new Date(),
      filedFare,
      fop: { kind: 'credit_card', brand, pan, expiry },
    };
  }

  throw new ParseError(
    `Galileo TMU: unsupported FOP form "${formStr}" in "${raw}" ` +
      `(supported: S, NONREF, <brand><pan>*D<MMYY>)`
  );
}

/**
 * `FD<...>` — Fare Display. Source: Mini Format Guide v2 (verbatim
 * 2026-06-03).
 *
 * Forms wired:
 *   FD<orig><dest>                  today, no carrier filter
 *   FD<date><orig><dest>            with date — date floats
 *   FD<orig><date><dest>            (same; date can sit anywhere)
 *   FD<orig><dest><date>            (same)
 *   FD<...>/<carrier>               with carrier filter (up to 3)
 *
 * The cryptic allows DDMMM to sit at the start, middle, or end of the
 * locations string. We scan for a `\d{1,2}[A-Z]{3}` match and peel
 * it out, leaving 6 alphabetic chars for origin+destination.
 *
 * Deferred (parser-level):
 *   - `FDPAR` — dest only, origin defaults to sign-on city
 *   - Journey type qualifiers `-RT`/`-OW`/`-RTW`/`-CTF`
 *   - `*PTC` passenger types
 *   - `.T<date>` historical ticketing date
 */
function parseFareDisplay(raw: string, u: string): FareDisplayEntry {
  // Strip "FD" prefix.
  const body = u.slice(2);
  if (body.length === 0) {
    throw new ParseError(`Galileo FD: expected FD[<date>]<orig><dest>[/<carrier>...] in "${raw}"`);
  }

  // Split on "/" — first segment is locations+date, rest are carriers.
  const [head, ...carriers] = body.split('/');
  for (const c of carriers) {
    if (!/^[A-Z]{2}$/.test(c)) {
      throw new ParseError(`Galileo FD: bad carrier code "${c}" in "${raw}"`);
    }
  }
  if (carriers.length > 3) {
    throw new ParseError(`Galileo FD: max 3 carriers per REST limit in "${raw}"`);
  }

  // Look for date pattern DDMMM in head.
  let date: import('../../utils/validation.js').SabreDate | undefined;
  let cities = head;
  const dateRe = /(\d{1,2})([A-Z]{3})/;
  const dm = dateRe.exec(head);
  if (dm) {
    const parsed = parseSabreDate(head.slice(dm.index));
    if (parsed && parsed.length === dm[0].length) {
      date = parsed.date;
      cities = head.slice(0, dm.index) + head.slice(dm.index + dm[0].length);
    }
  }

  if (!/^[A-Z]{6}$/.test(cities)) {
    if (/^[A-Z]{3}$/.test(cities)) {
      throw new ParseError(
        `Galileo FD: current-city default not modelled; use FD[<date>]<orig><dest> in "${raw}"`
      );
    }
    throw new ParseError(
      `Galileo FD: expected 6 location chars after stripping date in "${raw}" (got "${cities}")`
    );
  }

  return {
    kind: 'fare_display',
    raw,
    timestamp: new Date(),
    origin: cities.slice(0, 3),
    destination: cities.slice(3),
    date,
    carriers: carriers.length > 0 ? carriers : undefined,
  };
}

/**
 * `FQN` / `FN<...>` — Fare components / fare notes. Source: Mini
 * Format Guide v2 (verbatim 2026-06-03):
 *
 *   FQN                        Display fare components
 *   FN*<line>                  Notes by category menu (line N in FD)
 *   FN*<line>/P<para>          Specific paragraph
 *   FN*<line>/<para>           (same; shorter syntax)
 *   FN*<line>/ALL              All fare notes
 *   FN<seg>/ALL                Notes for segment N after FQN
 *
 * v1 wires FQN locally (reads from `wa.pnr.priceQuotes[]`). The FN
 * family parses but live wiring (which would call `GET /11/air/
 * farerule/farerules/fromfaredisplay` with the cached FD identifier)
 * is parked — needs `lastFareDisplay` caching on the WA first.
 */
function parseFareNotes(raw: string, u: string): FareNotesEntry {
  if (u === 'FQN') {
    return { kind: 'fare_notes', raw, timestamp: new Date(), mode: 'components' };
  }
  // FN*<line>[/...]
  const star = /^FN\*(\d+)(?:\/(.+))?$/.exec(u);
  if (star) {
    return {
      kind: 'fare_notes',
      raw,
      timestamp: new Date(),
      mode: 'notes_by_line',
      fareLine: Number(star[1]),
      paragraph: star[2],
    };
  }
  // FN<seg>/ALL or FN<seg>/<filter>
  const seg = /^FN(\d+)\/(.+)$/.exec(u);
  if (seg) {
    return {
      kind: 'fare_notes',
      raw,
      timestamp: new Date(),
      mode: 'notes_by_segment',
      segment: Number(seg[1]),
      paragraph: seg[2],
    };
  }
  throw new ParseError(
    `Galileo FN/FQN: expected FQN, FN*<line>[/<para>], or FN<seg>/<para> in "${raw}"`
  );
}

/**
 * `PQ/<...>` — Past Date Booking File retrieve. Source: Mini Format
 * Guide v2 (verbatim 2026-06-03):
 *
 *   PQ/R-<locator>                     by record locator
 *   PQ/<DDMMMYY><surname>/<given>      by date + name
 *   PQ/<from><to>-<surname>            date range + name (own branch)
 *   PQ/B/<DDMMMYY>-<surname>           branch + date + surname
 *
 * v11 has NO past-date REST endpoint — confirmed via the v11
 * Reservation Retrieve Guide (verified 2026-06-03). Past-date PNRs
 * are an archive tier outside the active retention window
 * (`/reservations/{LocatorCode}` only handles active reservations).
 *
 * v1 wires only the `PQ/R-<locator>` form, which falls back to the
 * local `pnrStore` (which retains everything we've ever committed
 * in this session). Other forms parse to a deferred-feature stub
 * since name/date search against the live archive isn't available.
 */
function parsePastDateRetrieve(raw: string, u: string): DisplayEntry {
  // Reuse DisplayEntry — dispatch routes off the `argument` payload.
  // We encode the PQ kind into the argument with a `PQ:` prefix so
  // the display handler can recognise it.
  const m = /^PQ\/R-([A-Z0-9]{5,7})$/.exec(u);
  if (m) {
    return { kind: 'display', raw, timestamp: new Date(), argument: `PQ-R:${m[1]}` };
  }
  // Other PQ forms route to a deferred stub.
  return { kind: 'display', raw, timestamp: new Date(), argument: `PQ-DEFERRED:${u}` };
}

function parseQueuePrevious(raw: string, u: string): QueueEntry {
  return {
    kind: 'queue',
    raw,
    timestamp: new Date(),
    op: u === 'QPI' ? 'previous_ignore' : 'previous',
  };
}

function parseQueueExit(raw: string, u: string): QueueEntry {
  const op: QueueEntry['op'] =
    u === 'QXI' ? 'exit_ignore'
    : u === 'QXE' ? 'exit_end_tx'
    : u === 'QXIR' ? 'exit_ignore_redisplay'
    : u === 'QXER' ? 'exit_end_redisplay'
    : 'exit';
  return {
    kind: 'queue',
    raw,
    timestamp: new Date(),
    op,
  };
}

/**
 * `Q/<n>` — Access queue `<n>`, display its contents. Source: Mini
 * Format Guide v2 p.41 + Smartpoint Cloud Help 2026-05-29.
 *
 * Forms:
 *   Q/<n>                    bare access (`Q/43`)
 *   Q/<n>*C<cat>             with category (`Q/37*CDM`)
 *   Q/<n>*C<cat>*D<n>        with category + date range (`Q/37*CBA*D3`)
 *   Q/<PCC>/<n>              branch-PCC access (`Q/18F/27`)
 *   Q/<PCC>/<n>*C<cat>*D<n>  branch-PCC + qualifiers (combination)
 *
 * Verbatim examples from Travelport Smartpoint Cloud Help (`Learn/
 * 14Queues/AccessBF.htm`). Branch PCC rides on `entry.pic`;
 * qualifiers on `entry.category` / `entry.dateRange`. Same disambig
 * pattern as QEB.
 */
function parseQueueAccess(raw: string, u: string): QueueEntry {
  const { stem, category, dateRange } = stripQueueQualifiers(u);
  const branchMatch = /^Q\/([A-Z0-9]+)\/([A-Z0-9]+)$/.exec(stem);
  if (branchMatch) {
    return {
      kind: 'queue',
      raw,
      timestamp: new Date(),
      op: 'access',
      queue: branchMatch[2],
      pic: branchMatch[1],
      category,
      dateRange,
    };
  }
  const m = /^Q\/([A-Z0-9]+)$/.exec(stem);
  if (!m) {
    throw new ParseError(
      `Galileo Q/: expected Q/<queue> or Q/<PCC>/<queue> (with optional *C<cat>*D<n>) in "${raw}"`
    );
  }
  return {
    kind: 'queue',
    raw,
    timestamp: new Date(),
    op: 'access',
    queue: m[1],
    category,
    dateRange,
  };
}

/**
 * `DP<n>` — Divide passenger `<n>` from the booking file. Source: Mini
 * Format Guide v2 p.39. Single-shot in this parser; the multi-step
 * follow-up (R., F, R., E) is handled by the existing field entries.
 *
 * Galileo's "passenger 2" means overall passenger index across name
 * elements, not name element 2. The handler resolves the index to an
 * item+passenger ref when populating DivideEntry.refs.
 */
/**
 * Parse the optional Galileo SA-asterisk / SM-asterisk filter suffix
 * tail. Tail starts
 * after the SA*S<n> / SM*A<line>[<class>] core; everything else is
 * filters. Returns an object with `empty: true` when no filters apply,
 * or `value: <SeatMapFilters>` when at least one parsed. Returns
 * `null` on unrecognized syntax (caller treats as not-a-seat-map).
 *
 * Suffix grammar (any order, slash-separated, plus optional #<airport>):
 *   /<pref>     NW | NA | SW | SA | N | S | W | A
 *   /<row>      bare digits = from-row offset
 *   /<class>-<n>  e.g. F-3, Y-2 — pax count
 *   #<airport>  e.g. #BRU — change-of-gauge leg
 *
 * Tested forms (per galileoindonesia.com guide):
 *   SA*S4              no filters
 *   SA*S4/15           fromRow 15
 *   SA*S4/NW           pref NW
 *   SA*S4/NW/15        pref NW + fromRow 15
 *   SA*S4#BRU          cogOrigin BRU
 *   SA*A1F/NW          (SM-form) pref NW
 *   SA*A1Y/S-2         pref S + paxCount 2 (class Y already in body)
 *   SA*AA101Y1JUNLHRJFK/N-3   pref N + paxCount 3
 */
type SeatMapFilters = NonNullable<import('../../protocol/entry.js').SeatMapEntry['filters']>;
function parseSeatMapFilters(tail: string): { empty: true } | { empty: false; value: SeatMapFilters } | null {
  if (!tail) return { empty: true };
  let rest = tail;
  const filters: SeatMapFilters = {};
  // Peel off change-of-gauge marker first (anywhere in the tail).
  const cogMatch = /#([A-Z]{3})/.exec(rest);
  if (cogMatch) {
    filters.cogOrigin = cogMatch[1];
    rest = rest.slice(0, cogMatch.index) + rest.slice(cogMatch.index + cogMatch[0].length);
  }
  // Remaining tail is slash-separated tokens (or empty).
  if (rest && !rest.startsWith('/')) return null; // expected leading `/`
  const tokens = rest ? rest.slice(1).split('/').filter((t) => t.length > 0) : [];
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      filters.fromRow = parseInt(tok, 10);
    } else if (/^(NW|NA|SW|SA|N|S|W|A)$/.test(tok)) {
      filters.preference = tok as SeatMapFilters['preference'];
    } else if (/^[A-Z]-\d+$/.test(tok)) {
      filters.paxCount = parseInt(tok.split('-')[1], 10);
    } else {
      return null; // unrecognized suffix token
    }
  }
  const anySet = filters.preference || filters.fromRow !== undefined ||
                 filters.paxCount !== undefined || filters.cogOrigin;
  return anySet ? { empty: false, value: filters } : { empty: true };
}

function parseDivide(raw: string, u: string): DivideEntry {
  const m = /^DP(\d+)$/.exec(u);
  if (!m) throw new ParseError(`Galileo DP: expected DP<n> in "${raw}"`);
  const passenger = parseInt(m[1], 10);
  if (passenger <= 0) throw new ParseError(`Galileo DP: zero passenger in "${raw}"`);
  // We store the overall passenger number under `item`; the handler
  // walks the name list to resolve it to (item, passenger-in-item).
  return {
    kind: 'divide',
    raw,
    timestamp: new Date(),
    refs: [{ item: passenger }],
  };
}
