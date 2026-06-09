/**
 * Amadeus dialect — emulated-only, format-grounded v1+v2.
 *
 * Amadeus is the third GDS the project ships behind the Dialect seam.
 * Unlike Galileo and Apollo (which share Travelport's TripServices
 * REST surface), Amadeus is a separate vendor with no Travelport-style
 * creds path. The Amadeus dialect ships fully emulated — the project
 * owns the behavior layer.
 *
 * Cryptic sourced verbatim from `references/amadeus/Amadeus-Cryptic-
 * Entries-Reference-Guide-Ed-9.2-2012.pdf` (Edition 9.2, July 2012,
 * Amadeus Global Learning Services). Format coverage is A-grade for
 * 11 of 12 fidelity categories.
 *
 * Implemented verbs:
 *
 *   | Verb                          | Cryptic              | Example          |
 *   |-------------------------------|----------------------|------------------|
 *   | v1: sign-on family                                                      |
 *   | Sign in (first work area)     | JI<duty><init>/<sys> | JI2345HA/GS      |
 *   | Sign in to specific area      | JIA<duty><init>/<sys>| JIA2345HA/GS     |
 *   | Sign out current area         | JO                   | JO               |
 *   | Sign out all areas            | JO*                  | JO*              |
 *   | Display work area status      | JD                   | JD               |
 *   |                                                                         |
 *   | v2: PNR build cycle                                                     |
 *   | Availability                  | AN<date><orig><dest> | AN15JULJFKLAX    |
 *   |                                | [time]               | AN15JULJFKLAX1430|
 *   | Sell from avail line          | SS<seats><class><ln> | SS1Y1            |
 *   | Name (single-pax)             | NM1<sur>/<given>     | NM1SMITH/JOHN MR |
 *   | Agency phone                  | AP<phone>-<purpose>  | AP020 555-1212-A |
 *   | Received-from                 | RF<text>             | RF SMITH         |
 *   | Ticketing field               | TKOK or TKTL<date>   | TKTL15JUL        |
 *   | End-transaction               | ET (with redisplay)  | ET               |
 *   |                                | ER (just end)        | ER               |
 *   | Retrieve PNR                  | RT<locator>          | RTABC123         |
 *   | Ignore                        | IG                   | IG               |
 *
 * Everything else returns `NOT IMPLEMENTED — amadeus dialect (v2)`.
 * Following the project's honest-boundary principle (per ROADMAP item
 * "Hybrid coverage, made explicit"): an explicit "not implemented"
 * stub is much better than a silent format error or, worse, a fake
 * success that doesn't reflect real Amadeus behavior.
 *
 * Behavior layer caveat: pricing (NUC/ROE/HIP fare construction),
 * MCT exceptions, alliance ranking are deferred to v3+. Those have
 * no public source documentation — they would be format-faithful,
 * behavior-synthesized when added. Flag that explicitly when those
 * handlers land.
 *
 * Chain operator: Amadeus uses `;` to combine entries (per CLAUDE.md
 * Dialect docstring: "Sabre uses `§`; Amadeus uses `;`"). Single
 * entries with no `;` return as [self].
 */

import type { Dialect } from '../dialect.js';
import type { WorkArea } from '../../session/work-area.js';
import type { HandlerContext } from '../../session/handlers/index.js';
import { SessionEvent } from '../../session/session-state.js';
import { generateRecordLocator } from '../../models/record-locator.js';
import type { AirSegment } from '../../models/segment.js';
import { StatusCode, MANUAL_STATUS_CODES } from '../../protocol/constants.js';
import { priceItinerary } from '../../session/handlers/pricing-handler.js';
import { ticketNumber } from '../../models/ticket.js';
import { COMPANY_NAMES as CAR_COMPANY_NAMES } from '../../store/car-seed.js';
import { fareFor, BOOKING_CLASSES } from '../../store/tariff.js';
import { MIN_CONNECT_MINUTES } from '../../store/inventory.js';
import { synthesizeAvailability, synthesizeDecorations } from '../../models/seat-map.js';
import { renderSeatMap, amadeusSeatMapHeader, AMADEUS_GLYPHS, type RenderOrientation } from '../../render/seat-map-render.js';

/**
 * Rows shown per page in a paginated SM render (chunk 7). Terminal
 * displays are typically 24 lines; 20 leaves room for headers, cabin
 * labels, exit-row dividers, footer + legend.
 */
const SM_PAGE_SIZE = 20;

const NOT_IMPLEMENTED = 'NOT IMPLEMENTED — amadeus dialect (v2)';
const FORMAT_ERROR = 'FORMAT';
const NEED_AGENT_SIGN = 'NEEDS AGENT SIGN'; // reconstructed (Amadeus QRG p.7 lists no exact error wording for this)
const NO_AVAIL = 'NO AVAILABILITY'; // reconstructed
const NO_ITINERARY = 'NO ITINERARY'; // reconstructed (Amadeus's "NO ITIN")
const PNR_NOT_FOUND = 'PNR NOT FOUND'; // reconstructed (Amadeus QRG uses various wordings for retrieve failures)
const NEED_MANDATORY = 'CHECK MANDATORY FIELDS'; // reconstructed

/**
 * Errors that halt a chained entry. Same convention as the other
 * dialects — first error stops further verbs in the chain.
 */
const ERROR_RESPONSES = new Set<string>([
  NOT_IMPLEMENTED,
  FORMAT_ERROR,
  NEED_AGENT_SIGN,
  NO_AVAIL,
  NO_ITINERARY,
  PNR_NOT_FOUND,
  NEED_MANDATORY,
]);

/**
 * Frequent-flyer programs by carrier code. Drives the `VFFD` agreements
 * display. Reconstructed — the QRG only documents the entry forms
 * (`VFFD` / `VFFD <carrier>`), not the response wording or which
 * carriers are "agreed" on a given Amadeus office. Curated list of
 * major carriers an operator would actually query against.
 */
const VFFD_PROGRAMS: Record<string, string> = {
  AA: 'AADVANTAGE',
  AC: 'AEROPLAN',
  AF: 'FLYING BLUE',
  AS: 'MILEAGE PLAN',
  BA: 'EXECUTIVE CLUB',
  CX: 'CATHAY',
  DL: 'SKYMILES',
  EI: 'AERCLUB',
  EK: 'SKYWARDS',
  FI: 'SAGA CLUB',
  IB: 'IBERIA PLUS',
  JL: 'JAL MILEAGE BANK',
  KL: 'FLYING BLUE',
  LH: 'MILES AND MORE',
  LX: 'MILES AND MORE',
  NH: 'ANA MILEAGE CLUB',
  OS: 'MILES AND MORE',
  QF: 'QANTAS FREQUENT FLYER',
  QR: 'PRIVILEGE CLUB',
  SQ: 'KRISFLYER',
  TK: 'MILES AND SMILES',
  UA: 'MILEAGEPLUS',
  VS: 'FLYING CLUB',
};

/** Amadeus uses 3-letter month abbreviations in cryptic dates (DDMON). */
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_LETTERS = ['S', 'M', 'T', 'W', 'Q', 'F', 'J']; // Sun-Sat (Sabre convention)

/**
 * Push (or pull) a DDMON date by a number of days. Used by RRN/DP<n>
 * (forward) and RRN/DM<n> (backward) to roll dates across all segments
 * of a copied PNR. Returns the input unchanged if it doesn't parse.
 *
 * Year wrap is handled by JS Date arithmetic: the current year is
 * assumed for the base, then setUTCDate(+days) lets Date roll over
 * month and year boundaries naturally.
 */
function pushDdmonByDays(ddmon: string, days: number): string {
  const m = /^(\d{1,2})([A-Z]{3})$/.exec(ddmon);
  if (!m) return ddmon;
  const day = parseInt(m[1], 10);
  const month = MONTHS.indexOf(m[2]);
  if (month < 0) return ddmon;
  const year = new Date().getUTCFullYear();
  const base = new Date(Date.UTC(year, month, day));
  base.setUTCDate(base.getUTCDate() + days);
  const newDay = String(base.getUTCDate()).padStart(2, '0');
  return `${newDay}${MONTHS[base.getUTCMonth()]}`;
}

/**
 * Parse an Amadeus DDMON date (e.g. `15JUL`) to a date-of-week tuple
 * matching the Inventory.availability signature. The current year is
 * implied. Returns undefined if the input isn't a valid DDMON.
 */
function parseAmadeusDate(s: string): { raw: string; dow: { letter: string; num: number } } | undefined {
  const m = /^(\d{1,2})([A-Z]{3})$/.exec(s);
  if (!m) return undefined;
  const day = parseInt(m[1], 10);
  const month = MONTHS.indexOf(m[2]);
  if (month < 0 || day < 1 || day > 31) return undefined;
  // Default to the current year. If the date has already passed, roll forward.
  // (Reconstructed; Amadeus's actual year-roll heuristic isn't in the QRG.)
  const now = new Date();
  let year = now.getUTCFullYear();
  const candidate = new Date(Date.UTC(year, month, day));
  if (candidate < now && now.getUTCMonth() > month) year += 1;
  const realDate = new Date(Date.UTC(year, month, day));
  const dowNum = realDate.getUTCDay(); // 0=Sun
  return {
    raw: `${m[1].padStart(2, '0')}${m[2]}`,
    dow: { letter: DOW_LETTERS[dowNum], num: dowNum + 1 },
  };
}

/** Parse `AN<date><orig><dest>[<time>]`. Time is 4-digit HHMM (optional). */
function parseAvailability(arg: string): { date: string; dow: { letter: string; num: number }; origin: string; destination: string; afterMinutes?: number } | undefined {
  // Date is up to 5 chars (DDMON). City pairs are 6 chars (ORIG+DEST).
  // Optional trailing 4-digit time.
  const m = /^(\d{1,2}[A-Z]{3})([A-Z]{3})([A-Z]{3})(\d{4})?$/.exec(arg);
  if (!m) return undefined;
  const date = parseAmadeusDate(m[1]);
  if (!date) return undefined;
  let afterMinutes: number | undefined;
  if (m[4]) {
    const hh = parseInt(m[4].slice(0, 2), 10);
    const mm = parseInt(m[4].slice(2, 4), 10);
    if (hh < 24 && mm < 60) afterMinutes = hh * 60 + mm;
  }
  return { date: date.raw, dow: date.dow, origin: m[2], destination: m[3], afterMinutes };
}

const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR', 'PROF', 'MSTR', 'CHD', 'INF']);

function splitTitle(rawGiven: string): { given: string; title?: string } {
  const parts = rawGiven.split(/\s+/);
  if (parts.length > 1 && TITLES.has(parts[parts.length - 1])) {
    return { title: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
  }
  return { given: rawGiven };
}

/**
 * Parse Amadeus name entry. v3 supports:
 *   NM1<sur>/<given> <title>                single-pax            (v2)
 *   NM<n><sur>/<given1> <title>/<given2>... multi-pax same surname (v3)
 *
 * QRG p.29 examples:
 *   NM1SMITH/JOHN MR
 *   NM3LEE/SAM MR/JOAN MRS/TOM MR
 *
 * The leading digit n is the count of passengers — they MUST share the
 * surname. For passengers with different surnames, the QRG shows TWO
 * separate NM entries; the dispatch handles that by accumulating
 * pnr.names across calls.
 *
 * Returns a single NameItem the dispatcher pushes onto pnr.names.
 */
function parseName(arg: string): {
  surname: string;
  passengers: Array<{ given: string; title?: string }>;
  count: number;
} | undefined {
  const m = /^([1-9])([A-Z]+)\/(.+)$/.exec(arg);
  if (!m) return undefined;
  const count = parseInt(m[1], 10);
  const surname = m[2];
  // Split given-names section on `/`. Each chunk is `<given> [title]`.
  const chunks = m[3].split('/').map((c) => c.trim()).filter((c) => c.length > 0);
  if (chunks.length === 0) return undefined;
  const passengers = chunks.map((c) => splitTitle(c));
  // Per Amadeus QRG: `NM<n><sur>/<given1>/<given2>...` — the count is
  // the number of pax. When the user supplies only ONE given-name chunk
  // for NM2+ (e.g. `NM2SCHWARZ/MANFRED MR/SABINE`), v3 accepts both
  // chunks too. We trust the supplied count even if chunks.length
  // differs — the response will reflect what was parsed.
  return { surname, passengers, count };
}

/** Parse `SS<seats><class><line>` — sell from cached availability. */
function parseSell(arg: string): { seats: number; bookingClass: string; line: number } | undefined {
  const m = /^([1-9])([A-Z])([1-9]\d?)$/.exec(arg);
  if (!m) return undefined;
  return {
    seats: parseInt(m[1], 10),
    bookingClass: m[2],
    line: parseInt(m[3], 10),
  };
}

/**
 * Parse Amadeus segment-number list. Supports comma-separated singles
 * and ranges: `2,4-6,8` → `[2, 4, 5, 6, 8]`. Returns undefined on any
 * malformed token; returns [] for an empty input.
 */
function parseSegmentList(arg: string): number[] | undefined {
  if (arg.trim() === '') return undefined;
  const out: number[] = [];
  for (const part of arg.split(',')) {
    const range = /^([1-9]\d?)-([1-9]\d?)$/.exec(part);
    const single = /^([1-9]\d?)$/.exec(part);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      if (a > b) return undefined;
      for (let i = a; i <= b; i++) out.push(i);
    } else if (single) {
      out.push(parseInt(single[1], 10));
    } else {
      return undefined;
    }
  }
  return out;
}

/**
 * Parse SSR text after `SR `. QRG p.34 patterns:
 *   `LSML`                       (4-char code, all pax, default carrier YY)
 *   `VGMLLH`                     (code + 2-char carrier)
 *   `VGML/P1-3`                  (passenger association)
 *   `BIKENN2/P1`                 (code + free text + association)
 *   `INFT-JONES/TOM 02FEB06/P2`  (carrier-tagged data + association)
 *
 * Returns { code, carrier?, text?, nameRef? } or undefined for malformed.
 */
function parseSsr(arg: string): {
  code: string;
  carrier?: string;
  text?: string;
  nameRef?: { item: number; passenger?: number };
} | undefined {
  // Split off passenger association tail `/P<n>[.<m>]` or `/P<a>-<b>`.
  let body = arg;
  let nameRef: { item: number; passenger?: number } | undefined;
  const tailMatch = /\/P(\d+)(?:\.(\d+))?$/.exec(body);
  if (tailMatch) {
    nameRef = {
      item: parseInt(tailMatch[1], 10),
      passenger: tailMatch[2] ? parseInt(tailMatch[2], 10) : undefined,
    };
    body = body.slice(0, tailMatch.index);
  }
  // Code is the first 4 uppercase letters.
  const codeMatch = /^([A-Z]{4})/.exec(body);
  if (!codeMatch) return undefined;
  const code = codeMatch[1];
  let rest = body.slice(4);
  let carrier: string | undefined;
  // Optional 2-letter carrier directly after the code (no separator).
  const carrierMatch = /^([A-Z0-9]{2})(?=[\s/-]|$)/.exec(rest);
  if (carrierMatch) {
    carrier = carrierMatch[1];
    rest = rest.slice(2);
  }
  const text = rest.replace(/^[\s/-]+/, '').trim() || undefined;
  return { code, carrier, text, nameRef };
}

/**
 * Parse OSI text after `OS `. Pattern: `<carrier> <text>[/P<n>]`.
 * QRG p.34: `OS QF VIP COMPANY CEO/P2`.
 */
function parseOsi(arg: string): { carrier: string; text: string } | undefined {
  const m = /^([A-Z]{2})\s+(.+?)(\/P\d+(?:\.\d+)?)?$/.exec(arg.trim());
  if (!m) return undefined;
  return { carrier: m[1], text: m[2].trim() };
}

/**
 * Parse `FFN <carrier>-<number>[/P<n>]` — frequent-flyer element.
 * QRG p.39 example: `FFN BW-123456789/P1`.
 * Carrier is 2 letters/digits, number is alphanumeric (1-15 chars),
 * optional /P<n> binds the FF to a passenger.
 */
function parseFfn(arg: string): {
  carrier: string;
  number: string;
  nameRef?: { item: number; passenger?: number };
} | undefined {
  // Trailing `/P<n>[.<m>]` passenger binding.
  let body = arg.trim();
  let nameRef: { item: number; passenger?: number } | undefined;
  const tailMatch = /\/P(\d+)(?:\.(\d+))?$/.exec(body);
  if (tailMatch) {
    nameRef = {
      item: parseInt(tailMatch[1], 10),
      passenger: tailMatch[2] ? parseInt(tailMatch[2], 10) : undefined,
    };
    body = body.slice(0, tailMatch.index);
  }
  const m = /^([A-Z0-9]{2})-([A-Z0-9]{1,15})$/.exec(body);
  if (!m) return undefined;
  return { carrier: m[1], number: m[2], nameRef };
}

/**
 * Parse `FQD<orig><dest>[/<date>][/A<carrier>]` — fare display.
 * QRG p.23 examples (under Direct Access `1XXFQD`); the standalone FQD
 * form is reconstructed since the QRG only documents the airline-
 * specific direct-access variant. Recognized qualifiers:
 *   FQDLAXNYC                       → basic, all classes
 *   FQDLAXNYC/15JUL                 → date specified
 *   FQDLAXNYC/AAA                   → carrier specified
 *   FQDLAXNYC/15JUL/AAA             → both
 */
function parseFqd(arg: string): {
  origin: string;
  destination: string;
  date?: string;
  carrier?: string;
} | undefined {
  // Origin + destination are the first 6 characters (3+3 IATA).
  const m = /^([A-Z]{3})([A-Z]{3})(\/.+)?$/.exec(arg);
  if (!m) return undefined;
  const result: { origin: string; destination: string; date?: string; carrier?: string } = {
    origin: m[1],
    destination: m[2],
  };
  if (m[3]) {
    for (const q of m[3].slice(1).split('/')) {
      if (/^\d{1,2}[A-Z]{3}$/.test(q)) result.date = q;
      else if (/^A[A-Z0-9]{2}$/.test(q)) result.carrier = q.slice(1);
    }
  }
  return result;
}

import type { Pnr } from '../../models/pnr.js';
import type { FareQuote } from '../../models/fare.js';
import type { SeatMap } from '../../models/seat-map.js';

/**
 * Parse an `SM ...` entry into a typed request shape, or undefined if
 * it doesn't match any SM form. Three shapes (chunks 2+3):
 *   { kind: 'segment', segment }
 *   { kind: 'direct', carrier, flightNumber, cls?, date?, origin, destination }
 *   { kind: 'avail-line', line, subFlight?, cls? }
 * All three carry an `orientation` (V default, H from `/H` suffix).
 */
type SmRequest =
  | { kind: 'segment'; segment: number; orientation: RenderOrientation; showLegend: boolean }
  | {
      kind: 'direct';
      carrier: string;
      flightNumber: string;
      cls?: string;
      date?: string;
      origin: string;
      destination: string;
      orientation: RenderOrientation;
      showLegend: boolean;
    }
  | {
      kind: 'avail-line';
      line: number;
      subFlight?: number;
      cls?: string;
      orientation: RenderOrientation;
      showLegend: boolean;
    };

function parseSmRequest(entry: string): SmRequest | undefined {
  // Strip an optional /NL (no-legend) or /L (legend, default) suffix
  // before regex matching. Order of suffixes is /<V|H>/<NL|L>, but we
  // peel them in either order — they're independent cosmetic flags.
  let working = entry;
  let showLegend = true;
  if (working.endsWith('/NL')) {
    showLegend = false;
    working = working.slice(0, -3);
  } else if (working.endsWith('/L')) {
    showLegend = true;
    working = working.slice(0, -2);
  }
  // SM/<digits>[/<digit>][/<class>][/V|/H] — from cached availability
  const availMatch = /^SM\/(\d{1,2})(?:\/(\d))?(?:\/([A-Z]))?(?:\/([VH]))?$/.exec(working);
  if (availMatch) {
    let cls: string | undefined = availMatch[3];
    let orientation = (availMatch[4] ?? 'V') as RenderOrientation;
    // Disambiguation: when class slot captures `V` or `H` and there's
    // no explicit orientation suffix after it, treat the class as the
    // orientation. Booking classes V and H exist but are rare in
    // emulated SCHEDULE; orientation suffix is the more common reading.
    if (!availMatch[4] && (cls === 'V' || cls === 'H')) {
      orientation = cls;
      cls = undefined;
    }
    return {
      kind: 'avail-line',
      line: parseInt(availMatch[1], 10),
      subFlight: availMatch[2] ? parseInt(availMatch[2], 10) : undefined,
      cls,
      orientation,
      showLegend,
    };
  }
  // SM <args> (space-separated)
  if (!working.startsWith('SM ')) return undefined;
  const args = working.slice(3);
  // Segment form: digits only (optionally /V or /H)
  const segMatch = /^(\d{1,2})(?:\/([VH]))?$/.exec(args);
  if (segMatch) {
    return {
      kind: 'segment',
      segment: parseInt(segMatch[1], 10),
      orientation: (segMatch[2] ?? 'V') as RenderOrientation,
      showLegend,
    };
  }
  // Direct form: <carrier 2 chars><flight 1-4 digits>/<class>?/[<date>?]<route 6>[/V|/H]
  // QRG p.39 examples: SM LH330/Y/FRAJFK, SM IB123/C/14AUGMADCDG, SM SK862//28SEPSTOLHR
  const directMatch =
    /^([A-Z0-9]{2})(\d{1,4})\/([A-Z])?\/(\d{1,2}[A-Z]{3})?([A-Z]{6})(?:\/([VH]))?$/.exec(args);
  if (directMatch) {
    return {
      kind: 'direct',
      carrier: directMatch[1],
      flightNumber: directMatch[2],
      cls: directMatch[3],
      date: directMatch[4],
      origin: directMatch[5].slice(0, 3),
      destination: directMatch[5].slice(3, 6),
      orientation: (directMatch[6] ?? 'V') as RenderOrientation,
      showLegend,
    };
  }
  return undefined;
}

/** Construct a synthetic AirSegment for the renderer header from raw
 *  carrier/flight/date/route fields (used for direct + avail-line forms
 *  where there's no real PNR segment). */
function synthSegment(
  carrier: string,
  flightNumber: string,
  date: string,
  origin: string,
  destination: string,
  segmentNumber: number,
  cls?: string,
): AirSegment {
  return {
    segmentNumber,
    carrier,
    flightNumber,
    bookingClass: cls ?? 'Y',
    date,
    dayOfWeek: '?',
    dayOfWeekNum: 0,
    origin,
    destination,
    status: StatusCode.SS,
    seats: 1,
    departTime: '',
    arriveTime: '',
  };
}

/**
 * Resolve an SmRequest to the seat map + segment context the renderer
 * needs. Returns a string on the error path (the rendered host
 * response) or a `{ map, segment, segmentNumber }` triple on success.
 */
function resolveSm(
  req: SmRequest,
  wa: WorkArea,
  ctx: HandlerContext,
): string | { map: SeatMap; segment: AirSegment; segmentNumber: number } {
  if (req.kind === 'segment') {
    if (wa.pnr.segments.length === 0) return NO_ITINERARY;
    const seg = wa.pnr.segments.find((s) => s.segmentNumber === req.segment);
    if (!seg) return 'SEGMENT NOT IN ITINERARY';
    const map = ctx.backend.inventory.seatMapFor(seg.carrier, seg.flightNumber);
    if (!map) return 'NO SEAT MAP AVAILABLE';
    return { map, segment: seg, segmentNumber: req.segment };
  }
  if (req.kind === 'direct') {
    // Look up the schedule to get the canonical equipment / times.
    const sched = ctx.backend.inventory.scheduleFor(req.carrier, req.flightNumber);
    if (!sched) return 'NO SCHEDULE FOUND';
    const map = ctx.backend.inventory.seatMapFor(req.carrier, req.flightNumber);
    if (!map) return 'NO SEAT MAP AVAILABLE';
    // Default date if not supplied (QRG "current date"). 01JAN is a
    // deterministic placeholder; the synthesizer keys on it so the same
    // dateless query is reproducible.
    const date = req.date ?? '01JAN';
    const seg = synthSegment(req.carrier, req.flightNumber, date, req.origin, req.destination, 1, req.cls);
    return { map, segment: seg, segmentNumber: 1 };
  }
  // avail-line
  if (!wa.lastAvailability) return 'NO AVAILABILITY';
  const lines = wa.lastAvailability.lines;
  const target = lines.find((l) => l.line === req.line);
  if (!target) return 'LINE NOT IN AVAILABILITY';
  const map = ctx.backend.inventory.seatMapFor(target.carrier, target.flightNumber, target.equipment);
  if (!map) return 'NO SEAT MAP AVAILABLE';
  const seg = synthSegment(
    target.carrier,
    target.flightNumber,
    target.date,
    target.origin,
    target.destination,
    1,
    req.cls,
  );
  return { map, segment: seg, segmentNumber: 1 };
}

/** Render a retrieved PNR (response to RT<locator>). */
function renderAmadeusPnr(pnr: Pnr, pcc: string, agent?: string): string {
  const lines: string[] = [`RP/${pcc}/${agent ?? '----'}  ${pnr.locator ?? ''}`];
  pnr.names.forEach((n, i) => {
    n.passengers.forEach((pax, j) => {
      const title = pax.title ? ` ${pax.title}` : '';
      const seq = n.passengers.length > 1 ? `${i + 1}.${j + 1}` : `${i + 1}`;
      lines.push(`  ${seq}. ${n.surname}/${pax.firstName}${title}`);
    });
  });
  pnr.segments.forEach((s) => {
    lines.push(`  ${s.segmentNumber}. ${s.carrier} ${s.flightNumber} ${s.bookingClass} ${s.date} ${s.origin} ${s.destination} ${s.status}${s.seats}`);
  });
  return lines.join('\n');
}

/** Render the itinerary block (segments only). */
function renderAmadeusItinerary(pnr: Pnr): string {
  return pnr.segments
    .map((s) => `  ${s.segmentNumber}. ${s.carrier} ${s.flightNumber} ${s.bookingClass} ${s.date} ${s.origin} ${s.destination} ${s.status}${s.seats}`)
    .join('\n');
}

/**
 * Append an audit-trail entry to pnr.history. Amadeus's actual history
 * format uses an `RH` display with timestamp + actor + change code; we
 * record a free-text line and let `renderAmadeusHistory` lay it out.
 * Sell / cancel / status-change handlers call this so RH later shows
 * a recognizable audit trail.
 */
function recordHistory(pnr: Pnr, text: string): void {
  pnr.history.push({ timestamp: new Date(), text });
}

/**
 * Render `RH` — Amadeus PNR change history. The QRG mentions history
 * in print contexts (p.49 `WRA/RH`); the display form `RH` is
 * reconstructed from mainframe-Amadeus convention since the QRG
 * doesn't show response wording literally. Empty history returns
 * the canonical "NO HISTORY" reconstructed string.
 */
function renderAmadeusHistory(pnr: Pnr): string {
  if (pnr.history.length === 0) return 'NO HISTORY';
  const head = `RH ${pnr.locator ?? ''}`.trim();
  const rows = pnr.history.map((h, i) => {
    const hh = String(h.timestamp.getUTCHours()).padStart(2, '0');
    const mm = String(h.timestamp.getUTCMinutes()).padStart(2, '0');
    return `${String(i + 1).padStart(3)}. ${hh}:${mm} ${h.text}`;
  });
  return [head, ...rows].join('\n');
}

/**
 * Render an Amadeus-style fare quote.
 *
 * Reconstructed format — the QRG p.37 doesn't show the actual response
 * layout for FXP. We use a compact passenger-block style derived from
 * the shared FareQuote model: passenger-type / count / base / tax / total
 * per pax, plus the fare-basis codes (one per segment) summarized at
 * the end. The intent is "operator can read it and see what was priced",
 * not "byte-equivalent to real Amadeus".
 */
function renderAmadeusFareQuote(fq: FareQuote, sequence: number): string {
  const lines: string[] = [`FXP ${sequence}`];
  for (const block of fq.passengers) {
    const total = block.total.toFixed(2);
    const base = block.base.toFixed(2);
    const tax = block.taxTotal.toFixed(2);
    lines.push(`  ${block.passengerType}  ${block.count}  ${base}  ${tax}  ${total} ${fq.currency}`);
  }
  if (fq.fareBasis.length > 0) {
    lines.push(`  FB ${fq.fareBasis.join(' ')}`);
  }
  return lines.join('\n');
}

/**
 * Amadeus chain operator (`;`). The QRG doesn't document chain
 * semantics, but mainframe Amadeus terminals have always used `;`
 * to combine entries. Single entries with no `;` return as `[raw]`.
 */
function splitAmadeusChain(raw: string): string[] {
  return raw.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Parse the Amadeus sign-on argument `<duty><initials>/<system>`,
 * e.g. `2345HA/GS`. Returns the initials part (used as the agent id
 * on the WorkArea) or undefined when the format doesn't match.
 *
 * The duty code (1-4 digits) and initials (1-3 letters) parse loosely
 * since the QRG doesn't pin down their lengths absolutely. The trailing
 * `/<system>` qualifier is accepted but not validated against a known
 * system list — pre-prod Amadeus would reject unknown systems, but
 * since we ship no live backend, we accept any.
 */
function parseSignInArgument(arg: string): { agent: string } | undefined {
  const match = /^(\d{1,4})([A-Z]{1,3})\/([A-Z]{1,3})$/.exec(arg);
  if (!match) return undefined;
  return { agent: match[2] };
}

/**
 * Issue Amadeus e-tickets — one per seat-occupying passenger. Reuses
 * the shared TicketRecord model + airlineNumericCode/ticketNumber
 * helpers that Sabre's W¥ also uses, so a downstream `*T`-style
 * display works identically across dialects.
 *
 * Issuance pulls fare blocks from the priced quote in the order the
 * Sabre handler does (FQ → priceQuotes[0]) and assigns each passenger
 * to one fare block via positional pairing. Multi-PQ ordering / multi-
 * carrier mixes / segment-specific fares are out of scope for chunk 19;
 * we use the first available quote.
 */
function issueAmadeusTickets(
  pnr: Pnr,
  ctx: HandlerContext,
  ticketType: 'TE' | 'TK',
): import('../../models/ticket.js').TicketRecord[] {
  const tickets: import('../../models/ticket.js').TicketRecord[] = [];
  const fq = pnr.priceQuotes[0];
  const passengers = pnr.names.filter((n) => !n.infant);
  // Fare-block expansion: one entry per passenger seat in priceQuotes[0].
  const fares: { base: number; taxTotal: number; total: number }[] = [];
  for (const pp of fq.passengers ?? []) {
    for (let i = 0; i < pp.count; i++) {
      fares.push({ base: pp.base, taxTotal: pp.taxTotal, total: pp.total });
    }
  }
  const zero = { base: 0, taxTotal: 0, total: 0 };
  const intlSet = new Set(['JFK', 'LAX', 'SFO', 'LHR', 'CDG', 'FRA', 'AMS', 'NRT', 'HKG', 'SIN']); // narrow heuristic
  const tariff: 'D' | 'I' = pnr.segments.some(
    (s) => intlSet.has(s.origin) || intlSet.has(s.destination),
  ) ? 'I' : 'D';
  const validating = fq.validatingCarrier ?? pnr.segments[0]?.carrier ?? 'YY';
  let fareIdx = 0;
  for (const item of passengers) {
    for (let p = 0; p < item.count; p++) {
      const pax = item.passengers[p];
      const surname = item.surname;
      const initial = pax?.firstName?.[0] ?? '?';
      const fare = fares[fareIdx++] ?? fares[fares.length - 1] ?? zero;
      tickets.push({
        number: ticketNumber(validating, ctx.backend.nextTicketSerial()),
        type: ticketType,
        stock: 'AT',
        passenger: `${surname}/${initial}`,
        pcc: ctx.pcc,
        agent: undefined,
        issuedAt: new Date(),
        tariff,
        validatingCarrier: validating,
        base: fare.base,
        taxTotal: fare.taxTotal,
        total: fare.total,
        status: 'OPEN',
      });
    }
  }
  return tickets;
}

/**
 * Render the TTP "OK ETKT" success response with a brief per-ticket
 * summary. Format reconstructed from QRG conventions — the QRG p.211
 * documents the entry but not the verbatim response wording. Each
 * line shows the issued ticket number + passenger + total.
 */
function renderAmadeusTicketIssuance(
  tickets: import('../../models/ticket.js').TicketRecord[],
): string {
  if (tickets.length === 0) return 'OK ETKT';
  const lines = ['OK ETKT'];
  for (const t of tickets) {
    lines.push(`  TKT ${t.number}  ${t.passenger}  ${t.total.toFixed(2)} ${t.validatingCarrier}`);
  }
  return lines.join('\n');
}

/**
 * Render the TWD electronic-ticket-record display. Per QRG p.211-212:
 * one block per ticket showing the TKT number + status of each coupon.
 * Format reconstructed from QRG conventions:
 *
 *   TKT-<airline>-<ticket-number>  <status>
 *   FROM  TO    CPN  STATUS  FARE
 *   JFK   LAX   1    OPEN    198.00
 *   ...
 *   NAME: <passenger>
 *   ISSUED: <date>  PCC: <pcc>
 */
function renderAmadeusTwd(
  tickets: import('../../models/ticket.js').TicketRecord[],
  pnr: Pnr,
  singleLine?: number,
): string {
  const blocks: string[] = [];
  tickets.forEach((t, idx) => {
    const lineNo = singleLine ?? idx + 1;
    const lines: string[] = [];
    lines.push(`TKT-${t.validatingCarrier}-${t.number}  ${t.status ?? 'OPEN'}`);
    lines.push(`PAX: ${t.passenger}`);
    lines.push(`ISSUED ${formatTicketDate(t.issuedAt)}  PCC ${t.pcc}`);
    lines.push(`FARE ${t.base.toFixed(2)}  TAX ${t.taxTotal.toFixed(2)}  TOTAL ${t.total.toFixed(2)}`);
    // Per-segment coupon summary.
    pnr.segments.forEach((s, sIdx) => {
      lines.push(`  ${sIdx + 1}. ${s.carrier}${s.flightNumber} ${s.bookingClass} ${s.date} ${s.origin}-${s.destination}  CPN${sIdx + 1}: OPEN`);
    });
    blocks.push(`-- L${lineNo} --\n${lines.join('\n')}`);
  });
  return blocks.join('\n\n');
}

/**
 * Compact TWD list view (TWDRL). One line per ticket showing line
 * number + ticket number + passenger + status.
 */
function renderAmadeusTwdList(
  tickets: import('../../models/ticket.js').TicketRecord[],
): string {
  return tickets
    .map((t, i) => `${i + 1}. ${t.validatingCarrier} ${t.number}  ${t.passenger}  ${t.status ?? 'OPEN'}`)
    .join('\n');
}

/**
 * TWH electronic-ticket-record history display (QRG p.212). Reconstructed
 * format: one section per ticket with issue + status events.
 */
function renderAmadeusTwh(
  tickets: import('../../models/ticket.js').TicketRecord[],
): string {
  const blocks: string[] = [];
  for (const t of tickets) {
    blocks.push(
      `TKT-${t.validatingCarrier}-${t.number}`,
      `  ISSUE ${formatTicketDate(t.issuedAt)}  ${t.pcc}`,
      `  STATUS ${t.status ?? 'OPEN'}`,
    );
  }
  return blocks.join('\n');
}

/**
 * Render an Amadeus invoice or itinerary document. Format reconstructed
 * from QRG p.221 + p.225 conventions — the QRG documents what the
 * print verbs produce (passenger billing details / segments / fares /
 * tickets) but not the verbatim layout, so the structure here is
 * format-faithful to documented field naming.
 *
 * Variants:
 *   - kind 'invoice'  → header + passenger billing + fares + tickets
 *   - kind 'itinerary'→ header + segments (no fares)
 *   - extended       → adds tax breakdown + FOP + ticket numbers
 *   - joint          → one document with all selected pax (vs per-pax)
 *   - paxFilter / segFilter → restrict the output
 */
function renderAmadeusDocument(
  pnr: Pnr,
  opts: {
    kind: 'invoice' | 'itinerary';
    extended: boolean;
    joint: boolean;
    paxFilter?: number[];
    segFilter?: number[];
  },
): string {
  const docTitle = opts.kind === 'invoice'
    ? (opts.extended ? 'INVOICE (EXTENDED)' : 'INVOICE')
    : (opts.extended ? 'ITINERARY (EXTENDED)' : 'ITINERARY');
  const dateStr = formatTicketDate(new Date(2026, 5, 9));
  const lines: string[] = [];
  lines.push(`*** AMADEUS ${docTitle} ***`);
  lines.push(`DATE: ${dateStr}  PCC: ${pnr.locator ?? 'PENDING'}`);
  lines.push('');

  const allPax = opts.paxFilter ? pnr.names.filter((_, i) => opts.paxFilter!.includes(i + 1)) : pnr.names;
  const allSegs = opts.segFilter ? pnr.segments.filter((s) => opts.segFilter!.includes(s.segmentNumber)) : pnr.segments;

  // Joint = one block for all pax; non-joint = one block per pax.
  const paxGroups = opts.joint ? [allPax] : allPax.map((p) => [p]);

  for (const group of paxGroups) {
    if (paxGroups.length > 1) lines.push('---');
    // Passenger block.
    lines.push('PASSENGER(S):');
    for (const item of group) {
      const names = item.passengers
        .map((p) => `${p.firstName}${p.title ? ' ' + p.title : ''}`)
        .join(', ');
      lines.push(`  ${item.surname}: ${names}${item.infant ? ' (INFANT)' : ''}`);
    }
    // Segments block.
    lines.push('');
    lines.push('SEGMENTS:');
    for (const seg of allSegs) {
      lines.push(`  ${seg.segmentNumber}. ${seg.carrier}${seg.flightNumber} ${seg.bookingClass} ${seg.date} ${seg.origin}-${seg.destination}  ${seg.departTime}-${seg.arriveTime}  ${seg.status}`);
    }
    // Fares block (invoice only).
    if (opts.kind === 'invoice') {
      lines.push('');
      lines.push('FARES:');
      if (pnr.priceQuotes.length === 0) {
        lines.push('  (no priced quotes — run FXP)');
      } else {
        for (const fq of pnr.priceQuotes) {
          for (const pp of fq.passengers ?? []) {
            lines.push(`  ${pp.passengerType} x${pp.count}  ${pp.base.toFixed(2)}  TAX ${pp.taxTotal.toFixed(2)}  TOTAL ${pp.total.toFixed(2)} ${fq.currency}`);
          }
          // Extended invoice shows the per-tax breakdown from the
          // FareQuote's first passenger block (each PassengerFare
          // carries its own TaxItem[] in our model).
          if (opts.extended && fq.passengers[0]?.taxes?.length) {
            lines.push('  TAX BREAKDOWN:');
            for (const tax of fq.passengers[0].taxes) {
              lines.push(`    ${tax.code} ${tax.amount.toFixed(2)}`);
            }
          }
        }
      }
    }
    // Tickets block (extended invoice + extended itinerary).
    if (opts.extended && pnr.tickets.length > 0) {
      lines.push('');
      lines.push('TICKETS:');
      for (const t of pnr.tickets) {
        lines.push(`  ${t.validatingCarrier} ${t.number}  ${t.passenger}  ${t.status ?? 'OPEN'}  ${t.total.toFixed(2)}`);
      }
    }
    lines.push('');
  }

  // Trailer.
  lines.push(`*** END ${docTitle} ***`);
  return lines.join('\n');
}

/**
 * Render the Amadeus HA hotel-availability list. One line per
 * property: line-number + chain + name + lowest available rate.
 * Trailer notes the date range + total properties.
 */
function renderHotelAvailability(
  city: string,
  checkIn: string,
  checkOut: string,
  nights: number,
  properties: import('../../models/hotel.js').HotelProperty[],
): string {
  const lines: string[] = [];
  lines.push(`** AMADEUS HOTEL AVAILABILITY ${city} ${checkIn}${checkOut !== checkIn ? '-' + checkOut : ''} ${nights}N **`);
  properties.forEach((p, i) => {
    const lo = p.rates.reduce((min, r) => Math.min(min, r.amount), Infinity);
    const cur = p.rates[0]?.currency ?? '';
    lines.push(`${(i + 1).toString().padStart(2, ' ')} ${p.chain}${p.property}  ${p.name.padEnd(40, ' ')} FR ${lo.toFixed(0)} ${cur}`);
  });
  lines.push(`** ${properties.length} PROPERTIES **`);
  return lines.join('\n');
}

/** Render a sold hotel segment confirmation block. */
function renderHotelSegment(seg: import('../../models/hotel.js').HotelSegment): string {
  return [
    `OK HOTEL CONFIRMED ${seg.confirmationNumber ?? ''}`,
    `  ${seg.segmentNumber}. ${seg.chain}${seg.property}  ${seg.name}`,
    `     ${seg.city}  ${seg.checkIn}-${seg.checkOut}  ${seg.nights}N`,
    `     RATE ${seg.rateCode} ${seg.ratePerNight.toFixed(2)} ${seg.currency}/NT  ${seg.rooms}RM  ${seg.status}`,
  ].join('\n');
}

/**
 * Deterministic 5-digit confirmation number from (chain, property,
 * segment-index). Uses DJB2 string hash; same query → same number
 * across runs so tests are stable.
 */
function hotelConfirmationFor(chain: string, property: string, idx: number): string {
  let hash = 5381;
  const s = `${chain}|${property}|${idx}`;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return String(Math.abs(hash) % 90000 + 10000);
}

/**
 * Render the Amadeus CA car-availability list.
 */
function renderCarAvailability(
  city: string,
  pickup: string,
  dropoff: string,
  days: number,
  rentals: import('../../models/car.js').CarRental[],
): string {
  const lines: string[] = [];
  lines.push(`** AMADEUS CAR AVAILABILITY ${city} ${pickup}${dropoff !== pickup ? '-' + dropoff : ''} ${days}D **`);
  rentals.forEach((r, i) => {
    lines.push(`${(i + 1).toString().padStart(2, ' ')} ${r.company} ${r.vehicleType}  ${r.category.padEnd(22, ' ')} ${r.amount.toFixed(0).padStart(4)} ${r.currency}/DY`);
  });
  lines.push(`** ${rentals.length} VEHICLES **`);
  return lines.join('\n');
}

/** Render a sold car segment confirmation block. */
function renderCarSegment(seg: import('../../models/car.js').CarSegment): string {
  return [
    `OK CAR CONFIRMED ${seg.confirmationNumber ?? ''}`,
    `  ${seg.segmentNumber}. ${seg.company} ${seg.vehicleType}  ${seg.companyName} ${seg.category}`,
    `     ${seg.city}  ${seg.pickup}-${seg.dropoff}  ${seg.days}D`,
    `     RATE ${seg.rateCode} ${seg.amount.toFixed(2)} ${seg.currency}/DY  ${seg.status}`,
  ].join('\n');
}

/** Bump a DDMON date forward by N days within the same year. Crude
 *  ordinal arithmetic — fine for emulator use. */
function bumpDateByDays(date: string, n: number): string {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const m = /^(\d{1,2})([A-Z]{3})$/.exec(date);
  if (!m) return date;
  let day = parseInt(m[1], 10) + n;
  let mon = months.indexOf(m[2]);
  while (day > 31 && mon < 11) { day -= 31; mon++; }
  return `${day}${months[mon]}`;
}

/**
 * Estimate nights from two DDMON dates. Both are within the same
 * year for our emulator (cross-year ranges aren't seeded). Returns
 * 1 if dates can't be parsed (default 1-night stay).
 */
function computeNights(checkIn: string, checkOut: string): number {
  if (checkIn === checkOut) return 1;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const parse = (s: string): number | null => {
    const m = /^(\d{1,2})([A-Z]{3})$/.exec(s);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const mon = months.indexOf(m[2]);
    if (mon < 0) return null;
    return mon * 31 + day; // crude ordinal, enough for emulator
  };
  const a = parse(checkIn);
  const b = parse(checkOut);
  if (a == null || b == null) return 1;
  const nights = b - a;
  return nights > 0 ? nights : 1;
}

function formatTicketDate(d: Date): string {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = months[d.getUTCMonth()];
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${dd}${mon}${yy}`;
}

/**
 * IATA / FAA SSR codes that disqualify a passenger from an exit-row
 * seat. The carrier's tariff may be stricter (some carriers also
 * exclude PETC, ESAN, NSST, etc.) but these are the universally-
 * agreed core set. Per IATA Resolution 700 + 14 CFR 121.585.
 */
const EXIT_ROW_INELIGIBLE_SSRS: ReadonlySet<string> = new Set([
  'WCHR',  // wheelchair, can walk up steps
  'WCHS',  // wheelchair, can walk to seat with assistance
  'WCHC',  // wheelchair, completely immobile
  'BLND',  // blind passenger
  'DEAF',  // deaf passenger
  'MAAS',  // meet & assist (UMNR / elderly / disabled assistance)
  'DPNA',  // disabled passenger needing assistance
  'UMNR',  // unaccompanied minor
  'INFT',  // infant
  'BSCT',  // bassinet (implies infant)
]);

/** Titles that indicate a child or infant passenger. */
const CHILD_TITLES: ReadonlySet<string> = new Set([
  'CHD',   // child
  'INF',   // infant
  'MSTR',  // master (young boy)
]);

/**
 * Return a reason string if any passenger covered by `nameRef` is
 * ineligible for an exit-row seat, or `undefined` if all targeted
 * passengers are eligible.
 *
 * When `nameRef` is undefined, ALL passengers on the PNR are checked
 * (ST/<seat> with no /P<n> applies to all pax). When `nameRef` is
 * present, only that name item (and optionally the specific
 * passenger within the item) is checked.
 */
function findExitRowIneligible(
  pnr: import('../../models/pnr.js').Pnr,
  nameRef?: { item: number; passenger?: number },
): string | undefined {
  // Targeted name items.
  const itemsToCheck = nameRef
    ? [pnr.names[nameRef.item - 1]].filter((n): n is import('../../models/name-element.js').NameItem => !!n)
    : pnr.names;

  for (const item of itemsToCheck) {
    if (item.infant) return 'INFANT';
    // Per-passenger title check (CHD / INF / MSTR).
    const passengers = nameRef?.passenger != null
      ? [item.passengers[nameRef.passenger - 1]].filter(Boolean)
      : item.passengers;
    for (const p of passengers) {
      if (p?.title && CHILD_TITLES.has(p.title.toUpperCase())) {
        return p.title.toUpperCase() === 'INF' ? 'INFANT' : 'CHILD';
      }
    }
  }

  // SSR check — match any ineligible SSR whose nameRef targets one
  // of the checked passengers (or all pax if no nameRef on the SSR).
  const targetItemNumbers = nameRef
    ? new Set([nameRef.item])
    : new Set(pnr.names.map((_, i) => i + 1));
  for (const ssr of pnr.ssrs) {
    if (!EXIT_ROW_INELIGIBLE_SSRS.has(ssr.code)) continue;
    // SSR with no nameRef applies to all pax.
    if (!ssr.nameRef) return `SSR ${ssr.code}`;
    if (targetItemNumbers.has(ssr.nameRef.item)) {
      if (nameRef?.passenger != null && ssr.nameRef.passenger != null &&
          ssr.nameRef.passenger !== nameRef.passenger) continue;
      return `SSR ${ssr.code}`;
    }
  }

  return undefined;
}

export class AmadeusDialect implements Dialect {
  readonly id = 'amadeus' as const;
  readonly displayName = 'Amadeus';
  readonly bannerText =
    'Amadeus terminal — type a cryptic entry. JI<duty><initials>/<system> to sign on, .q to quit.';
  readonly screenName = 'AMADEUS';

  normalizeKeyboard(raw: string): string {
    return raw;
  }

  splitChain(raw: string): string[] {
    return splitAmadeusChain(raw);
  }

  processEntry(raw: string, wa: WorkArea, ctx: HandlerContext): string {
    const entry = raw.trim();
    if (entry.length === 0) return FORMAT_ERROR;

    // Sign-on family. JI prefix → sign-in; JO[*] → sign-out; JD → status.
    if (entry.startsWith('JI')) {
      const rest = entry.slice(2);
      const matchArea = /^([A-Z])([0-9].*)$/.exec(rest);
      const arg = matchArea ? matchArea[2] : rest;
      const parsed = parseSignInArgument(arg);
      if (!parsed) return FORMAT_ERROR;
      try {
        wa.machine.transition(SessionEvent.SIGN_IN);
      } catch {
        return FORMAT_ERROR;
      }
      wa.agent = parsed.agent;
      return `${parsed.agent} SIGNED IN`;
    }
    if (entry === 'JO' || entry === 'JO*') {
      if (!wa.agent) return NEED_AGENT_SIGN;
      const agent = wa.agent;
      try {
        wa.machine.transition(SessionEvent.SIGN_OFF);
      } catch {
        return FORMAT_ERROR;
      }
      wa.reset();
      return `${agent} SIGNED OUT`;
    }
    if (entry === 'JD') {
      if (!wa.agent) return NEED_AGENT_SIGN;
      return `WORK AREA STATUS\n  A  ${wa.agent}  [${wa.state()}]`;
    }

    // --- v2: PNR build cycle ---
    // All v2 verbs require an active sign-in (Amadeus QRG semantics).
    if (!wa.agent) return NEED_AGENT_SIGN;

    if (entry.startsWith('AN')) {
      const avail = parseAvailability(entry.slice(2));
      if (!avail) return FORMAT_ERROR;
      const lines = ctx.backend.inventory.availability(
        avail.date, avail.dow, avail.origin, avail.destination,
        avail.afterMinutes != null ? { afterMinutes: avail.afterMinutes } : {}
      );
      if (lines.length === 0) return NO_AVAIL;
      wa.lastAvailability = {
        date: avail.date, origin: avail.origin, destination: avail.destination, lines,
      };
      // Availability is a read-side operation; no state-machine event.
      // Render: "AN <DATE> <ORIG><DEST>" header + numbered lines.
      const header = `AN ${avail.date} ${avail.origin}${avail.destination}`;
      const rows = lines.map((l, i) => {
        const classes = Object.entries(l.classes)
          .filter(([, n]) => n > 0)
          .map(([c, n]) => `${c}${n > 9 ? 9 : n}`)
          .join(' ');
        return ` ${String(i + 1).padStart(2)} ${l.carrier} ${l.flightNumber.padEnd(4)} ${l.origin} ${l.destination} ${classes}`;
      });
      return [header, ...rows].join('\n');
    }

    if (entry.startsWith('SS')) {
      const sell = parseSell(entry.slice(2));
      if (!sell) return FORMAT_ERROR;
      const avail = wa.lastAvailability;
      if (!avail) return NO_AVAIL;
      const line = avail.lines[sell.line - 1];
      if (!line) return NO_AVAIL;
      const remaining = ctx.backend.inventory.sell(avail.date, line.carrier, line.flightNumber, sell.bookingClass, sell.seats);
      if (!remaining) return 'CLASS NOT AVAILABLE';
      const segment: AirSegment = {
        segmentNumber: wa.pnr.segments.length + 1,
        carrier: line.carrier,
        flightNumber: line.flightNumber,
        bookingClass: sell.bookingClass,
        date: avail.date,
        dayOfWeek: '?', dayOfWeekNum: 0,
        origin: line.origin, destination: line.destination,
        status: StatusCode.SS, seats: sell.seats,
        departTime: line.departTime, arriveTime: line.arriveTime,
      };
      wa.pnr.segments.push(segment);
      recordHistory(wa.pnr, `SELL ${segment.carrier}${segment.flightNumber}${segment.bookingClass}/${segment.date}`);
      try { wa.machine.transition(SessionEvent.SELL); } catch { /* */ }
      return ` ${segment.segmentNumber}. ${segment.carrier} ${segment.flightNumber} ${segment.bookingClass} ${segment.date} ${segment.origin} ${segment.destination} SS${segment.seats}`;
    }

    if (entry.startsWith('NM')) {
      const name = parseName(entry.slice(2));
      if (!name) return FORMAT_ERROR;
      wa.pnr.names.push({
        surname: name.surname,
        passengers: name.passengers.map((p) => ({ firstName: p.given, title: p.title })),
        count: name.passengers.length,
        infant: false,
      });
      recordHistory(wa.pnr, `NM ${name.surname}/${name.passengers.map((p) => p.given).join('/')}`);
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }

    if (entry.startsWith('AP')) {
      const phoneText = entry.slice(2).trim();
      if (!phoneText) return FORMAT_ERROR;
      // `AP020 555-1212-A` → store the whole right-hand side; Amadeus
      // separates with `-<purpose>` where A=Agency, B=Business, H=Home.
      const m = /^(.+?)-([ABH])$/.exec(phoneText);
      const number = m ? m[1].trim() : phoneText;
      const purpose = m?.[2];
      wa.pnr.phones.push({ number, type: purpose === 'B' ? 'business' : purpose === 'H' ? 'home' : 'agency' });
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }

    if (entry.startsWith('RF')) {
      const rf = entry.slice(2).trim();
      if (!rf) return FORMAT_ERROR;
      wa.pnr.receivedFrom = rf;
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }

    // --- v4 chunk 20: ticketing-arrangement element family ---
    // QRG p.153 (PNR ELEMENTS / Ticketing Arrangement). The TK
    // family covers seven action codes plus optional qualifiers:
    //   TKOK                  tickets issued, no queue placement
    //   TKTL<date>[/<office>] time-limit (must be ticketed by date)
    //   TKDO<date>[/<office>] domestic itinerary
    //   TKIN<date>[/<office>] international itinerary
    //   TKMA<date>[/<office>] tickets to be mailed
    //   TKSS                  self-service device (no date)
    //   TKXL<date>[/<office>] cancel itinerary if not ticketed by date
    // Qualifier suffixes (any prefix can carry these, per QRG p.153):
    //   /<office>             office ID like PARAF0245
    //   /<HHMM>               specific hour
    //   /P<n>                 passenger association
    //   /S<n>[-<m>]           segment association
    //   /C<n>                 alternative queue category
    //   /-<freeflow text>     free text remarks
    const tkMatch = /^TK(OK|TL|DO|IN|MA|SS|XL)(.*)$/.exec(entry);
    if (tkMatch) {
      const action = tkMatch[1];
      const tail = tkMatch[2];
      // TKOK and TKSS take no date but may carry /P/S/C qualifiers.
      // The other prefixes (TL/DO/IN/MA/XL) usually require a date
      // (DDMON), but TKTL accepts a `/<time>/<office>` non-Amadeus-
      // office variant with no date per QRG p.153 line "Ticketing
      // time limit, non-Amadeus office  TKTL/1800/ROMAZ".
      if (action !== 'OK' && action !== 'SS') {
        const isDateForm = /^\d{1,2}[A-Z]{3}/.test(tail);
        const isNonAmadeusOfficeForm = action === 'TL' && /^\/\d{3,4}\//.test(tail);
        if (!isDateForm && !isNonAmadeusOfficeForm) return FORMAT_ERROR;
      }
      // Optional /P /S /C qualifier validation. Reject if /P or /S
      // refers to a non-existent passenger / segment.
      const pMatch = /\/P(\d+)/.exec(tail);
      if (pMatch && parseInt(pMatch[1], 10) > wa.pnr.names.length) {
        return 'INVALID PASSENGER';
      }
      const sMatch = /\/S(\d+)(?:-(\d+))?/.exec(tail);
      if (sMatch) {
        const lo = parseInt(sMatch[1], 10);
        const hi = sMatch[2] ? parseInt(sMatch[2], 10) : lo;
        if (lo < 1 || hi > wa.pnr.segments.length || lo > hi) {
          return 'INVALID SEGMENT';
        }
      }
      const oldTk = wa.pnr.ticketing;
      wa.pnr.ticketing = entry;
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      if (oldTk) recordHistory(wa.pnr, `TK ${oldTk} → ${entry}`);
      else recordHistory(wa.pnr, `TK ${entry}`);
      return 'OK';
    }

    if (entry === 'ET' || entry === 'ER') {
      // End-transaction. Requires names + segments + ticketing + phone +
      // received-from per the canonical mandatory-field set. ET = end
      // with redisplay; ER = end and retrieve (same effect for v2).
      const pnr = wa.pnr;
      if (pnr.segments.length === 0) return NO_ITINERARY;
      if (pnr.names.length === 0 || pnr.phones.length === 0 || !pnr.ticketing || !pnr.receivedFrom) {
        return NEED_MANDATORY;
      }
      if (!pnr.locator) {
        pnr.locator = generateRecordLocator((loc) => ctx.backend.pnrs.has(loc));
      }
      ctx.backend.pnrs.commit(pnr);
      const locator = pnr.locator!;
      try { wa.machine.transition(SessionEvent.END_TX); } catch { /* */ }
      wa.reset();
      // Reconstructed end-tx echo: locator + RP/<agent> tail (Amadeus QRG
      // shows responses ending with `RP/<office>/<agent>`; we approximate).
      return `END OF TRANSACTION COMPLETE - ${locator}`;
    }

    if (entry === 'IG') {
      // Ignore — discard the work area's PNR build without committing.
      wa.reset();
      try { wa.machine.transition(SessionEvent.IGNORE); } catch { /* */ }
      return 'IGNORED';
    }

    if (entry === 'IR') {
      // Ignore and redisplay (QRG p.42). When a retrieve precedes the
      // build (RT<locator> → modify), IR rolls work-area state back
      // and re-renders the BF as fetched from the store. With a pure
      // build (no committed locator), IR is functionally IG plus an
      // empty "redisplay" — there's nothing to re-render.
      const priorLocator = wa.pnr.locator;
      wa.reset();
      try { wa.machine.transition(SessionEvent.IGNORE); } catch { /* */ }
      if (priorLocator) {
        const pnr = ctx.backend.pnrs.get(priorLocator);
        if (pnr) {
          wa.pnr = pnr;
          try { wa.machine.transition(SessionEvent.RETRIEVE); } catch { /* */ }
          return renderAmadeusPnr(pnr, ctx.pcc, wa.agent);
        }
      }
      return 'IGNORED';
    }

    // DM<airport>[-<airport2>][/<date>] — Minimum Connect Time lookup.
    // QRG p.25 examples: `DMFRA` (basic), `DMFRA/15DEC` (date-specific),
    // `DMLGW-LHR` (inter-airport pair). Returns the emulated inventory's
    // MIN_CONNECT_MINUTES constant — same value the auto-connect builder
    // uses for emulated availability, so MCT lookups are consistent
    // with what `AN<route>` would actually surface in connection lines.
    //
    // DMI — Check MCT and segment continuity in the current PNR.
    if (entry === 'DMI') {
      if (wa.pnr.segments.length < 2) return 'NO CONNECTIONS TO CHECK';
      const checks: string[] = [];
      for (let i = 0; i < wa.pnr.segments.length - 1; i++) {
        const a = wa.pnr.segments[i];
        const b = wa.pnr.segments[i + 1];
        if (a.destination === b.origin) {
          checks.push(`  ${i + 1}-${i + 2}: ${a.destination} OK / MCT ${MIN_CONNECT_MINUTES}M`);
        } else {
          checks.push(`  ${i + 1}-${i + 2}: ${a.destination}->${b.origin} GAP`);
        }
      }
      return ['DMI', ...checks].join('\n');
    }
    const dmMatch = /^DM([A-Z]{3})(?:-([A-Z]{3}))?(?:\/(\d{1,2}[A-Z]{3}))?$/.exec(entry);
    if (dmMatch) {
      const airport = dmMatch[1];
      const second = dmMatch[2];
      const date = dmMatch[3];
      const route = second ? `${airport}-${second}` : airport;
      const dateTail = date ? ` ${date}` : '';
      return `DM ${route}${dateTail}\n  MCT ${MIN_CONNECT_MINUTES} MIN`;
    }

    // FQD<orig><dest>[/<date>][/A<carrier>] — Fare Display for a market.
    // QRG p.23 example: `FQDLAXNYC` (basic, all fares), with optional
    // date and carrier qualifiers (`/15JUL`, `/AAA`). Renders one row
    // per booking class using the emulated tariff's market+class fare.
    if (entry.startsWith('FQD')) {
      const fqd = parseFqd(entry.slice(3));
      if (!fqd) return FORMAT_ERROR;
      const lines: string[] = [`FQD ${fqd.origin}${fqd.destination}${fqd.date ? ' ' + fqd.date : ''}${fqd.carrier ? ' /A' + fqd.carrier : ''}`];
      for (const cls of BOOKING_CLASSES) {
        const fare = fareFor(fqd.origin, fqd.destination, cls);
        lines.push(`  ${cls}  ${fare.base.toFixed(2)} USD  ${fare.fareBasis}`);
      }
      return lines.join('\n');
    }

    // RH — display PNR change history. QRG p.49 references `WRA/RH`
    // for "Print the entire PNR history"; the display form `RH` is
    // reconstructed from mainframe-Amadeus convention. Source is
    // `pnr.history[]` which we populate at sell / cancel / status-
    // change / name-add time.
    if (entry === 'RH') {
      return renderAmadeusHistory(wa.pnr);
    }

    // Partial PNR display family (QRG pp.43-45 "Displaying a Partial
    // PNR"). All these are subsets of the current PNR rendered through
    // a focused lens. Must check BEFORE the generic `RT<locator>`
    // retrieve below (else `entry.startsWith('RT')` would swallow them
    // as "retrieve PNR with locator A/I/N/etc.").
    //
    // Implemented:
    //   RTA   air segments only
    //   RTI   itinerary only (currently == RTA; QRG distinguishes them
    //         by including hotel/car segments in RTI, which we don't
    //         model emulated)
    //   RTN   names only
    //   RTJ   phone, address, credit card check elements only (we
    //         render phones; address/CC deferred)
    //   RTK   ticketing element only
    //   RTF   fare elements only (priceQuotes)
    //   RTG   general facts only (SSR + OSI)
    //   RTR   remarks only
    if (entry === 'RTA' || entry === 'RTI') {
      if (wa.pnr.segments.length === 0) return NO_ITINERARY;
      return renderAmadeusItinerary(wa.pnr);
    }
    if (entry === 'RTN') {
      if (wa.pnr.names.length === 0) return 'NO NAMES';
      return wa.pnr.names
        .map((n, i) => {
          return n.passengers
            .map((pax, j) => {
              const title = pax.title ? ` ${pax.title}` : '';
              const seq = n.passengers.length > 1 ? `${i + 1}.${j + 1}` : `${i + 1}`;
              return `  ${seq}. ${n.surname}/${pax.firstName}${title}`;
            })
            .join('\n');
        })
        .join('\n');
    }
    if (entry === 'RTJ') {
      // RTJ covers phone + address + credit card check elements per QRG
      // p.44. We render phones (existing) and addresses (chunk 9). CC
      // checks aren't modelled.
      const phoneLines = wa.pnr.phones.map((p, i) => `  AP-${i + 1} ${p.number}`);
      let mailingNum = 0;
      let billingNum = 0;
      const addressLines = wa.pnr.addresses.map((a) => {
        const sub = a.subtype !== 'standard'
          ? `/${a.subtype === 'home' ? 'H' : a.subtype === 'delivery' ? 'D' : 'M'}`
          : '';
        if (a.kind === 'mailing') {
          mailingNum++;
          return `  AM${sub}-${mailingNum} ${a.text}`;
        }
        billingNum++;
        return `  AB${sub}-${billingNum} ${a.text}`;
      });
      const all = [...phoneLines, ...addressLines];
      if (all.length === 0) return 'NO PHONE';
      return all.join('\n');
    }
    if (entry === 'RTK') {
      if (!wa.pnr.ticketing) return 'NO TICKETING';
      return `  TK ${wa.pnr.ticketing}`;
    }
    if (entry === 'RTF') {
      if (wa.pnr.priceQuotes.length === 0) return 'NO FARE QUOTES';
      return wa.pnr.priceQuotes
        .map((fq, i) => renderAmadeusFareQuote(fq, i + 1))
        .join('\n\n');
    }
    if (entry === 'RTG') {
      const ssrs = wa.pnr.ssrs.map((s) => `  SR ${s.code} ${s.carrier}${s.text ? ' ' + s.text : ''}`);
      const osis = wa.pnr.osis.map((o) => `  OS ${o.carrier} ${o.text}`);
      const lines = [...ssrs, ...osis];
      if (lines.length === 0) return 'NO GENERAL FACTS';
      return lines.join('\n');
    }
    if (entry === 'RTR') {
      if (wa.pnr.remarks.length === 0) return 'NO REMARKS';
      return wa.pnr.remarks.map((r, i) => `  RM-${i + 1} ${r.text}`).join('\n');
    }

    // RTQ — display queues for current PNR. Must check BEFORE the
    // generic `RT<locator>` retrieve below (else `entry.startsWith('RT')`
    // would match RTQ first and try to retrieve a PNR with locator 'Q').
    if (entry === 'RTQ') {
      const locator = wa.pnr.locator;
      if (!locator) return 'NO PNR ON SCREEN';
      const onQueues: string[] = [];
      for (const [queueKey, locators] of ctx.backend.queues) {
        if (locators.includes(locator)) onQueues.push(queueKey);
      }
      if (onQueues.length === 0) return `${locator} NOT ON QUEUE`;
      return `${locator} ON QUEUE(S): ${onQueues.join(', ')}`;
    }

    if (entry.startsWith('RT')) {
      const arg = entry.slice(2).trim();
      if (!arg) return FORMAT_ERROR;
      // RT/<surname>[/<given-initial>] — retrieve by name. QRG p.43:
      //   RT/HANUSSEN          retrieve by surname
      //   RT/HANUSSEN/J        surname + given initial (single match)
      // The given-initial qualifier disambiguates multi-match returns
      // when several PNRs share a surname.
      if (arg.startsWith('/')) {
        const parts = arg.slice(1).split('/');
        const surname = parts[0];
        const givenInitial = parts[1];
        if (!surname) return FORMAT_ERROR;
        const matches = ctx.backend.pnrs.findBySurname(surname);
        if (matches.length === 0) return PNR_NOT_FOUND;
        const filtered = givenInitial
          ? matches.filter((p) =>
              p.names.some((n) =>
                n.passengers.some((pax) => pax.firstName.startsWith(givenInitial.toUpperCase()))
              )
            )
          : matches;
        if (filtered.length === 0) return PNR_NOT_FOUND;
        if (filtered.length > 1) {
          // QRG p.50 doesn't show the exact multi-match wording for
          // RT/<name>; reconstructed as a numbered locator list.
          const header = `${filtered.length} PNRS FOUND`;
          const rows = filtered.map((p, i) => {
            const first = p.names[0]?.passengers[0];
            const name = first ? `${p.names[0].surname}/${first.firstName}` : '(no name)';
            return `  ${String(i + 1).padStart(2)}. ${p.locator} ${name}`;
          });
          return [header, ...rows].join('\n');
        }
        wa.pnr = filtered[0];
        try { wa.machine.transition(SessionEvent.RETRIEVE); } catch { /* */ }
        return renderAmadeusPnr(filtered[0], ctx.pcc, wa.agent);
      }
      // Plain `RT<locator>` retrieve.
      const found = ctx.backend.pnrs.get(arg);
      if (!found) return PNR_NOT_FOUND;
      wa.pnr = found;
      try { wa.machine.transition(SessionEvent.RETRIEVE); } catch { /* */ }
      return renderAmadeusPnr(found, ctx.pcc, wa.agent);
    }

    // --- v3: cancel, segment-status modify, SSR/OSI, remarks, pricing ---

    // Cancel: XI = itinerary, XE<n> = segment n, XE<n>,<m> = multi-segment
    // (range syntax XE2,4-6 expands to {2,4,5,6}).
    if (entry === 'XI') {
      if (wa.pnr.segments.length === 0) return NO_ITINERARY;
      // Return seats to inventory before clearing the segments.
      for (const seg of wa.pnr.segments) {
        ctx.backend.inventory.release(seg.date, seg.carrier, seg.flightNumber, seg.bookingClass, seg.seats);
      }
      wa.pnr.segments = [];
      recordHistory(wa.pnr, 'XI CANCEL ITINERARY');
      try { wa.machine.transition(SessionEvent.MODIFY); } catch { /* */ }
      return 'CNL';
    }
    if (entry.startsWith('XE')) {
      const segs = parseSegmentList(entry.slice(2));
      if (!segs || segs.length === 0) return FORMAT_ERROR;
      if (wa.pnr.segments.length === 0) return NO_ITINERARY;
      const toCancel = new Set(segs);
      const kept: AirSegment[] = [];
      for (const seg of wa.pnr.segments) {
        if (toCancel.has(seg.segmentNumber)) {
          ctx.backend.inventory.release(seg.date, seg.carrier, seg.flightNumber, seg.bookingClass, seg.seats);
        } else {
          kept.push(seg);
        }
      }
      wa.pnr.segments = kept;
      wa.pnr.renumberSegments();
      recordHistory(wa.pnr, `XE ${segs.join(',')}`);
      try { wa.machine.transition(SessionEvent.MODIFY); } catch { /* */ }
      return wa.pnr.segments.length === 0 ? 'CNL' : renderAmadeusItinerary(wa.pnr);
    }

    // Time-limit modify: 8/<date> (QRG p.45 "Change the time limit in
    // the TK element"). Element 8 is the conventional Amadeus element
    // number for the ticketing/time-limit field. The new value is a
    // DDMON date which gets wrapped as TKTL<date> in our stored
    // ticketing string.
    //
    // Disambiguation from segment-status `<n>/<status>` below: the
    // status form requires exactly 2 uppercase letters; the time-limit
    // form is a `\d{1,2}[A-Z]{3}` date. They don't overlap.
    const tlMatch = /^8\/(\d{1,2}[A-Z]{3})$/.exec(entry);
    if (tlMatch) {
      const oldTk = wa.pnr.ticketing;
      wa.pnr.ticketing = `TKTL${tlMatch[1]}`;
      recordHistory(wa.pnr, oldTk ? `TK ${oldTk}→TKTL${tlMatch[1]}` : `TK TKTL${tlMatch[1]}`);
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }

    // Segment status modify: <n>/<status> (QRG p.31 "Change segment status").
    // E.g. `2/HK` sets segment 2 to HK. Valid status codes per the
    // Amadeus QRG status set (shared with the Sabre manual-entry set).
    const statusModify = /^([1-9]\d?)\/([A-Z]{2})$/.exec(entry);
    if (statusModify) {
      const segNum = parseInt(statusModify[1], 10);
      const status = statusModify[2];
      if (!MANUAL_STATUS_CODES.has(status)) return 'INVALID STATUS CODE';
      const seg = wa.pnr.segments.find((s) => s.segmentNumber === segNum);
      if (!seg) return 'SEGMENT NOT IN ITINERARY';
      const prev = seg.status;
      seg.status = status;
      recordHistory(wa.pnr, `STAT ${segNum}/${prev}→${status}`);
      try { wa.machine.transition(SessionEvent.MODIFY); } catch { /* */ }
      return renderAmadeusItinerary(wa.pnr);
    }

    // Remarks: RM <text> general remark, RC <text> confidential.
    if (entry.startsWith('RM ') || entry === 'RM') {
      const text = entry.slice(2).trim();
      if (!text) return FORMAT_ERROR;
      wa.pnr.remarks.push({ type: 'general', text });
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }
    if (entry.startsWith('RC ') || entry === 'RC') {
      const text = entry.slice(2).trim();
      if (!text) return FORMAT_ERROR;
      // Confidential remarks share the 'historical' bucket in our model —
      // closest equivalent to "not displayed in regular *R" semantics.
      wa.pnr.remarks.push({ type: 'historical', text });
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }

    // SSR — SR <code>[/P<n>] [text]. QRG p.34: e.g. `SR LSML` (low-salt
    // meal, all pax) or `SR VGML/P1-3` (vegetarian, pax 1-3) or
    // `SR INFT-JONES/TOM 02FEB06/P2` (infant data on pax 2).
    if (entry.startsWith('SR ')) {
      const ssr = parseSsr(entry.slice(3));
      if (!ssr) return FORMAT_ERROR;
      wa.pnr.ssrs.push({
        code: ssr.code,
        carrier: ssr.carrier ?? 'YY',
        text: ssr.text,
        nameRef: ssr.nameRef,
        status: 'NN',
      });
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }

    // OSI — OS <carrier> <text>[/P<n>]. QRG p.34: `OS QF VIP COMPANY CEO/P2`.
    if (entry.startsWith('OS ')) {
      const osi = parseOsi(entry.slice(3));
      if (!osi) return FORMAT_ERROR;
      wa.pnr.osis.push({ carrier: osi.carrier, text: osi.text });
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }

    // NU<n>/<body> — Modify Name Element n. QRG p.45.
    //   NU1/1SMITH/JOHN MR    replace name 1 with the full NM body
    //                         (`1` is the new count, `SMITH/JOHN MR` is
    //                         the new surname / given / title)
    //   NU1/JAMES             replace given-name only on name 1's
    //                         first passenger (surname + title unchanged)
    //
    // Element-number addressing: n indexes into pnr.names[] (1-based).
    // Body parsing falls back through two patterns: full-NM (parseName)
    // first, then bare-given-name-only.
    const nuMatch = /^NU([1-9]\d?)\/(.+)$/.exec(entry);
    if (nuMatch) {
      const idx = parseInt(nuMatch[1], 10) - 1;
      if (idx < 0 || idx >= wa.pnr.names.length) return 'NAME NOT IN PNR';
      const body = nuMatch[2];
      // Try the full NM body shape first.
      const parsed = parseName(body);
      if (parsed) {
        const prev = wa.pnr.names[idx];
        wa.pnr.names[idx] = {
          surname: parsed.surname,
          passengers: parsed.passengers.map((p) => ({ firstName: p.given, title: p.title })),
          count: parsed.passengers.length,
          infant: prev.infant,
        };
        recordHistory(wa.pnr, `NU${idx + 1} ${parsed.surname}/${parsed.passengers.map((p) => p.given).join('/')}`);
        try { wa.machine.transition(SessionEvent.MODIFY); } catch { /* */ }
        return 'OK';
      }
      // Bare given-name (no surname, no count prefix) — replace just
      // the first passenger's given name on that name item.
      const bareGiven = /^([A-Z]+(?:\s+[A-Z]+)*)$/.exec(body);
      if (bareGiven) {
        const { given, title } = splitTitle(bareGiven[1]);
        const target = wa.pnr.names[idx];
        if (target.passengers.length === 0) return 'NAME NOT IN PNR';
        const oldGiven = target.passengers[0].firstName;
        target.passengers[0] = { firstName: given, title: title ?? target.passengers[0].title };
        recordHistory(wa.pnr, `NU${idx + 1} ${oldGiven}→${given}`);
        try { wa.machine.transition(SessionEvent.MODIFY); } catch { /* */ }
        return 'OK';
      }
      return FORMAT_ERROR;
    }

    // SP <n>[,<m>[,<a>-<b>]...] — Split a PNR. QRG p.48 "Splitting a PNR":
    //   SP 7           Split name 7 off into an "associate" PNR
    //   SP 3,4,5-7     Split names 3, 4, 5, 6, 7 off
    // The parent PNR (current minus the split names) is stashed on
    // wa.dividedOriginal; wa.pnr swaps to the new associate. `EF` then
    // commits the associate + restores + re-commits the parent.
    //
    // v1 limitation: only the bare element-number form. Sub-passenger
    // notation (`SP 0.15`, `SP 3.2`) and group-PNR auxiliary handling
    // (QRG p.48 advanced forms) deferred.
    const spMatch = /^SP\s+([0-9,\-]+)$/.exec(entry);
    if (spMatch) {
      if (!wa.pnr.locator) return 'NO PNR ON SCREEN';
      const indices = parseSegmentList(spMatch[1]);
      if (!indices || indices.length === 0) return FORMAT_ERROR;
      const splitSet = new Set(indices);
      for (const i of indices) {
        if (i < 1 || i > wa.pnr.names.length) return 'NAME NOT IN PNR';
      }
      // Stash the parent: clone the current PNR, then drop the split
      // names. The parent retains the original locator + everything else.
      const parent = wa.pnr.clone();
      parent.names = parent.names.filter((_, idx) => !splitSet.has(idx + 1));
      wa.dividedOriginal = parent;
      // Build the associate: clone, keep only the split names, clear
      // commit-tied fields so EF assigns a fresh locator.
      const associate = wa.pnr.clone();
      associate.names = associate.names.filter((_, idx) => splitSet.has(idx + 1));
      associate.locator = undefined;
      associate.priceQuotes = [];
      associate.tickets = [];
      associate.history = [];
      associate.createdAt = undefined;
      recordHistory(associate, `SP FROM ${wa.pnr.locator}`);
      wa.pnr = associate;
      try { wa.machine.transition(SessionEvent.MODIFY); } catch { /* */ }
      return `SPLIT - ASSOCIATE PNR READY`;
    }

    // EF — End the transaction and file the associate PNR. QRG p.48.
    // Commits the in-progress associate, then restores + re-commits
    // the parent (whose names were trimmed by the prior SP). Both
    // PNRs persist with distinct locators after EF.
    if (entry === 'EF') {
      if (!wa.dividedOriginal) return 'NOTHING TO FILE';
      const associate = wa.pnr;
      if (associate.segments.length === 0) return NO_ITINERARY;
      if (associate.names.length === 0 || associate.phones.length === 0 ||
          !associate.ticketing || !associate.receivedFrom) {
        return NEED_MANDATORY;
      }
      associate.locator = generateRecordLocator((loc) => ctx.backend.pnrs.has(loc));
      ctx.backend.pnrs.commit(associate);
      const associateLocator = associate.locator!;
      // Restore parent + re-commit (names were trimmed by SP).
      const parent = wa.dividedOriginal;
      ctx.backend.pnrs.commit(parent);
      wa.pnr = parent;
      wa.dividedOriginal = undefined;
      return `ASSOCIATE ${associateLocator} FILED - PARENT ${parent.locator}`;
    }

    // RRN — Copy the current PNR (must be retrieved/displayed). QRG p.47.
    // The clone retains names + segments + phones + addresses + remarks
    // + SSRs + OSIs + FF elements + seat requests; drops locator,
    // priceQuotes, tickets, history, createdAt — those belong to the
    // original commit and a fresh ET will create new ones.
    //
    // All variants currently supported:
    //   RRN              full copy
    //   RRN/<n>          change number of passengers to <n> (chunk 24)
    //   RRN/DP<n>        push all dates forward n days (chunk 18)
    //   RRN/DM<n>        push all dates back n days (chunk 18)
    //   RRN/C<class>     change all booking classes (chunk 18)
    //   RRN/S<list>      keep only listed segments (chunk 18)
    //   RRN/SX<list>     exclude listed segments (chunk 24)
    //   RRN/P<list>      keep only listed passengers (chunk 24)
    //   RRN/PX<list>     exclude listed passengers (chunk 24)
    //
    // Lists support comma + range: `1,3-5`. RRI mirrors RRN but drops
    // names + service elements (itinerary-only copy).
    if (entry === 'RRN' || entry.startsWith('RRN/') || entry === 'RRI' || entry.startsWith('RRI/')) {
      if (!wa.pnr.locator) return 'NO PNR ON SCREEN';
      const isItineraryOnly = entry === 'RRI' || entry.startsWith('RRI/');
      const cloned = wa.pnr.clone();
      cloned.locator = undefined;
      cloned.priceQuotes = [];
      cloned.tickets = [];
      cloned.history = [];
      cloned.createdAt = undefined;
      if (isItineraryOnly) {
        // RRI drops names + service elements; keeps only itinerary
        // (segments + hotel + car) + the ticketing arrangement skeleton.
        cloned.names = [];
        cloned.phones = [];
        cloned.ssrs = [];
        cloned.osis = [];
        cloned.frequentFlyers = [];
        cloned.seatRequests = [];
        cloned.addresses = [];
        cloned.remarks = [];
      }
      const originalLocator = wa.pnr.locator;
      let modifierTag = '';
      const prefixLen = isItineraryOnly ? 3 : 3; // both 3 chars
      const hasOpt = entry.length > prefixLen;
      if (hasOpt) {
        const opt = entry.slice(prefixLen + 1); // skip the `/`
        // RRN/<n> — change number of passengers
        const nMatch = /^(\d+)$/.exec(opt);
        // RRN/DP<n>, RRN/DM<n>, RRN/C<class>, RRN/S<list>
        const dpMatch = /^DP(\d+)$/.exec(opt);
        const dmMatch = /^DM(\d+)$/.exec(opt);
        const cMatch = /^C([A-Z])$/.exec(opt);
        const sMatch = /^S([0-9,\-]+)$/.exec(opt);
        const sxMatch = /^SX([0-9,\-]+)$/.exec(opt);
        const pMatch = /^P([0-9,\-]+)$/.exec(opt);
        const pxMatch = /^PX([0-9,\-]+)$/.exec(opt);
        if (nMatch) {
          // Numeric-only — change the pax count. If the new count
          // exceeds existing names, we keep the names as-is and let
          // the operator NM the extras. If it's lower, we trim from
          // the end (most-recently-added first).
          if (isItineraryOnly) return FORMAT_ERROR; // RRI/<n> not allowed
          const newCount = parseInt(nMatch[1], 10);
          if (newCount < 1) return FORMAT_ERROR;
          const currentTotal = cloned.names.reduce((sum, n) => sum + n.count, 0);
          if (newCount < currentTotal) {
            // Trim from the end of the names list.
            let remaining = newCount;
            const keptNames: typeof cloned.names = [];
            for (const n of cloned.names) {
              if (remaining <= 0) break;
              if (n.count <= remaining) {
                keptNames.push(n);
                remaining -= n.count;
              } else {
                keptNames.push({
                  ...n,
                  count: remaining,
                  passengers: n.passengers.slice(0, remaining),
                });
                remaining = 0;
              }
            }
            cloned.names = keptNames;
          }
          // For pax-count > current total we don't auto-add stubs;
          // the operator follows up with NM<n><surname>/<given>.
          modifierTag = ` ${newCount}`;
        } else if (dpMatch) {
          const days = parseInt(dpMatch[1], 10);
          cloned.segments.forEach((s) => { s.date = pushDdmonByDays(s.date, days); });
          modifierTag = ` DP${days}`;
        } else if (dmMatch) {
          const days = parseInt(dmMatch[1], 10);
          cloned.segments.forEach((s) => { s.date = pushDdmonByDays(s.date, -days); });
          modifierTag = ` DM${days}`;
        } else if (cMatch) {
          cloned.segments.forEach((s) => { s.bookingClass = cMatch[1]; });
          modifierTag = ` C${cMatch[1]}`;
        } else if (sMatch) {
          const segs = parseSegmentList(sMatch[1]);
          if (!segs) return FORMAT_ERROR;
          const keep = new Set(segs);
          cloned.segments = cloned.segments.filter((_, idx) => keep.has(idx + 1));
          cloned.renumberSegments();
          modifierTag = ` S${sMatch[1]}`;
        } else if (sxMatch) {
          const segs = parseSegmentList(sxMatch[1]);
          if (!segs) return FORMAT_ERROR;
          const drop = new Set(segs);
          cloned.segments = cloned.segments.filter((_, idx) => !drop.has(idx + 1));
          cloned.renumberSegments();
          modifierTag = ` SX${sxMatch[1]}`;
        } else if (pMatch) {
          if (isItineraryOnly) return FORMAT_ERROR; // RRI dropped names
          const pax = parseSegmentList(pMatch[1]);
          if (!pax) return FORMAT_ERROR;
          if (pax.some((n) => n > cloned.names.length)) return 'INVALID PASSENGER';
          const keep = new Set(pax);
          cloned.names = cloned.names.filter((_, idx) => keep.has(idx + 1));
          modifierTag = ` P${pMatch[1]}`;
        } else if (pxMatch) {
          if (isItineraryOnly) return FORMAT_ERROR;
          const pax = parseSegmentList(pxMatch[1]);
          if (!pax) return FORMAT_ERROR;
          if (pax.some((n) => n > cloned.names.length)) return 'INVALID PASSENGER';
          const drop = new Set(pax);
          cloned.names = cloned.names.filter((_, idx) => !drop.has(idx + 1));
          modifierTag = ` PX${pxMatch[1]}`;
        } else {
          return FORMAT_ERROR;
        }
      }
      wa.pnr = cloned;
      const verb = isItineraryOnly ? 'RRI' : 'RRN';
      recordHistory(cloned, `${verb} COPY FROM ${originalLocator}${modifierTag}`);
      try { wa.machine.transition(SessionEvent.RETRIEVE); } catch { /* */ }
      return `COPIED FROM ${originalLocator}${modifierTag}`;
    }

    // LP/<carrier><flight>/<date> — List PNRs by flight. QRG p.50:
    //   LP/2X933/18AUG    List PNRs for flight 2X933 on 18AUG
    // The flight argument is parsed as `<2-char-carrier><digits>`.
    // Output is a numbered list of locator + first-name pairs; an
    // empty match returns "NO PNRS FOUND".
    const lpMatch = /^LP\/([A-Z0-9]{2})(\d{1,4})\/(\d{1,2}[A-Z]{3})$/.exec(entry);
    if (lpMatch) {
      const matches = ctx.backend.pnrs.findByFlight(lpMatch[1], lpMatch[2], lpMatch[3]);
      if (matches.length === 0) return 'NO PNRS FOUND';
      const header = `LP ${lpMatch[1]}${lpMatch[2]} ${lpMatch[3]} - ${matches.length} PNR(S)`;
      const rows = matches.map((p, i) => {
        const first = p.names[0];
        const passenger = first
          ? `${first.surname}/${first.passengers[0].firstName}${first.passengers[0].title ? ' ' + first.passengers[0].title : ''}`
          : '(no name)';
        return `  ${String(i + 1).padStart(2)}. ${p.locator} ${passenger}`;
      });
      return [header, ...rows].join('\n');
    }

    // SM family — Display seat map. QRG p.39-40. See
    // docs/seatmap-design.md for the design. Three forms:
    //   SM <n>[/V|/H]                                  segment in current PNR (chunk 2)
    //   SM <carrier><flight>/<class>/[<date>]<route>[/V|/H]  direct query (chunk 3)
    //   SM/<line>[/<class>][/V|/H]                     from cached availability (chunk 3)
    //
    // The dispatch path: leading slash → avail-line form; first token
    // all-digits → segment form; else direct form.
    //
    // Result of any form is rendered via the shared renderer and cached
    // on wa.lastSeatMap (chunk 7 scrolling reuses it).
    const smReq = parseSmRequest(entry);
    if (smReq) {
      const resolved = resolveSm(smReq, wa, ctx);
      if (typeof resolved === 'string') return resolved; // error path
      const { map, segment, segmentNumber } = resolved;
      const locatorKey = wa.pnr.locator ?? 'PENDING';
      const availability = synthesizeAvailability(map, locatorKey, segment.date);
      const decorations = synthesizeDecorations(map, locatorKey, segment.date);
      // Reset scroll position on a fresh SM query; cache the segment
      // so chunk 7's MD/MU/MB/MT can re-render without re-resolving.
      wa.lastSeatMap = { segment: segmentNumber, map, cachedSegment: segment, scrollRow: 0 };
      const header = amadeusSeatMapHeader(map, segment, segmentNumber);
      return renderSeatMap(map, availability, header, smReq.orientation, {
        rowsPerPage: SM_PAGE_SIZE,
        showLegend: smReq.showLegend,
        glyphs: AMADEUS_GLYPHS,
        decorations,
      });
    }

    // MD / MU / MB / MT — scroll the cached seat map (chunk 7).
    // QRG p.39: "Use ¤MD or ¤MU to change screens for Direct Access
    // seat maps." Amadeus uses the bare verbs without the ¤ prefix;
    // Sabre uses ¤MD/¤MU (deferred — conflicts with modify parser).
    if (entry === 'MD' || entry === 'MU' || entry === 'MB' || entry === 'MT') {
      if (!wa.lastSeatMap) return 'NO SEAT MAP DISPLAYED';
      const cached = wa.lastSeatMap;
      if (!cached.cachedSegment) return 'NO SEAT MAP DISPLAYED';
      const totalRows = cached.map.Cabin.reduce((sum, c) => sum + c.Row.length, 0);
      const maxOffset = Math.max(0, totalRows - SM_PAGE_SIZE);
      let newOffset = cached.scrollRow ?? 0;
      if (entry === 'MD') newOffset = Math.min(newOffset + SM_PAGE_SIZE, maxOffset);
      else if (entry === 'MU') newOffset = Math.max(newOffset - SM_PAGE_SIZE, 0);
      else if (entry === 'MB') newOffset = maxOffset;
      else newOffset = 0; // MT
      cached.scrollRow = newOffset;
      const locatorKey = wa.pnr.locator ?? 'PENDING';
      const availability = synthesizeAvailability(cached.map, locatorKey, cached.cachedSegment.date);
      const decorations = synthesizeDecorations(cached.map, locatorKey, cached.cachedSegment.date);
      const header = amadeusSeatMapHeader(cached.map, cached.cachedSegment, cached.segment);
      return renderSeatMap(cached.map, availability, header, 'V', {
        rowOffset: newOffset,
        rowsPerPage: SM_PAGE_SIZE,
        glyphs: AMADEUS_GLYPHS,
        decorations,
      });
    }

    // ST/<seat-or-pref>[/P<n>][/S<n>] — seat request. QRG p.40.
    //   ST/12C/P2/S5    specific seat 12C, pax 2, segment 5
    //   ST/WB/P3        preference (window/bulkhead), pax 3
    //   ST/NSSA         preference (non-smoking aisle), all pax
    // The dispatcher splits on `/`, takes the first chunk as the seat
    // code/preference, then peels passenger/segment refs from the rest.
    if (entry.startsWith('ST/')) {
      const parts = entry.slice(3).split('/');
      if (parts.length === 0 || !parts[0]) return FORMAT_ERROR;
      const code = parts[0];
      let segment: number | undefined;
      let nameRef: { item: number; passenger?: number } | undefined;
      for (const tok of parts.slice(1)) {
        const pMatch = /^P(\d+)(?:\.(\d+))?$/.exec(tok);
        const sMatch = /^S(\d+)$/.exec(tok);
        if (pMatch) {
          nameRef = {
            item: parseInt(pMatch[1], 10),
            passenger: pMatch[2] ? parseInt(pMatch[2], 10) : undefined,
          };
        } else if (sMatch) {
          segment = parseInt(sMatch[1], 10);
        } else {
          return FORMAT_ERROR;
        }
      }
      // Seat-existence validation (chunk 2) + availability validation
      // (chunk 8): when the code is a specific seat label (row +
      // column letter) AND a segment is specified, validate the seat
      // (a) exists in the segment's seat map, and (b) is currently
      // marked Available by the synthesizer / live response.
      // Preferences (NSSA / WB / etc.) skip both checks.
      const seatLabel = /^(\d{1,3})([A-Z])$/.exec(code);
      if (seatLabel && segment !== undefined) {
        const seg = wa.pnr.segments.find((s) => s.segmentNumber === segment);
        if (seg) {
          const map = ctx.backend.inventory.seatMapFor(seg.carrier, seg.flightNumber);
          if (map) {
            const rowLabel = seatLabel[1];
            const col = seatLabel[2];
            const seatLabelFull = `${rowLabel}${col}`;
            const exists = map.Cabin.some((c) =>
              c.Row.some((r) => r.label === rowLabel && r.Space.some((s) => s.location === col)),
            );
            if (!exists) return 'INVALID SEAT';
            // Chunk 8: availability check via the synthesizer.
            // SeatAvailabilityStatus enum: Available / Reserved /
            // Blocked / NoSeat / Unavailable. Only `Available` accepts;
            // any other status → SEAT NOT AVAILABLE.
            const locatorKey = wa.pnr.locator ?? 'PENDING';
            const availability = synthesizeAvailability(map, locatorKey, seg.date);
            for (const bucket of availability) {
              if (bucket.value.includes(seatLabelFull)) {
                if (bucket.seatAvailabilityStatus !== 'Available') {
                  return 'SEAT NOT AVAILABLE';
                }
                break;
              }
            }
            // Chunk 7 deferred #5: exit-row passenger-profile check.
            // Per IATA / FAA emergency-exit-row eligibility rules, the
            // following passengers MUST NOT be seated in exit rows:
            //   - Infants (NameItem.infant = true / SSR INFT / BSCT)
            //   - Unaccompanied minors (SSR UMNR)
            //   - Passengers requiring mobility/medical assistance
            //     (SSR WCHR, WCHS, WCHC, BLND, DEAF, MAAS, DPNA)
            // The check fires only on specific-seat ST/<seat> entries
            // that target an exit row (the seat's Characteristic
            // array contains 'E'). Preference-only ST/<pref> entries
            // are unaffected — the airline allocates a non-exit seat
            // automatically when an ineligible pax holds a preference.
            const isExitSeat = map.Cabin.some((c) =>
              c.Row.some((r) =>
                r.label === rowLabel &&
                r.Space.some((s) => s.location === col && s.Characteristic?.includes('E')),
              ),
            );
            if (isExitSeat) {
              const ineligible = findExitRowIneligible(wa.pnr, nameRef);
              if (ineligible) return `EXIT ROW RESTRICTED - ${ineligible}`;
            }
          }
        }
      }
      wa.pnr.seatRequests.push({ code, segment, nameRef });
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }

    // SX — cancel ALL seat assignments. SX/S<n> cancels seats for a
    // specific segment. QRG p.40.
    if (entry === 'SX') {
      wa.pnr.seatRequests = [];
      try { wa.machine.transition(SessionEvent.MODIFY); } catch { /* */ }
      return 'CNL';
    }
    const sxSegMatch = /^SX\/S([1-9]\d?)$/.exec(entry);
    if (sxSegMatch) {
      const seg = parseInt(sxSegMatch[1], 10);
      wa.pnr.seatRequests = wa.pnr.seatRequests.filter((s) => s.segment !== seg);
      try { wa.machine.transition(SessionEvent.MODIFY); } catch { /* */ }
      return 'CNL';
    }

    // AM / AB — Mailing / billing address elements. QRG p.38.
    //   AM <text>[/P<n>]                 mailing, standard
    //   AM/H <text>[/P<n>]               mailing, home
    //   AM/D <text>[/P<n>]               mailing, delivery
    //   AM/M <text>[/P<n>]               mailing, miscellaneous
    //   AB <text>[/P<n>]                 billing, standard
    // Text body is stored verbatim — Amadeus structured form
    // (`/CY-CO/NA-NAME/A1-LINE...`) parses the same way for v1.
    const addrMatch = /^(AM|AB)(?:\/([HDM]))?\s+(.+)$/.exec(entry);
    if (addrMatch) {
      const kind = addrMatch[1] === 'AM' ? 'mailing' : 'billing';
      const subtype =
        addrMatch[2] === 'H' ? 'home' :
        addrMatch[2] === 'D' ? 'delivery' :
        addrMatch[2] === 'M' ? 'misc' :
        'standard';
      let body = addrMatch[3].trim();
      let nameRef: { item: number; passenger?: number } | undefined;
      const tail = /\/P(\d+)(?:\.(\d+))?$/.exec(body);
      if (tail) {
        nameRef = {
          item: parseInt(tail[1], 10),
          passenger: tail[2] ? parseInt(tail[2], 10) : undefined,
        };
        body = body.slice(0, tail.index).trim();
      }
      if (!body) return FORMAT_ERROR;
      wa.pnr.addresses.push({ kind, subtype, text: body, nameRef });
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }

    // VFFD — Display frequent flyer agreements. QRG p.39:
    //   VFFD            Display all carrier FF agreements
    //   VFFD <carrier>  Display agreements for a specific carrier
    //
    // Static carrier→program map — reconstructed since the QRG only
    // shows the entry forms, not the response wording. Covers the
    // major loyalty programs an operator would actually query.
    if (entry === 'VFFD') {
      const rows = Object.entries(VFFD_PROGRAMS).map(
        ([c, p]) => `  ${c}  ${p}`
      );
      return ['VFFD - AGREEMENTS ACTIVE', ...rows].join('\n');
    }
    const vffdMatch = /^VFFD (.+)$/.exec(entry);
    if (vffdMatch) {
      const carrier = vffdMatch[1].trim().toUpperCase();
      const program = VFFD_PROGRAMS[carrier];
      if (!program) return `${carrier} NO FF AGREEMENT`;
      return `  ${carrier}  ${program}  AGREEMENT ACTIVE`;
    }

    // FFN <carrier>-<number>[/P<n>] — create a frequent-flyer SSR
    // element. QRG p.39 example: `FFN BW-123456789/P1`. Stores on
    // pnr.frequentFlyers (shared model with Sabre's `FF<carrier><num>`).
    // The `/P<n>` tail binds the FF to a specific passenger; without
    // it the FF applies to all pax.
    if (entry.startsWith('FFN ')) {
      const ff = parseFfn(entry.slice(4));
      if (!ff) return FORMAT_ERROR;
      wa.pnr.frequentFlyers.push({
        carrier: ff.carrier,
        number: ff.number,
        nameRef: ff.nameRef,
      });
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }

    // Pricing — FXP (best buy on booked itinerary), FXX (display saved quotes).
    if (entry === 'FXP') {
      if (wa.pnr.segments.length === 0) return NO_ITINERARY;
      if (wa.pnr.names.length === 0) return 'NEEDS NAME';
      const fq = priceItinerary(wa.pnr, {});
      if (!fq) return 'NO FARE FOUND'; // reconstructed
      wa.pnr.priceQuotes.push(fq);
      wa.lastPricing = fq;
      try { wa.machine.transition(SessionEvent.MODIFY); } catch { /* */ }
      return renderAmadeusFareQuote(fq, wa.pnr.priceQuotes.length);
    }
    if (entry === 'FXX' || entry === 'TQT') {
      if (wa.pnr.priceQuotes.length === 0) return 'NO FARE QUOTES';
      return wa.pnr.priceQuotes
        .map((fq, i) => renderAmadeusFareQuote(fq, i + 1))
        .join('\n\n');
    }

    // --- v4 chunk 19: e-ticket issuance (TTP) + display (TWD) ---
    // Per Amadeus QRG p.211 (Amadeus Electronic Ticketing chapter).
    //
    // TTP        issue tickets for displayed PNR (default = electronic)
    // TTP/ET     force electronic
    // TTP/PT     force paper (airline + US market only — same TKT
    //            wording either way in our renderer; the type field
    //            differs (TE vs TK))
    // TTP/S<n>-<m>  issue for specific segment range (validated only)
    //
    // TWD        display ET records on retrieved PNR
    // TWD/L<n>   specific ticket line
    // TWD/<n>    specific line from list (same shape)
    // TWH        display ET record history (uses pnr.history-style)
    if (entry === 'TTP' || entry.startsWith('TTP/')) {
      if (wa.pnr.segments.length === 0) return NO_ITINERARY;
      if (wa.pnr.names.length === 0) return 'NEEDS NAME';
      if (wa.pnr.priceQuotes.length === 0) return 'NO PRICE QUOTE';
      if (wa.pnr.tickets.length > 0) return 'TICKETS ALREADY ISSUED';
      const ticketType: 'TE' | 'TK' = entry.includes('/PT') ? 'TK' : 'TE';
      // Optional /S<n>-<m> segment validation. The selected range is
      // recorded indirectly (we don't track per-segment ticketing yet)
      // but invalid segments reject.
      const segMatch = /\/S(\d+)(?:-(\d+))?/.exec(entry);
      if (segMatch) {
        const lo = parseInt(segMatch[1], 10);
        const hi = segMatch[2] ? parseInt(segMatch[2], 10) : lo;
        if (lo < 1 || hi > wa.pnr.segments.length || lo > hi) return 'INVALID SEGMENT';
      }
      const tickets = issueAmadeusTickets(wa.pnr, ctx, ticketType);
      wa.pnr.tickets.push(...tickets);
      recordHistory(wa.pnr, `TTP ${tickets.length} TKT(S) ISSUED`);
      return renderAmadeusTicketIssuance(tickets);
    }

    if (entry === 'TWD' || entry.startsWith('TWD/') || entry === 'TWDRT' || entry === 'TWDRL' || entry === 'TWH') {
      if (wa.pnr.tickets.length === 0) return 'NO ET RECORD';
      // TWD/L<n> and TWD/<n> both select a specific line.
      const lineMatch = /^TWD\/(?:L)?(\d+)$/.exec(entry);
      if (lineMatch) {
        const n = parseInt(lineMatch[1], 10);
        const ticket = wa.pnr.tickets[n - 1];
        if (!ticket) return 'NO ET RECORD';
        return renderAmadeusTwd([ticket], wa.pnr, n);
      }
      // TWDRL — redisplay the list (compact).
      if (entry === 'TWDRL') {
        return renderAmadeusTwdList(wa.pnr.tickets);
      }
      // TWH — history-style summary (each ticket + status events).
      if (entry === 'TWH') {
        return renderAmadeusTwh(wa.pnr.tickets);
      }
      // TWD / TWDRT — display all from retrieved PNR.
      return renderAmadeusTwd(wa.pnr.tickets, wa.pnr);
    }

    // --- v4 chunk 21: document output (INV / INE / IBP / IEP) ---
    // Per QRG p.221 (Amadeus Invoice) + p.225 (Amadeus Itinerary).
    //
    // Invoice family — billing details + fares + tickets:
    //   INVD            display individual basic invoice
    //   INV             print individual basic invoice
    //   INED            display individual extended invoice
    //   INE             print individual extended invoice
    //   INVDJ / INVJ    joint (one for all passengers) basic
    //   INEDJ / INEJ    joint extended
    //
    // Itinerary family — passenger + segments, no fares:
    //   IBD             display basic itinerary
    //   IBP             print basic itinerary
    //   IED             display extended itinerary
    //   IEP             print extended itinerary
    //   IBPJ / IEPJ     joint
    //
    // Qualifier suffixes (subset implemented):
    //   /P<n>[-<m>]     selected passengers
    //   /S<n>[-<m>]     selected segments
    //
    // For our emulator "display" (D) and "print" (no D) verbs render
    // identical content since we don't model a printer — both return
    // the rendered text body.
    //
    // Out-of-scope qualifiers (accepted but ignored): /LP <lang>,
    // /TO <12|24>, /COPY, /D <printer>, /T<n> (TSTs), /M, /A*, /L*.
    const docMatch = /^(INVD|INVDJ|INVJ|INV|INED|INEDJ|INEJ|INE|IBD|IBPJ|IBP|IED|IEPJ|IEP)(\/.*)?$/.exec(entry);
    if (docMatch) {
      if (wa.pnr.segments.length === 0) return NO_ITINERARY;
      if (wa.pnr.names.length === 0) return 'NEEDS NAME';
      const verb = docMatch[1];
      const qual = docMatch[2] ?? '';
      const isInvoice = verb.startsWith('INV') || verb.startsWith('INE');
      const isExtended = verb.startsWith('INE') || verb.startsWith('IE');
      const isJoint = verb.endsWith('J') || verb.endsWith('DJ');
      // Pax selection (/P<n>[-<m>]).
      let paxFilter: number[] | undefined;
      const pMatch = /\/P(\d+)(?:-(\d+))?/.exec(qual);
      if (pMatch) {
        const lo = parseInt(pMatch[1], 10);
        const hi = pMatch[2] ? parseInt(pMatch[2], 10) : lo;
        if (lo < 1 || hi > wa.pnr.names.length || lo > hi) return 'INVALID PASSENGER';
        paxFilter = [];
        for (let i = lo; i <= hi; i++) paxFilter.push(i);
      }
      // Segment selection (/S<n>[-<m>]).
      let segFilter: number[] | undefined;
      const sMatch = /\/S(\d+)(?:-(\d+))?/.exec(qual);
      if (sMatch) {
        const lo = parseInt(sMatch[1], 10);
        const hi = sMatch[2] ? parseInt(sMatch[2], 10) : lo;
        if (lo < 1 || hi > wa.pnr.segments.length || lo > hi) return 'INVALID SEGMENT';
        segFilter = [];
        for (let i = lo; i <= hi; i++) segFilter.push(i);
      }
      return renderAmadeusDocument(wa.pnr, {
        kind: isInvoice ? 'invoice' : 'itinerary',
        extended: isExtended,
        joint: isJoint,
        paxFilter,
        segFilter,
      });
    }

    // --- v4 chunk 22: hotel availability + sell (HA / HS / HX) ---
    // Per QRG p.101 (HOTEL AVAILABILITY) + p.105 (HOTEL SELL).
    //
    //   HA<city>[<date1>[-<date2>]]      all hotels in city
    //   HA<chain><city>[<date1>[-<date2>]]   chain-filtered
    //   HA<chain><city><property>[<date>]    single property
    //   HS<n>[/<rate-code>]              sell from availability list
    //   HX<n>                            cancel hotel segment
    //
    // Date format: DDMMM (e.g. 12MAR). Default: today + 1 night.
    //
    // wa.lastHotelAvail caches the displayed list so HS can reference
    // by line number, mirroring how wa.lastAvailability works for air.
    const haMatch = /^HA([A-Z]{2,3})([A-Z]{3})?([A-Z]{3})?(\d{1,2}[A-Z]{3})?(?:-(\d{1,2}[A-Z]{3}))?$/.exec(entry);
    if (haMatch) {
      // Disambiguation: HA<city> (3) vs HA<chain><city> (2+3) vs
      // HA<chain><city><prop> (2+3+3). Use length heuristics.
      const tok1 = haMatch[1];
      const tok2 = haMatch[2];
      const tok3 = haMatch[3];
      const date1 = haMatch[4];
      const date2 = haMatch[5];
      let chain: string | undefined;
      let city: string;
      let property: string | undefined;
      if (tok1.length === 3 && !tok2 && !tok3) {
        // HA<city>
        city = tok1;
      } else if (tok1.length === 2 && tok2 && !tok3) {
        // HA<chain><city>
        chain = tok1;
        city = tok2;
      } else if (tok1.length === 2 && tok2 && tok3) {
        // HA<chain><city><prop>
        chain = tok1;
        city = tok2;
        property = tok3;
      } else {
        return FORMAT_ERROR;
      }
      const checkIn = date1 ?? '15JUL';
      const checkOut = date2 ?? checkIn;
      const nights = computeNights(checkIn, checkOut);
      let props = ctx.backend.inventory.hotelsIn(city, chain);
      if (property) props = props.filter((p) => p.property === property);
      if (props.length === 0) return 'NO HOTELS FOUND';
      wa.lastHotelAvail = { city, checkIn, checkOut, nights, properties: props };
      return renderHotelAvailability(city, checkIn, checkOut, nights, props);
    }

    const hsMatch = /^HS(\d+)(?:\/([A-Z]{3,4}))?$/.exec(entry);
    if (hsMatch) {
      if (!wa.lastHotelAvail) return 'NO HOTEL DISPLAY';
      const line = parseInt(hsMatch[1], 10);
      const rateCode = hsMatch[2];
      const prop = wa.lastHotelAvail.properties[line - 1];
      if (!prop) return 'INVALID LINE';
      // Pick the rate: explicit /code, else first available (RAC default).
      const rate = rateCode
        ? prop.rates.find((r) => r.code === rateCode)
        : prop.rates[0];
      if (!rate) return 'INVALID RATE CODE';
      if (rate.available < 1) return 'NO ROOMS AVAILABLE';
      const cached = wa.lastHotelAvail;
      const seg: import('../../models/hotel.js').HotelSegment = {
        segmentNumber: wa.pnr.segments.length + wa.pnr.hotelSegments.length + 1,
        chain: prop.chain,
        property: prop.property,
        name: prop.name,
        city: prop.city,
        checkIn: cached.checkIn,
        checkOut: cached.checkOut,
        nights: cached.nights,
        rateCode: rate.code,
        ratePerNight: rate.amount,
        currency: rate.currency,
        rooms: 1,
        status: 'HK',
        confirmationNumber: `HC${hotelConfirmationFor(prop.chain, prop.property, wa.pnr.hotelSegments.length)}`,
      };
      wa.pnr.hotelSegments.push(seg);
      recordHistory(wa.pnr, `HS ${prop.chain}${prop.property} ${cached.checkIn}-${cached.checkOut}`);
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return renderHotelSegment(seg);
    }

    const hxMatch = /^HX(\d+)$/.exec(entry);
    if (hxMatch) {
      const segNum = parseInt(hxMatch[1], 10);
      const idx = wa.pnr.hotelSegments.findIndex((s) => s.segmentNumber === segNum);
      if (idx < 0) return 'SEGMENT NOT IN ITINERARY';
      const seg = wa.pnr.hotelSegments[idx];
      wa.pnr.hotelSegments.splice(idx, 1);
      recordHistory(wa.pnr, `HX ${seg.chain}${seg.property} CANCELLED`);
      return 'OK CANCELLED';
    }

    // --- v4 chunk 23: car availability + sell (CA / CS / CX) ---
    // Per QRG p.81 (CAR AVAILABILITY) + p.89 (CAR SELL).
    //
    //   CA<city>[<date>[-<date>]]              multi-company
    //   CA<company><city>[<date>[-<date>]]     specific company
    //   CA<city><date>-<N>                     drop-off as N days
    //   CS<n>[/<vehicle-type>]                 sell from cached list
    //   CX<n>                                  cancel car segment
    //
    // Optional /ARR-<time>[-<time>] arrival-window suffix accepted
    // but only the first time is recorded (we don't model the
    // window). /TC option (two-character country) accepted as no-op.
    //
    // 2-letter company codes per QRG: ZE Hertz, ZD Budget, ZA Avis,
    // ET Enterprise, ZI National, ZL Dollar, ZR Thrifty.
    const caMatch = /^CA([A-Z]{2})?([A-Z]{3})(\d{1,2}[A-Z]{3})?(?:-(\d{1,2}[A-Z]{3}|\d{1,2}))?(\/.*)?$/.exec(entry);
    if (caMatch) {
      const company = caMatch[1];
      const city = caMatch[2];
      const date1 = caMatch[3];
      const date2 = caMatch[4];
      const qual = caMatch[5] ?? '';
      const arrMatch = /\/ARR-(\d{3,4})/.exec(qual);
      const pickup = date1 ?? '15JUL';
      let dropoff = pickup;
      let days = 1;
      if (date2) {
        if (/^\d{1,2}[A-Z]{3}$/.test(date2)) {
          dropoff = date2;
          days = computeNights(pickup, dropoff);
        } else {
          // /-<N> form: drop-off as N rental days
          days = parseInt(date2, 10);
          dropoff = bumpDateByDays(pickup, days);
        }
      }
      const rentals = ctx.backend.inventory.carsIn(city, company);
      if (rentals.length === 0) return 'NO CARS FOUND';
      wa.lastCarAvail = {
        city,
        pickup,
        dropoff,
        days,
        arrivalTime: arrMatch?.[1],
        rentals,
      };
      return renderCarAvailability(city, pickup, dropoff, days, rentals);
    }

    const csMatch = /^CS(\d+)(?:\/VT-([A-Z]{4}))?$/.exec(entry);
    if (csMatch) {
      if (!wa.lastCarAvail) return 'NO CAR DISPLAY';
      const line = parseInt(csMatch[1], 10);
      const vt = csMatch[2];
      let rental = wa.lastCarAvail.rentals[line - 1];
      if (!rental) return 'INVALID LINE';
      if (vt) {
        rental = wa.lastCarAvail.rentals.find((r) => r.vehicleType === vt && r.company === rental.company) ?? rental;
        if (rental.vehicleType !== vt) return 'INVALID VEHICLE TYPE';
      }
      if (rental.available < 1) return 'NO CARS AVAILABLE';
      const cached = wa.lastCarAvail;
      const seg: import('../../models/car.js').CarSegment = {
        segmentNumber: wa.pnr.segments.length + wa.pnr.hotelSegments.length + wa.pnr.carSegments.length + 1,
        company: rental.company,
        companyName: CAR_COMPANY_NAMES[rental.company] ?? rental.company,
        vehicleType: rental.vehicleType,
        category: rental.category,
        rateCode: rental.rateCode,
        city: rental.city,
        pickup: cached.pickup,
        dropoff: cached.dropoff,
        days: cached.days,
        amount: rental.amount,
        currency: rental.currency,
        pickupTime: cached.arrivalTime,
        status: 'HK',
        confirmationNumber: `CC${hotelConfirmationFor(rental.company, rental.vehicleType, wa.pnr.carSegments.length)}`,
      };
      wa.pnr.carSegments.push(seg);
      recordHistory(wa.pnr, `CS ${rental.company}${rental.vehicleType} ${cached.pickup}-${cached.dropoff}`);
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return renderCarSegment(seg);
    }

    const cxMatch = /^CX(\d+)$/.exec(entry);
    if (cxMatch) {
      const segNum = parseInt(cxMatch[1], 10);
      const idx = wa.pnr.carSegments.findIndex((s) => s.segmentNumber === segNum);
      if (idx < 0) return 'SEGMENT NOT IN ITINERARY';
      const seg = wa.pnr.carSegments[idx];
      wa.pnr.carSegments.splice(idx, 1);
      recordHistory(wa.pnr, `CX ${seg.company}${seg.vehicleType} CANCELLED`);
      return 'OK CANCELLED';
    }

    // --- v4 chunk 7: queue work verbs (QSTART / QN / QF / QFR / QXI) ---
    // Sign into a queue, walk it with the cursor, remove or skip
    // PNRs, exit. Uses WorkArea's existing currentQueue / queueCursor /
    // queueWorkingSet fields (same shape Galileo's queue handler uses).
    // QRG p.42: QF / QFR / QES exit verbs assume queue mode is active;
    // QSTART<n> is reconstructed from Amadeus mainframe convention.

    const qstartMatch = /^QSTART(\d+(?:C\d+)?(?:D\d+)?)$/.exec(entry);
    if (qstartMatch) {
      const queueKey = qstartMatch[1];
      const locators = ctx.backend.queues.get(queueKey) ?? [];
      if (locators.length === 0) return `QUEUE ${queueKey} EMPTY`;
      wa.currentQueue = queueKey;
      wa.queueWorkingSet = [...locators];
      wa.queueCursor = 0;
      const pnr = ctx.backend.pnrs.get(locators[0]);
      if (!pnr) return `QUEUE ${queueKey} PNR NOT FOUND`;
      wa.pnr = pnr;
      try { wa.machine.transition(SessionEvent.RETRIEVE); } catch { /* */ }
      return `QUEUE ${queueKey} - 1 OF ${locators.length}\n${renderAmadeusPnr(pnr, ctx.pcc, wa.agent)}`;
    }

    if (entry === 'QN' || entry === 'QF' || entry === 'QFR' || entry === 'QES') {
      if (!wa.currentQueue || !wa.queueWorkingSet) return 'NOT IN QUEUE MODE';
      // QF / QFR remove the current locator from the queue before advancing.
      if (entry === 'QF' || entry === 'QFR') {
        const currentLoc = wa.queueWorkingSet[wa.queueCursor ?? 0];
        const queueList = ctx.backend.queues.get(wa.currentQueue) ?? [];
        const idx = queueList.indexOf(currentLoc);
        if (idx >= 0) {
          queueList.splice(idx, 1);
          if (queueList.length === 0) ctx.backend.queues.delete(wa.currentQueue);
          else ctx.backend.queues.set(wa.currentQueue, queueList);
        }
      }
      // Advance the cursor.
      const next = (wa.queueCursor ?? 0) + 1;
      if (next >= wa.queueWorkingSet.length) {
        const queueKey = wa.currentQueue;
        wa.currentQueue = undefined;
        wa.queueCursor = undefined;
        wa.queueWorkingSet = undefined;
        return `END OF QUEUE ${queueKey}`;
      }
      wa.queueCursor = next;
      const nextLoc = wa.queueWorkingSet[next];
      const pnr = ctx.backend.pnrs.get(nextLoc);
      if (!pnr) return `QUEUE PNR NOT FOUND - ${nextLoc}`;
      wa.pnr = pnr;
      return `QUEUE ${wa.currentQueue} - ${next + 1} OF ${wa.queueWorkingSet.length}\n${renderAmadeusPnr(pnr, ctx.pcc, wa.agent)}`;
    }

    if (entry === 'QXI') {
      if (!wa.currentQueue) return 'NOT IN QUEUE MODE';
      const queueKey = wa.currentQueue;
      wa.currentQueue = undefined;
      wa.queueCursor = undefined;
      wa.queueWorkingSet = undefined;
      wa.reset();
      try { wa.machine.transition(SessionEvent.IGNORE); } catch { /* */ }
      return `QUEUE ${queueKey} EXITED`;
    }

    // --- v4 chunk 1: queue verbs ---
    // QE<n>[C<cat>][D<date>] — place the current PNR on queue n, end
    // the transaction. QRG p.42 "Place the PNR on a queue, category,
    // and date range" example: `QE8C1D3` = queue 8, category 1, 3 days
    // in the future. Category and date are accepted but stored only
    // as part of the queue-id key (not modelled separately). Requires
    // the work area to have a committed PNR (post-RT) OR a buildable
    // PNR (commit + queue happens atomically per the QRG's "Ending a
    // PNR Transaction" section).
    const queueEnd = /^QE([1-9]\d*)(?:C([1-9]\d*))?(?:D([1-9]\d*))?$/.exec(entry);
    if (queueEnd) {
      const queueNum = queueEnd[1];
      const category = queueEnd[2];
      const dateOffset = queueEnd[3];
      const pnr = wa.pnr;
      if (pnr.segments.length === 0) return NO_ITINERARY;
      if (pnr.names.length === 0 || pnr.phones.length === 0 || !pnr.ticketing || !pnr.receivedFrom) {
        return NEED_MANDATORY;
      }
      // Commit (assign locator if absent), then queue.
      if (!pnr.locator) {
        pnr.locator = generateRecordLocator((loc) => ctx.backend.pnrs.has(loc));
      }
      ctx.backend.pnrs.commit(pnr);
      const locator = pnr.locator!;
      // Queue id includes category and date so the same queue number
      // with different qualifiers maps to distinct queues — matches
      // Amadeus's queue-management semantics where category routes
      // within a queue (e.g., 8C1 = queue 8 category 1).
      const queueKey = `${queueNum}${category ? 'C' + category : ''}${dateOffset ? 'D' + dateOffset : ''}`;
      const existing = ctx.backend.queues.get(queueKey) ?? [];
      if (!existing.includes(locator)) existing.push(locator);
      ctx.backend.queues.set(queueKey, existing);
      try { wa.machine.transition(SessionEvent.END_TX); } catch { /* */ }
      wa.reset();
      return `QUEUED ${queueKey} - ${locator}`;
    }

    // Everything else: honest "not implemented" stub.
    return NOT_IMPLEMENTED;
  }

  isErrorResponse(response: string): boolean {
    return ERROR_RESPONSES.has(response);
  }
}
