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
import { RAIL_PROVIDER_NAMES } from '../../models/rail.js';
import { EMD_DETAIL_DEFAULTS } from '../../models/emd.js';
import { renderStoreStatus } from '../../session/store-status.js';
import { renderAreaStatus } from '../../session/area-status.js';
import { fareFor, BOOKING_CLASSES } from '../../store/tariff.js';
import { MIN_CONNECT_MINUTES } from '../../store/inventory.js';
import { connectionTypeFor } from '../../models/mct.js';
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
  AY: 'FINNAIR PLUS',
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
/**
 * Display names for the header's `<city> <name>.<country>` field —
 * format VERBATIM from Service Hub solution 897281 ("NCE COTE D
 * AZUR.FR", "EWR NEWARK INTL.USNJ"); the names themselves are
 * reconstructed for our seeded airports.
 */
const AIRPORT_DISPLAY: Record<string, string> = {
  JFK: 'NEW YORK JFK.USNY',
  LAX: 'LOS ANGELES INTL.USCA',
  SFO: 'SAN FRANCISCO.USCA',
  ORD: 'CHICAGO OHARE.USIL',
  DEN: 'DENVER INTL.USCO',
  DFW: 'DALLAS FT WORTH.USTX',
  LHR: 'LONDON HEATHROW.GB',
  FRA: 'FRANKFURT INTL.DE',
  KEF: 'KEFLAVIK.IS',
  HEL: 'HELSINKI VANTAA.FI',
  BKK: 'BANGKOK SUVARNABHUMI.TH',
  CDG: 'PARIS CH DE GAULLE.FR',
  NCE: 'COTE D AZUR.FR',
};

/** Departure terminals — SYNTHETIC (we don't model terminals; the
 *  verbatim layout shows them, e.g. `/SFO I CDG2C`). Omitted when
 *  unmapped. */
const AIRPORT_TERMINAL: Record<string, string> = {
  JFK: '4', LAX: 'B', SFO: 'I', ORD: '1', LHR: '5', FRA: '1',
  HEL: '2', BKK: '', CDG: '2E', DEN: '', DFW: 'D', KEF: '',
};

/**
 * Render the AN availability display — layout VERBATIM from Service
 * Hub solution 897281:
 *
 *   ** AMADEUS AVAILABILITY - AN ** NCE COTE D AZUR.FR 110MO 10JUN 0000
 *    2 6X 083   P9 F9 A1 J9 C9 D9 Z4 /SFO I CDG2C 620P 155P+1E0/744
 *      7X7706   C9 D9 Y9 S9 K9 H9 T9 /CDG2D NCE 2 345P+1 520P+1E0/320 14:00
 *
 * Header: banner + destination display name + <days-out><DOW> +
 * date + requested time (0000 default). Lines: number (connection
 * legs after the first are unnumbered), carrier + flight, up to 7
 * class-status pairs per row (9 = nine-plus; overflow rows indent),
 * /origin+terminal dest+terminal, times with +1 overnight marker,
 * E0/<equipment> hard against the arrival time (E = e-ticketing,
 * 0 = stops), and elapsed time on the last leg of a connection.
 * Status codes beyond seat counts (L waitlist, R request, C closed)
 * aren't modeled — our classes carry counts only.
 */
function renderAmadeusAn(
  avail: { date: string; origin: string; destination: string },
  lines: import('../../models/availability-result.js').AvailabilityLine[],
): string {
  const dest = AIRPORT_DISPLAY[avail.destination] ?? `${avail.destination}.ZZ`;
  const { daysOut, dow } = daysOutAndDow(avail.date);
  const header = `** AMADEUS AVAILABILITY - AN ** ${avail.destination} ${dest} ${daysOut}${dow} ${avail.date} 0000`;

  const rows: string[] = [];
  for (const l of lines) {
    const isContinuationLeg = l.connectionGroup != null && (l.legIndex ?? 0) > 0;
    const pairs = Object.entries(l.classes).map(([c, n]) => `${c}${Math.min(n, 9)}`);
    const firstRow = pairs.slice(0, 7).join(' ');
    const overflow = pairs.slice(7).join(' ');
    const oTerm = AIRPORT_TERMINAL[l.origin] ? ` ${AIRPORT_TERMINAL[l.origin]}` : '';
    const dTerm = AIRPORT_TERMINAL[l.destination] ?? '';
    const overnight = isOvernight(l.departTime, l.arriveTime) ? '+1' : '';
    const elapsed =
      l.connectionGroup != null && isLastLeg(l, lines)
        ? ` ${connectionElapsed(l, lines)}`
        : '';
    const head = isContinuationLeg
      ? `   ${l.carrier}${l.flightNumber.padStart(4)}`
      : `${String(l.line).padStart(2)} ${l.carrier} ${l.flightNumber.padStart(3)}`;
    rows.push(
      `${head}   ${firstRow} /${l.origin}${oTerm} ${l.destination}${dTerm} ${l.departTime} ${l.arriveTime}${overnight}E0/${l.equipment}${elapsed}`,
    );
    if (overflow) rows.push(`${' '.repeat(head.length + 3)}${overflow}`);
  }
  return [header, ...rows].join('\n');
}

/** Days until the next occurrence of DDMON + its 2-letter weekday. */
function daysOutAndDow(date: string): { daysOut: number; dow: string } {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const m = /^(\d{1,2})([A-Z]{3})$/.exec(date);
  if (!m) return { daysOut: 0, dow: '' };
  const mon = months.indexOf(m[2]);
  if (mon < 0) return { daysOut: 0, dow: '' };
  const now = new Date();
  let target = new Date(Date.UTC(now.getUTCFullYear(), mon, parseInt(m[1], 10)));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (target < today) target = new Date(Date.UTC(now.getUTCFullYear() + 1, mon, parseInt(m[1], 10)));
  const daysOut = Math.round((target.getTime() - today.getTime()) / 86400000);
  const dows = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  return { daysOut, dow: dows[target.getUTCDay()] };
}

/** Heuristic overnight marker: arrival minutes ≤ departure minutes. */
function isOvernight(dep: string, arr: string): boolean {
  return clockMinutes(arr) <= clockMinutes(dep);
}

function clockMinutes(t: string): number {
  const m = /^(\d{1,2})(\d{2})([APN])$/.exec(t);
  if (!m) return 0;
  let h = parseInt(m[1], 10) % 12;
  if (m[3] === 'P') h += 12;
  if (m[3] === 'N') h = 12;
  return h * 60 + parseInt(m[2], 10);
}

function isLastLeg(
  l: import('../../models/availability-result.js').AvailabilityLine,
  all: import('../../models/availability-result.js').AvailabilityLine[],
): boolean {
  const group = all.filter((x) => x.connectionGroup === l.connectionGroup);
  return (l.legIndex ?? 0) === group.length - 1;
}

/** Total elapsed H:MM across a connection (first dep → last arr,
 *  crude +24h wrap per overnight leg). */
function connectionElapsed(
  l: import('../../models/availability-result.js').AvailabilityLine,
  all: import('../../models/availability-result.js').AvailabilityLine[],
): string {
  const group = all.filter((x) => x.connectionGroup === l.connectionGroup);
  const first = group[0];
  const last = group[group.length - 1];
  let mins = clockMinutes(last.arriveTime) - clockMinutes(first.departTime);
  for (const leg of group) if (isOvernight(leg.departTime, leg.arriveTime)) mins += 1440;
  if (mins < 0) mins += 1440;
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}

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

/**
 * Render the retrieved-PNR display — chunk 34, calibrated to the
 * VERBATIM layout from Service Hub solutions 453392470 ("How to
 * retrieve a PNR") and 906462/797696 (post-issuance PNRs):
 *
 *   --- TST RLR SFP ---
 *   RP/NCE1A0900/NCE1A0900            AA/GS  13JAN25/1307Z   3XZ3N5
 *     1.SMITH/KATY MS
 *     2  AF 002 R 20JUN 5 CDGJFK HK1  0830 1030   *1A/E*
 *     4 AP NCE 555-1212-H
 *     5 TK OK13JAN/NCE1A0900//ETAF
 *     6 SSR DOCS AF HK1 ...
 *
 * One unified numbering across every element type, in the published
 * order: names -> segments (air + aux) -> AP family -> TK -> SSR ->
 * OSI -> RM -> FA/FHD/FHP -> FB. Status banner from PNR state: TST
 * (priced), TSM (EMDs exist), RLR (committed locator), SFP (DOCS
 * data held). MSC and the OPW/OPC time-limit elements aren't
 * modeled. Air segment lines: concatenated city pair, ISO weekday
 * digit, 24-hour times, the *1A/E* e-ticketing flag.
 */
function renderAmadeusPnr(pnr: Pnr, pcc: string, agent?: string): string {
  const banner: string[] = [];
  if (pnr.priceQuotes.length > 0) banner.push('TST');
  if (pnr.emds.some((e) => !e.manual)) banner.push('TSM');
  if (pnr.locator) banner.push('RLR');
  if (pnr.ssrs.some((x) => x.code === 'DOCS')) banner.push('SFP');

  const now = new Date();
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const stamp = `${now.getUTCDate()}${months[now.getUTCMonth()]}${String(now.getUTCFullYear() % 100).padStart(2, '0')}/${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}Z`;
  const lines: string[] = [];
  if (banner.length > 0) lines.push(`--- ${banner.join(' ')} ---`);
  lines.push(`RP/${pcc}/${pcc}            ${agent ?? '--'}/SU  ${stamp}   ${pnr.locator ?? ''}`.trimEnd());

  let n = 0;
  const push = (text: string) => {
    n += 1;
    lines.push(`${String(n).padStart(3)}${text}`);
  };

  // 1. Names — `  1.ARCHER/COLIN MR` (number hard against the dot).
  pnr.names.forEach((nm) => {
    nm.passengers.forEach((pax) => {
      const title = pax.title ? ` ${pax.title}` : '';
      push(`.${nm.surname}/${pax.firstName}${title}`);
    });
  });

  // 2. Itinerary — air + aux interleaved by segmentNumber.
  const itin: { seg: number; text: string }[] = [];
  for (const sgm of pnr.segments) {
    const dep = clock24(sgm.departTime);
    const overnight = sgm.arriveDate != null || isOvernight(sgm.departTime, sgm.arriveTime);
    const arr = clock24(sgm.arriveTime) + (overnight ? '+1' : '');
    const dowNum = sgm.dayOfWeekNum >= 1 && sgm.dayOfWeekNum <= 7
      ? sgm.dayOfWeekNum
      : isoDowFor(sgm.date);
    // Passive/ghost segments show the airline locator where active
    // segments show *1A/E* (875906 verbatim: "UA 323 Q 10APR 4
    // MIAEWR PK1          0800 1058   RECLOC").
    const trailer = ['PK', 'PL', 'GK'].includes(sgm.status)
      ? (sgm.airlineLocator ?? '')
      : '*1A/E*';
    itin.push({
      seg: sgm.segmentNumber,
      text: `  ${sgm.carrier}${sgm.flightNumber.padStart(4)} ${sgm.bookingClass} ${sgm.date} ${dowNum} ${sgm.origin}${sgm.destination} ${sgm.status}${sgm.seats}  ${dep} ${arr}   ${trailer}`.trimEnd(),
    });
  }
  for (const h of pnr.hotelSegments) {
    itin.push({ seg: h.segmentNumber, text: ` HHL ${h.chain} ${h.status} ${h.city} ${h.checkIn}-${h.checkOut} ${h.rooms}RM ${h.name} ${h.rateCode} ${h.ratePerNight.toFixed(2)}${h.currency} ${h.confirmationNumber ?? ''}`.trimEnd() });
  }
  for (const c of pnr.carSegments) {
    itin.push({ seg: c.segmentNumber, text: ` CCR ${c.company} ${c.status} ${c.city} ${c.pickup}-${c.dropoff} ${c.vehicleType} ${c.rateCode} ${c.amount.toFixed(2)}${c.currency}/DY ${c.confirmationNumber ?? ''}`.trimEnd() });
  }
  for (const r of pnr.railSegments) {
    itin.push({ seg: r.segmentNumber, text: ` TRN ${r.provider} ${r.trainNumber} ${r.bookingClass} ${r.date} ${r.origin} ${r.destination} ${r.status}${r.seats} ${r.departTime} ${r.arriveTime} ${r.confirmationNumber ?? ''}`.trimEnd() });
  }
  for (const v of pnr.svcSegments) {
    // Verbatim line shape (843687): ` /SVC 6X HK1 LOUS JFK 15APR-VIP XXX`
    itin.push({ seg: v.segmentNumber, text: ` /SVC ${v.carrier} ${v.status}${v.count} ${v.code}${v.origin ? ' ' + v.origin : ''}${v.date ? ' ' + v.date : ''}${v.text ? '-' + v.text : ''}` });
  }
  itin.sort((a, b) => a.seg - b.seg).forEach((e) => push(e.text));

  // 3. Contact (AP) family.
  for (const ph of pnr.phones) {
    push(` AP ${ph.city ? ph.city + ' ' : ''}${ph.number}${ph.type ? '-' + ph.type[0].toUpperCase() : ''}`);
  }

  // 4. Ticketing arrangement — `//ET<cxr>` once tickets exist (906462).
  if (pnr.ticketing) {
    const etSuffix = pnr.tickets.length > 0 ? `//ET${pnr.tickets[0].validatingCarrier}` : '';
    const body = pnr.ticketing.replace(/^TK/, '');
    push(` TK ${body}/${pcc}${etSuffix}`);
  }

  // 5-7. SSR / OSI / RM elements.
  for (const ssr of pnr.ssrs) {
    push(` SSR ${ssr.code} ${ssr.carrier} ${ssr.status}1${ssr.text ? ' ' + ssr.text : ''}`);
  }
  for (const osi of pnr.osis) {
    push(` OSI ${osi.carrier} ${osi.text}`);
  }
  for (const rm of pnr.remarks) {
    push(` RM ${rm.text}`);
  }

  // 8. E-ticket document elements — chunk 35, shapes VERBATIM from
  //    906462 ("How to issue an e-ticket"): FA PAX <num>/ET<cxr>/
  //    <cur><amt>/<date>/<office>/<iata>/S<segs> + FB AIR number +
  //    FM commission + FV validating carrier. (FE endorsement not
  //    modeled — no endorsement text on TicketRecord.)
  const segRange = pnr.segments.length > 1 ? `S2-${pnr.segments.length + 1}` : 'S2';
  pnr.tickets.forEach((t, i) => {
    const d = t.issuedAt;
    const date = `${d.getUTCDate()}${months[d.getUTCMonth()]}${String(d.getUTCFullYear() % 100).padStart(2, '0')}`;
    const dashed = `${t.number.slice(0, 3)}-${t.number.slice(3)}`;
    push(` FA PAX ${dashed}/ET${t.validatingCarrier}/${t.total.toFixed(2)}/${date}/${pcc}/${String(i + 1).padStart(8, '0')}/${segRange}`);
    push(` FB PAX ${String(i).padStart(10, '0')} TTP/RT OK ETICKET/${segRange}`);
    push(` FM PAX *C*${(t.commission ?? 0).toFixed(2)}/${segRange}`);
    push(` FV PAX ${t.validatingCarrier}/${segRange}`);
  });

  // 9. EMD document elements — FA/FB shapes VERBATIM from 797696
  //    (DT prefix = EMD vs ET = e-ticket; /E<n> element assoc).
  pnr.emds.forEach((e, i) => {
    if (e.manual) {
      push(` ${e.manual} PAX ${e.number}/E${e.elementRef ?? ''}`);
      return;
    }
    const d = e.issuedAt;
    const date = `${d.getUTCDate()}${months[d.getUTCMonth()]}${String(d.getUTCFullYear() % 100).padStart(2, '0')}`;
    push(` FA PAX ${e.number}/DT${e.carrier}/${e.currency}${e.amount.toFixed(2)}/${date}/${pcc}/${String(i + 1).padStart(8, '0')}/E${e.elementRef ?? ''}`);
    push(` FB PAX ${String(i).padStart(10, '0')} TTP/O/TTM/RT OK ETICKET/EMD/E${e.elementRef ?? ''}`);
  });

  return lines.join('\n');
}

/** ISO weekday (1=MO..7=SU) of the next occurrence of a DDMON date. */
function isoDowFor(date: string): number {
  const { dow } = daysOutAndDow(date);
  const map: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
  return map[dow] ?? 0;
}

/** Convert a 900A/520P clock token to the display's 24-hour HHMM. */
function clock24(t: string): string {
  const m = /^(\d{1,2})(\d{2})([APN])$/.exec(t);
  if (!m) return t;
  let h = parseInt(m[1], 10) % 12;
  if (m[3] === 'P') h += 12;
  if (m[3] === 'N') h = 12;
  return `${String(h).padStart(2, '0')}${m[2]}`;
}

/**
 * Render the itinerary block — air + hotel (HHL) + car (CCR) segments
 * interleaved by segmentNumber, the way Amadeus shows auxiliary
 * segments inline in the PNR. Line shapes follow the Amadeus
 * auxiliary-segment conventions (`HHL` = hotel, `CCR` = car, per the
 * QRG's hotel/car chapters); exact response wording reconstructed.
 */
function renderAmadeusItinerary(pnr: Pnr): string {
  const lines: { n: number; text: string }[] = [];
  for (const s of pnr.segments) {
    lines.push({
      n: s.segmentNumber,
      text: `  ${s.segmentNumber}. ${s.carrier} ${s.flightNumber} ${s.bookingClass} ${s.date} ${s.origin} ${s.destination} ${s.status}${s.seats}`,
    });
  }
  for (const h of pnr.hotelSegments) {
    lines.push({
      n: h.segmentNumber,
      text: `  ${h.segmentNumber}. HHL ${h.chain} ${h.status} ${h.city} ${h.checkIn}-${h.checkOut} ${h.rooms}RM ${h.name} ${h.rateCode} ${h.ratePerNight.toFixed(2)}${h.currency} ${h.confirmationNumber ?? ''}`.trimEnd(),
    });
  }
  for (const c of pnr.carSegments) {
    lines.push({
      n: c.segmentNumber,
      text: `  ${c.segmentNumber}. CCR ${c.company} ${c.status} ${c.city} ${c.pickup}-${c.dropoff} ${c.vehicleType} ${c.rateCode} ${c.amount.toFixed(2)}${c.currency}/DY ${c.confirmationNumber ?? ''}`.trimEnd(),
    });
  }
  for (const r of pnr.railSegments) {
    lines.push({
      n: r.segmentNumber,
      text: `  ${r.segmentNumber}. TRN ${r.provider} ${r.trainNumber} ${r.bookingClass} ${r.date} ${r.origin} ${r.destination} ${r.status}${r.seats} ${r.departTime} ${r.arriveTime} ${r.confirmationNumber ?? ''}`.trimEnd(),
    });
  }
  return lines
    .sort((a, b) => a.n - b.n)
    .map((l) => l.text)
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
/**
 * EGSD list screen — layout VERBATIM from the Service Hub sample:
 *
 *   LIST OF EMD SERVICES FOR AIRLINE: 6X
 *
 *       CODE  RFIC/SC  BOOK  TA ISS. DESCRIPTION
 *
 *   1   BULK   A/C03   SSR     YES   Bulk
 */
function renderEgsdList(carrier: string, services: import('../../models/emd.js').EmdService[]): string {
  const lines = [`LIST OF EMD SERVICES FOR AIRLINE: ${carrier}`, ''];
  lines.push('    CODE  RFIC/SC  BOOK  TA ISS. DESCRIPTION');
  lines.push('');
  services.forEach((s2, i) => {
    lines.push(
      `${String(i + 1).padEnd(3)} ${s2.code.padEnd(6)} ${(s2.rfic + '/' + s2.rfisc).padEnd(8)} ${s2.bookingMethod.padEnd(5)} ${(s2.taIssuable ? 'YES' : 'NO').padEnd(5)} ${s2.description}`,
    );
  });
  return lines.join('\n');
}

/**
 * EGSD detail screen — field set VERBATIM from the Service Hub FBAG
 * sample (every line below appears in the published screen).
 */
function renderEgsdDetail(svc: import('../../models/emd.js').EmdService): string {
  const d = { ...EMD_DETAIL_DEFAULTS, ...(svc.detail ?? {}) };
  const yn = (b: boolean) => (b ? 'YES' : 'NO');
  return [
    `${svc.code}: ${svc.description}`,
    `VALIDATING CARRIER:${svc.carrier} RFIC:${svc.rfic} RFISC:${svc.rfisc} EMD TYPE:${d.emdType}`,
    '',
    `BOOKING METHOD: ${svc.bookingMethod}`,
    '',
    `MONOCOUPON EMD: ${yn(d.monocoupon)}`,
    `CONSUMED AT ISSUANCE: ${yn(d.consumedAtIssuance)}`,
    `ADDITIONAL DOCUMENT IN EXCHANGE: ${yn(d.additionalDocInExchange)}`,
    `RESIDUAL VALUE: ${yn(d.residualValue)}`,
    '',
    `ROUTING INFORMATION MANDATORY FOR ISSUANCE: ${yn(d.routingMandatory)}`,
    `ISSUED IN CONNECTION WITH MANDATORY FOR ISSUANCE: ${yn(d.issuedInConnectionMandatory)}`,
    `EXCESS BAGGAGE INFORMATION MANDATORY FOR ISSUANCE: ${yn(d.excessBaggageMandatory)}`,
    '',
    `REFUNDABLE (ONLY FOR MANUAL PRICING): ${yn(d.refundable)}`,
    `EXCHANGEABLE (ONLY FOR MANUAL PRICING): ${yn(d.exchangeable)}`,
    `INTERLINEABLE: ${yn(d.interlineable)}`,
    `ENDORSABLE: ${yn(d.endorsable)}`,
    '',
    `ISSUABLE BY TRAVEL AGENT: ${yn(svc.taIssuable)}`,
    `DISPLAYABLE BY TRAVEL AGENT IF ISSUED BY AIRLINE AGENT: ${yn(d.displayableByTaIfAirlineIssued)}`,
    `REFUNDABLE/EXCHANGEABLE BY T/A IF ISSUED BY AIRLINE AGENT: ${yn(d.refundExchangeByTaIfAirlineIssued)}`,
    `TRAVEL AGENT ALLOWED TO ASSOCIATE AND DISASSOCIATE: ${yn(d.taAssociateDisassociate)}`,
  ].join('\n');
}

/**
 * The PNR's chargeable SSR elements — those whose code appears in the
 * carrier's EMD guide (booking method SSR). The EMD carrier is the
 * SSR's own carrier, falling back to the first air segment's.
 */
function chargeableSsrs(
  pnr: Pnr,
  ctx: HandlerContext,
): { ssr: import('../../models/service.js').SpecialServiceRequest; service: import('../../models/emd.js').EmdService; index: number }[] {
  const out: { ssr: import('../../models/service.js').SpecialServiceRequest; service: import('../../models/emd.js').EmdService; index: number }[] = [];
  const fallbackCarrier = pnr.segments[0]?.carrier;
  pnr.ssrs.forEach((ssr, i) => {
    const carrier = ssr.carrier !== 'YY' ? ssr.carrier : fallbackCarrier;
    if (!carrier) return;
    const svc = ctx.backend.inventory.emdServicesFor(carrier).find(
      (e) => e.code === ssr.code && e.bookingMethod === 'SSR',
    );
    // TA ISS. NO rows (823571: HBAG, BBEV…) never issue from a
    // travel-agent terminal.
    if (svc && svc.taIssuable) out.push({ ssr, service: svc, index: i + 1 });
  });
  return out;
}

/**
 * EWD list screen — layout VERBATIM from Service Hub solution 873296:
 *
 *   EMD NBR          NAME         S   DOI      RFI     DESCRIPTION
 *   1 XXXXXXXXXXXXX  PASSENGER/LINDA  O   21APR1x  C/EXW   EXCESS WEIGHT
 *
 * Sorted by issue date, most recent first (per the solution text).
 */
function renderAmadeusEwdList(emds: import('../../models/emd.js').EmdRecord[]): string {
  const lines = ['EMD NBR          NAME         S   DOI      RFI     DESCRIPTION'];
  const sorted = [...emds].sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
  sorted.forEach((e, i) => {
    const doi = formatDdmonyy(e.issuedAt);
    const statusChar = e.status === 'OPEN' ? 'O' : e.status[0];
    lines.push(`${i + 1} ${e.number}  ${e.passenger}  ${statusChar}   ${doi}  ${e.rfic}/${e.rfisc}   ${e.serviceCode}`);
  });
  return lines.join('\n');
}

/**
 * EWD record screen — coupon-block layout VERBATIM from Service Hub
 * solution 866006 ("How to re-associate an EMD to a ticket"):
 *
 *   RFIC-C  BAGGAGE
 *   REMARKS-
 *   CPN-1  RFISC-0CC  AF CDGARN  S-O
 *    DESCRIPTION-1ST ADDITIONAL BAG
 *    NON-REFUNDABLE
 *    PRESENT TO-
 *    PRESENT AT-
 *    ICW-0575417737101E1           (A)
 *   FARE   F    EUR         100.00
 *
 * Header line reconstructed (the solution starts at the RFIC row).
 */
function renderAmadeusEwdRecord(e: import('../../models/emd.js').EmdRecord, line: number): string {
  const lines = [
    `EMD-${e.number}  TYPE ${e.emdType}  ${line}  ${e.passenger}`,
    `RFIC-${e.rfic}  ${RFIC_NAMES[e.rfic] ?? ''}`,
    'REMARKS-',
    `CPN-1  RFISC-${e.rfisc}  ${e.carrier}  S-${e.status === 'OPEN' ? 'O' : e.status[0]}`,
    ` DESCRIPTION-${e.serviceCode}`,
    ' NON-REFUNDABLE',
    ' PRESENT TO-',
    ' PRESENT AT-',
  ];
  if (e.icwTicket) {
    lines.push(` ICW-${e.icwTicket}E1           (${e.icwAssociated ? 'A' : 'D'})`);
  }
  lines.push(`FARE   F    ${e.currency}         ${e.amount.toFixed(2)}`);
  return lines.join('\n');
}

/**
 * EWH screen — layout VERBATIM from Service Hub solution 828612:
 *
 *   EMD HISTORY DISPLAY
 *   EMD-0571234567890   TYPE-A   RFIC-C
 *   CPN RFISC ST SAC              OFFICE ID SIGN       TIME/DATE
 *     1   0CC  O                  NCEXXXXXX A0032AAGS  1335Z20JAN25
 *
 * Rows ordered by coupon, most recent status first per coupon.
 */
function renderAmadeusEwh(e: import('../../models/emd.js').EmdRecord): string {
  const lines = [
    'EMD HISTORY DISPLAY',
    `EMD-${e.number.replace('-', '')}   TYPE-${e.emdType}   RFIC-${e.rfic}`,
    'CPN RFISC ST SAC              OFFICE ID SIGN       TIME/DATE',
  ];
  const events = [...(e.history ?? [])].sort(
    (a, b) => a.coupon - b.coupon || b.at.getTime() - a.at.getTime(),
  );
  for (const ev of events) {
    const hh = String(ev.at.getUTCHours()).padStart(2, '0');
    const mm = String(ev.at.getUTCMinutes()).padStart(2, '0');
    const stamp = `${hh}${mm}Z${formatDdmonyy(ev.at)}`;
    lines.push(
      `  ${ev.coupon}   ${ev.rfisc.padEnd(4)} ${ev.status.padEnd(2)} ${(ev.sac ?? '').padEnd(16)} ${ev.office.padEnd(9)} ${ev.sign.padEnd(10)} ${stamp}`,
    );
  }
  return lines.join('\n');
}

/**
 * Interline agreement tables (TGAD) — BA's rows VERBATIM from
 * Service Hub solution 2318986 (T ticketing / P prepaid / E
 * electronic ticket / D EMD). Carriers without a published table
 * fall back to a reconstructed all-TPED grid.
 */
const TGAD_AGREEMENTS: Record<string, [string, string][]> = {
  BA: [
    ['AA', 'TPED'], ['AC', 'TPED'], ['AE', 'TPE'], ['AF', 'TPE'],
    ['AH', 'TPE'], ['AI', 'T E'], ['AM', 'TPE'], ['AS', 'TPED'],
    ['AT', 'TPE'], ['AV', 'TPE'], ['AY', 'TPED'], ['AZ', 'TPE'],
    ['A3', 'T E'], ['BA', 'TP'], ['BG', 'T E'], ['BI', 'TPED'],
    ['BP', 'TPE'], ['BR', 'TPE'], ['BT', 'TPE'], ['BW', 'TPE'],
    ['B6', 'T E'], ['CA', 'TPE'], ['CI', 'TPE'], ['CM', 'TPE'],
    ['CX', 'TPED'], ['CZ', 'TPE'], ['DL', 'TPE'], ['DT', 'TPE'],
    ['EI', 'TPED'], ['ET', 'TPE'], ['EY', 'TPE'], ['EZ', 'TP'],
    ['FB', 'TPE'], ['FI', 'TPE'], ['FJ', 'TPE'], ['GA', 'TPE'],
    ['GF', 'TPE'], ['GK', 'TPE'], ['G3', 'TPE'], ['HA', 'TPE'],
    ['HM', 'TPE'], ['HX', 'TPE'], ['IB', 'TPED'], ['IC', 'TPE'],
    ['IZ', 'TPE'], ['JJ', 'TPE'], ['JL', 'TPED'], ['JM', 'TPE'],
    ['JQ', 'TPE'], ['JU', 'TPED'], ['JY', 'TPE'], ['KC', 'TPE'],
    ['KE', 'TPED'], ['KL', 'TPE'], ['KM', 'TPE'], ['KP', 'TPE'],
  ],
};

const RFIC_NAMES: Record<string, string> = {
  A: 'AIR TRANSPORTATION', C: 'BAGGAGE', D: 'FINANCIAL IMPACT',
  E: 'AIRPORT SERVICES', G: 'IN-FLIGHT SERVICES',
};

/**
 * TSM-P mask — layout VERBATIM from solution 823571:
 *
 *   TSM    1  TYPE P     NCEXXXXXX AA/07JAN 11       EMD-A CARR AF
 *     1.SMITH/KATY MS
 *   RFIC-C/U   BAGGAGE
 *       1. RFISC-0C3 EXCESS BAGGAGE                       L   7
 *          OPERATING CC-AF                  ORIGIN-CDG DEST-JFK
 */
function renderAmadeusTsmMask(t: import('../../models/emd.js').TsmRecord, pcc: string, agent?: string): string {
  const now = new Date();
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const stamp = `${agent ?? '--'}/${String(now.getUTCDate()).padStart(2, '0')}${months[now.getUTCMonth()]}`;
  return [
    `TSM    ${t.number}  TYPE P     ${pcc} ${stamp} ${t.elementRef}       EMD-A CARR ${t.carrier}`,
    `  1.${t.passenger}`,
    `RFIC-${t.rfic}/U   ${RFIC_NAMES[t.rfic] ?? ''}`,
    `    1. RFISC-${t.rfisc} ${t.description.padEnd(50)} L   ${t.elementRef}`,
    `       OPERATING CC-${t.carrier}${t.origin ? `                                     ORIGIN-${t.origin} DEST-${t.destination}` : ''}`,
  ].join('\n');
}

/** Expand "1-2,4" into [1,2,4]. */
function expandSelection(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      for (let i = parseInt(range[1], 10); i <= parseInt(range[2], 10); i++) out.push(i);
    } else if (/^\d+$/.test(part)) {
      out.push(parseInt(part, 10));
    }
  }
  return out;
}

/** Reverse lookup of the airline numeric prefix (FHD057- → AF).
 *  Mirror of models/ticket.ts AIRLINE_NUMERIC. */
function numericToCarrier(prefix: string): string {
  const known: Record<string, string> = {
    '001': 'AA', '016': 'UA', '006': 'DL', '279': 'B6', '125': 'BA',
    '220': 'LH', '027': 'AS', '526': 'WN', '057': 'AF', '172': '6X',
  };
  return known[prefix] ?? prefix;
}

function formatDdmonyy(d: Date): string {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${d.getUTCDate()}${months[d.getUTCMonth()]}${String(d.getUTCFullYear() % 100).padStart(2, '0')}`;
}

const AMADEUS_HELP_BANNER =
  'EMULATOR HELP — implemented verb surface (host help pages are not public)';

const AMADEUS_HELP_TOPICS: { keys: string[]; title: string; lines: string[] }[] = [
  { keys: ['JI', 'SIGNON', 'JM'], title: 'SIGN ON / OFF / AREAS', lines: [
    'JI[<area>|*|A/B/C]<num><agent>/<duty>   sign on (area / all / list)',
    'JM<letter> move · JX<letter> move+sign in · JB redisplay · JS suspend',
    'JO[<areas>|*]  sign off    JD  work-area status grid'] },
  { keys: ['AN', 'AVAIL'], title: 'AVAILABILITY', lines: [
    'AN<date><org><dst>      neutral availability', 'R/AD <date><org><dst>   rail availability',
    '(seeded city pairs: HE MARKETS)'] },
  { keys: ['SS', 'SELL'], title: 'SELL', lines: [
    'SS<seats><class><line>  sell from displayed availability (air or rail)'] },
  { keys: ['NM', 'NAME'], title: 'NAMES', lines: [
    'NM<n><sur>/<given> <title>   add name(s)', 'NU<n>/<body>                 modify name'] },
  { keys: ['SR', 'SSR'], title: 'SSR / OSI', lines: [
    'SR <code>[<cxr>][/P<n>]   SSR', 'OS <cxr> <text>[/P<n>]    OSI'] },
  { keys: ['FF', 'FFN', 'FFA'], title: 'FREQUENT FLYER', lines: [
    'FFA<cxr>-<num>[, <cxr2>…]   accrual (SSR FQTV)',
    'FFR<cxr>-<num>              redemption (FQTR)',
    'FFU<cxr>-<num>              upgrade (FQTU)',
    'FFD / FFN <cxr>-<num>/P<n> / VFFD [<cxr>]'] },
  { keys: ['SM', 'SEATMAP'], title: 'SEAT MAPS / SEATS', lines: [
    'SM <n>[/V|/H][/NL|/L]       seat map for segment',
    'SM/<line>[/<class>]         from availability   MD MU MB MT  scroll',
    'ST/<seat|pref>[/P<n>][/S<n>]   seat request    SX[/S<n>]  cancel'] },
  { keys: ['FXP', 'PRICING', 'TTP'], title: 'PRICING / TICKETING', lines: [
    'FXP / FXX / TQT             price · display quotes',
    'TTP[/ET|/PT][/S<n>-<m>]     issue tickets',
    'TWD[/L<n>] / TWDRL / TWH    display ET records',
    'TK<OK|TL|DO|IN|MA|SS|XL>…   ticketing arrangement'] },
  { keys: ['INV', 'DOCS'], title: 'DOCUMENTS', lines: [
    'INV / INE [/P<n>][/S<n>]    invoice (basic / extended)',
    'IBP / IEP [J]               itinerary (print / joint)'] },
  { keys: ['HA', 'HOTEL', 'HOT'], title: 'HOTELS', lines: [
    'HA[<chain>]<city>[<prop>][<d1>[-<d2>]]   availability',
    'HS<line>[/<rate>]   sell      HX<n>   cancel'] },
  { keys: ['CA', 'CAR'], title: 'CARS', lines: [
    'CA[<co>]<city>[<d1>[-<d2>|-<N>]][/ARR-<t>]   availability',
    'CS<line>[/VT-<vt>]  sell      CX<n>   cancel'] },
  { keys: ['RAIL', 'ACCESRAIL'], title: 'RAIL', lines: [
    'R/AD <date><org><dst>[<time>]   by departure time',
    'R/AN …                          neutral; sell with SS, cancel XE<n>'] },
  { keys: ['QE', 'QUEUES'], title: 'QUEUES', lines: [
    'QE<n>[C<cat>][D<date>]   place    QSTART<n>  sign in',
    'QN / QF / QFR / QES / QXI        next / remove / skip / exit'] },
  { keys: ['RT', 'DISPLAY'], title: 'DISPLAY / RETRIEVE', lines: [
    'RT<locator> / RT/<surname>      retrieve',
    'RTA RTI RTN RTJ RTK RTF RTG RTR RTQ   partial displays', 'RH   history'] },
  { keys: ['RRN', 'COPY'], title: 'COPY / SPLIT', lines: [
    'RRN[/<n>|/DP<d>|/DM<d>|/C<cls>|/P<list>|/PX<list>|/S<list>|/SX<list>]',
    'RRI[/…]   itinerary only        SP <list> + EF   split'] },
  { keys: ['EMD', 'TTM', 'EWD', 'EGSD'], title: 'EMD - MISC DOCUMENTS', lines: [
    'EGSD/V<cxr>[/SC-<code>|/RFIC-<l>|/BM-<m>|/L<n>]   service guide',
    'TTM[/L<n>][/P<n>][/INF][/RT]   issue EMDs for chargeable SSRs',
    'TTP/TTM            tickets + EMDs together (TTP first)',
    'EWD[/<n>|/L<n>|/EMD<num>]   record display    EWDRT EWDRL  redisplay',
    'FXK[/P<n>][/S<n>]  ancillary catalogue    FWK<n>  book from line',
    'IU <cxr> NN<n> <code>…   auxiliary SVC segment    EWH  history'] },
  { keys: ['DM', 'MCT'], title: 'MIN CONNECT TIME', lines: [
    'DM<apt>[-<apt2>][/<date>]   MCT lookup (layered: standards +',
    '  carrier exceptions)        DMI   continuity check'] },
];

/**
 * HE HE — help on help. The content here IS source-grounded: the
 * forms are the QRG p.5 "Amadeus Online Help Pages" table + the
 * Complete Amadeus Manual's Help System chapter, verbatim.
 */
function renderAmadeusHelpOnHelp(): string {
  return [
    AMADEUS_HELP_BANNER,
    '',
    'AMADEUS ONLINE HELP PAGES',
    '  HE              main subject index',
    '  HE HE           help on help (this page)',
    '  HE <letter>     help index by letter',
    '  HE <code>       help on a specific transaction (HE NM)',
    '  HE <topic>      help on a specific topic (HE PNR NAME)',
    '  HE STEPS        step-by-step instructions for common tasks',
    '  HE/             help on the last transaction after a format error',
    '  MP HE           redisplay the last help screen',
    '',
    'SCROLLING: MD MU MT MB (help screens scroll like AIS pages)',
  ].join('\n');
}

/**
 * HE STEPS — step-by-step guide for key functionality (QRG p.5 /
 * manual "Step wise guide"). Emulator-native walkthrough of the
 * core PNR build this terminal supports.
 */
function renderAmadeusSteps(): string {
  return [
    AMADEUS_HELP_BANNER,
    '',
    'STEPS — BUILD AND TICKET A PNR',
    '  1. JI2345HA/GS              sign on',
    '  2. AN15JULJFKLAX            availability',
    '  3. SS1Y1                    sell from line 1',
    '  4. NM1SMITH/JOHN MR         name',
    '  5. AP020 555-1212-A         phone',
    '  6. TKOK                     ticketing arrangement',
    '  7. RF AGT                   received from',
    '  8. FXP                      price',
    '  9. ER                       end transact + retrieve (locator)',
    ' 10. TTP                      issue tickets   TWD  display them',
    '',
    'HE <code> FOR ANY STEP (HE SS, HE NM, HE FXP, HE TTP…)',
  ].join('\n');
}

function renderAmadeusHelp(topic?: string): string {
  if (!topic) {
    return [AMADEUS_HELP_BANNER, '', 'TOPICS — HE <topic>:',
      ...AMADEUS_HELP_TOPICS.map((t) => `  ${t.keys[0].padEnd(8)} ${t.title}`),
      '  MARKETS  SEEDED INVENTORY — what this emulator serves',
      '  STORE    PNR PERSISTENCE — what survives a restart'].join('\n');
  }
  let t = AMADEUS_HELP_TOPICS.find((x) => x.keys.includes(topic));
  if (!t && topic.includes(' ')) {
    // Multi-word topic (QRG: "Help on a specific topic — HE PNR
    // NAME"): match any word against the topic keys.
    const words = topic.split(/\s+/);
    t = AMADEUS_HELP_TOPICS.find((x) => x.keys.some((k) => words.includes(k)));
    if (!t) {
      t = AMADEUS_HELP_TOPICS.find((x) =>
        words.some((w) => x.title.split(/[\s/]+/).includes(w)));
    }
  }
  if (!t) {
    const matches = AMADEUS_HELP_TOPICS.filter((x) => x.keys.some((k) => k.startsWith(topic)));
    if (matches.length > 0) {
      return [AMADEUS_HELP_BANNER, '', `TOPICS MATCHING ${topic}:`,
        ...matches.map((m) => `  ${m.keys[0].padEnd(8)} ${m.title}`)].join('\n');
    }
    return `NO HELP FOR ${topic} — HE FOR THE TOPIC INDEX`;
  }
  return [AMADEUS_HELP_BANNER, '', t.title, ...t.lines.map((l) => `  ${l}`)].join('\n');
}

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
    const result = this.dispatchEntry(raw, wa, ctx);
    // HE/ support: remember the last FORMAT-rejected entry (but not
    // help entries themselves, so HE/ after a failed HE typo doesn't
    // chase its own tail). Manual: "Display online help for your
    // attempted command when you receive a format error."
    const trimmed = raw.trim().toUpperCase();
    const failed = result === FORMAT_ERROR || result === NOT_IMPLEMENTED;
    if (failed && !trimmed.startsWith('HE') && trimmed !== 'HELP' && trimmed !== 'MPHE') {
      wa.lastFailedEntry = raw.trim();
    }
    return result;
  }

  private dispatchEntry(raw: string, wa: WorkArea, ctx: HandlerContext): string {
    const entry = raw.trim();
    if (entry.length === 0) return FORMAT_ERROR;

    // Sign-on family. JI prefix → sign-in; JO[*] → sign-out; JD → status.
    // --- Help: the Amadeus Online Help Pages family, forms verbatim
    // from the in-tree QRG p.5 + the Complete Amadeus Manual (Jasir
    // Alavi, references/amadeus/) Help System chapter:
    //   HE              main subject index        HELP   (same)
    //   HE HE / HE HELP help on help
    //   HE <letter>     index by letter (prefix match)
    //   HE <code>       help on a transaction (HE NM, HE SM…)
    //   HE <topic …>    multi-word topic (HE PNR NAME)
    //   HE STEPS        step-by-step guide for key functionality
    //   HE/             help for your attempted command after a
    //                   FORMAT error (manual, verbatim semantics)
    //   MP HE / MPHE    redisplay the last help screen
    // Content is emulator-native — Amadeus's real help page BODIES
    // aren't public; each topic lists the verb surface this emulator
    // implements, and the banner says so.
    if (entry === 'HELP' || entry === 'HE') {
      const screen = renderAmadeusHelp();
      wa.lastHelpScreen = screen;
      return screen;
    }
    if (entry === 'MPHE' || entry === 'MP HE') {
      return wa.lastHelpScreen ?? 'NO HELP SCREEN TO REDISPLAY - HE FOR THE INDEX';
    }
    if (entry === 'HE/') {
      // Help on the last FORMAT-rejected entry. Infer the topic by
      // the longest topic key the failed entry starts with.
      const failed = wa.lastFailedEntry;
      if (!failed) return 'NO FAILED ENTRY - HE FOR THE INDEX';
      let best: string | undefined;
      for (const t of AMADEUS_HELP_TOPICS) {
        for (const k of t.keys) {
          if (failed.toUpperCase().startsWith(k) && (best == null || k.length > best.length)) {
            best = k;
          }
        }
      }
      const screen = renderAmadeusHelp(best); // undefined → index
      wa.lastHelpScreen = screen;
      return `LAST ENTRY: ${failed}\n${screen}`;
    }
    const heMatch = /^HE\s?([A-Z0-9/ .]{1,20})$/.exec(entry);
    if (heMatch) {
      const topic = heMatch[1].trim();
      let screen: string;
      if (topic === 'MARKETS') {
        // Live from the inventory — see the Galileo help twin.
        screen = ctx.backend.inventory.marketsSummary().join('\n');
        wa.lastHelpScreen = screen;
        return screen;
      }
      if (topic === 'STORE') {
        screen = renderStoreStatus(ctx.backend);
        wa.lastHelpScreen = screen;
        return screen;
      }
      if (topic === 'HE' || topic === 'HELP') {
        screen = renderAmadeusHelpOnHelp();
      } else if (topic === 'STEPS') {
        screen = renderAmadeusSteps();
      } else {
        screen = renderAmadeusHelp(topic);
      }
      wa.lastHelpScreen = screen;
      return screen;
    }

    // Sign-in family — QRG p.9 verbatim forms (the multi-area set
    // was previously parsed-and-ignored):
    //   JI2345XY/GS           first available (active) area
    //   JIA2345XY/GS          a specific area
    //   JIA/B/C2345XY/GS      multiple areas
    //   JI*2345XY/GS          all six areas
    if (entry.startsWith('JI')) {
      const rest = entry.slice(2);
      const m = /^(\*|[A-F](?:\/[A-F])*)?(\d.*)$/.exec(rest);
      if (!m) return FORMAT_ERROR;
      const parsed = parseSignInArgument(m[2]);
      if (!parsed) return FORMAT_ERROR;
      const letters = m[1] === '*'
        ? wa.allAreaLetters()
        : m[1]
          ? m[1].split('/')
          : [wa.area];
      for (const l of letters) {
        const slot = wa.slot(l);
        if (!slot) return FORMAT_ERROR;
        try { slot.machine.transition(SessionEvent.SIGN_IN); } catch { /* already in */ }
      }
      wa.switchTo(letters[0]);
      wa.agent = parsed.agent;
      return `${parsed.agent} SIGNED IN${m[1] ? ` - AREA${letters.length > 1 ? 'S' : ''} ${letters.join('/')}` : ''}`;
    }

    // Area movement family (QRG p.9):
    //   JM<letter>   move to a specific work area
    //   JM<agent>    move by agent sign (one shared sign here —
    //                resolves to the first signed-in area)
    //   JX<letter>   sign IN to another area (extends the session's
    //                sign-on, no credential re-entry)
    //   JB           redisplay the sign-in message
    //   JS           suspend the work area temporarily
    const jmMatch = /^JM([A-F]|[A-Z]{2})$/.exec(entry);
    if (jmMatch) {
      if (!wa.agent) return NEED_AGENT_SIGN;
      if (jmMatch[1].length === 1) {
        if (!wa.switchTo(jmMatch[1])) return FORMAT_ERROR;
      } else {
        if (jmMatch[1] !== wa.agent) return 'AGENT SIGN NOT FOUND';
        const signed = wa.allAreaLetters().find((l) => wa.slot(l)!.machine.getState() !== 'SIGNED_OFF');
        if (!signed) return 'AGENT SIGN NOT FOUND';
        wa.switchTo(signed);
      }
      return `WORK AREA ${wa.area}`;
    }
    const jxMatch = /^JX([A-F])$/.exec(entry);
    if (jxMatch) {
      if (!wa.agent) return NEED_AGENT_SIGN;
      if (!wa.switchTo(jxMatch[1])) return FORMAT_ERROR;
      try { wa.machine.transition(SessionEvent.SIGN_IN); } catch { /* already in */ }
      return `${wa.agent} SIGNED IN - AREA ${wa.area}`;
    }
    if (entry === 'JB') {
      if (!wa.agent) return NEED_AGENT_SIGN;
      return `${wa.agent} SIGNED IN - AREA ${wa.area}`;
    }
    if (entry === 'JS') {
      if (!wa.agent) return NEED_AGENT_SIGN;
      return `WORK AREA ${wa.area} SUSPENDED`; // reconstructed acknowledge
    }
    // Sign-out family (QRG p.9): JO active area · JOB/C/D selected
    // areas · JO* all areas.
    const joMatch = /^JO(\*|[A-F](?:\/[A-F])*)?$/.exec(entry);
    if (joMatch) {
      if (!wa.agent) return NEED_AGENT_SIGN;
      const agent = wa.agent;
      const letters = joMatch[1] === '*'
        ? wa.allAreaLetters()
        : joMatch[1]
          ? joMatch[1].split('/')
          : [wa.area];
      for (const l of letters) {
        const slot = wa.slot(l);
        if (!slot) return FORMAT_ERROR;
        try { slot.machine.transition(SessionEvent.SIGN_OFF); } catch { /* not signed in */ }
        slot.reset();
      }
      const allOut = wa.allAreaLetters().every((l) => wa.slot(l)!.machine.getState() === 'SIGNED_OFF');
      if (allOut) wa.agent = undefined;
      return `${agent} SIGNED OUT${joMatch[1] ? ` - AREA${letters.length > 1 ? 'S' : ''} ${letters.join('/')}` : ''}`;
    }
    if (entry === 'JD') {
      if (!wa.agent) return NEED_AGENT_SIGN;
      // Real per-area status (was a hardcoded single A row).
      return renderAreaStatus(wa);
    }

    // --- v2: PNR build cycle ---
    // All v2 verbs require an active sign-in (Amadeus QRG semantics).
    // The check is per-AREA: the agent sign is session-level, but a
    // JM into an unsigned area must demand JX/JI before selling.
    if (!wa.agent || wa.state() === 'SIGNED_OFF') return NEED_AGENT_SIGN;

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
      // The air display replaces any rail display on screen — SS now
      // sells air again (v6 rail arc).
      wa.lastRailAvail = undefined;
      // Availability is a read-side operation; no state-machine event.
      return renderAmadeusAn(avail, lines);
    }

    // --- polish: passive + ghost segments (Service Hub 875906) ---
    // Short sell from availability with a passive/ghost status code:
    //   SS1Q2/PK/RECLOC   PK = confirmed passive (airline locator
    //                     required — "include the record locator")
    //   SS1Q2/PL/RECLOC   PL = waitlisted passive
    //   SS1Y1/GK          GK = ghost segment (price-only, no message
    //                     to the airline, no locator)
    // Long sell when the flight is known:
    //   SS UA 1316 Q 12APR EWRMIA PK1/11201428/RECLOC
    // Passive/ghost statuses never flip to HK at commit (only SS
    // does), and the RT display shows the airline locator where
    // active segments show *1A/E* — both per the published response.
    const passiveShort = /^SS(\d{1,2})([A-Z])(\d{1,2})\/(PK|PL|GK)(?:\/([A-Z0-9]{5,8}))?$/.exec(entry);
    const passiveLong = /^SS ([A-Z0-9]{2}) ?(\d{1,4}) ([A-Z]) (\d{1,2}[A-Z]{3}) ([A-Z]{3})([A-Z]{3}) (PK|PL|GK)(\d)(?:\/(\d{8}))?(?:\/([A-Z0-9]{5,8}))?$/.exec(entry);
    if (passiveShort || passiveLong) {
      let seg: import('../../models/segment.js').AirSegment;
      if (passiveShort) {
        const avail = wa.lastAvailability;
        if (!avail) return NO_AVAIL;
        const line = avail.lines[parseInt(passiveShort[3], 10) - 1];
        if (!line) return NO_AVAIL;
        const status = passiveShort[4];
        if (status !== 'GK' && !passiveShort[5]) return 'RECORD LOCATOR REQUIRED';
        seg = {
          segmentNumber: wa.pnr.segments.length + wa.pnr.hotelSegments.length +
            wa.pnr.carSegments.length + wa.pnr.railSegments.length +
            wa.pnr.svcSegments.length + 1,
          carrier: line.carrier, flightNumber: line.flightNumber,
          bookingClass: passiveShort[2], date: avail.date,
          dayOfWeek: '?', dayOfWeekNum: 0,
          origin: line.origin, destination: line.destination,
          status, seats: parseInt(passiveShort[1], 10),
          departTime: line.departTime, arriveTime: line.arriveTime,
          airlineLocator: passiveShort[5],
        };
      } else {
        const m2 = passiveLong!;
        const status = m2[7];
        if (status !== 'GK' && !m2[10]) return 'RECORD LOCATOR REQUIRED';
        // Optional /HHMMHHMM times ("only enter flight times if they
        // are different from those stored in Amadeus").
        const dep = m2[9] ? `${m2[9].slice(0, 4)}` : '';
        const arr = m2[9] ? `${m2[9].slice(4)}` : '';
        seg = {
          segmentNumber: wa.pnr.segments.length + wa.pnr.hotelSegments.length +
            wa.pnr.carSegments.length + wa.pnr.railSegments.length +
            wa.pnr.svcSegments.length + 1,
          carrier: m2[1], flightNumber: m2[2], bookingClass: m2[3],
          date: m2[4], dayOfWeek: '?', dayOfWeekNum: 0,
          origin: m2[5], destination: m2[6],
          status, seats: parseInt(m2[8], 10),
          departTime: dep ? `${parseInt(dep.slice(0, 2), 10) % 12 || 12}${dep.slice(2)}${parseInt(dep.slice(0, 2), 10) >= 12 ? 'P' : 'A'}` : '',
          arriveTime: arr ? `${parseInt(arr.slice(0, 2), 10) % 12 || 12}${arr.slice(2)}${parseInt(arr.slice(0, 2), 10) >= 12 ? 'P' : 'A'}` : '',
          airlineLocator: m2[10],
        };
      }
      wa.pnr.segments.push(seg);
      recordHistory(wa.pnr, `SELL ${seg.status} ${seg.carrier}${seg.flightNumber}`);
      try { wa.machine.transition(SessionEvent.SELL); } catch { /* */ }
      return ` ${seg.segmentNumber}. ${seg.carrier} ${seg.flightNumber} ${seg.bookingClass} ${seg.date} ${seg.origin} ${seg.destination} ${seg.status}${seg.seats}${seg.airlineLocator ? ' ' + seg.airlineLocator : ''}`;
    }

    // GGPCA<cxr> — Participating Carrier Access page. Layout VERBATIM
    // from 875906's UA sample; the per-carrier flag VALUES for our
    // seeded carriers are reconstructed (all standard-access).
    const ggpcaMatch = /^GGPCA([A-Z0-9]{2})$/.exec(entry);
    if (ggpcaMatch) {
      const cxr = ggpcaMatch[1];
      return [
        'PARTICIPATING CARRIER ACCESS AND FUNCTION LEVEL',
        `${cxr}  -  CARRIER ${cxr}`,
        '',
        '     ACCESS INDICATOR :  /       RECORD LOCATOR RETURN :  ALL',
        '      STANDARD ACCESS :          BOOKING RANGE IN DAYS :  336',
        '  AMADEUS ACCESS SELL :  YES      INTERACTIVE SEAT MAP :  YES',
        '',
        ' PASSIVE SEGMENT: Y      PASSIVE NOTIFY: Y         PNR CLAIM: Y',
        ' SERVICE SEGMENT: Y      DELETE SEGMENT: Y        TICKETLESS:',
      ].join('\n');
    }

    if (entry.startsWith('SS')) {
      const sell = parseSell(entry.slice(2));
      if (!sell) return FORMAT_ERROR;
      // v6 rail arc: when a rail availability display is on screen
      // (R/AD or R/AN ran more recently than any air AN), SS sells
      // from it — matching real Amadeus, where the sell always
      // references the displayed availability. QRG p.115 "SEGMENT
      // SELL FROM AVAILABILITY: Sell seat (short sell) SS1F21".
      if (wa.lastRailAvail) {
        const rail = wa.lastRailAvail;
        const svc = rail.services[sell.line - 1];
        if (!svc) return NO_AVAIL;
        if ((svc.classSeats[sell.bookingClass] ?? 0) < sell.seats) return 'CLASS NOT AVAILABLE';
        const seg: import('../../models/rail.js').RailSegment = {
          segmentNumber: wa.pnr.segments.length + wa.pnr.hotelSegments.length +
            wa.pnr.carSegments.length + wa.pnr.railSegments.length + 1,
          provider: svc.provider,
          providerName: RAIL_PROVIDER_NAMES[svc.provider] ?? svc.provider,
          trainNumber: svc.trainNumber,
          bookingClass: sell.bookingClass,
          date: rail.date,
          origin: svc.origin,
          destination: svc.destination,
          departTime: svc.departTime,
          arriveTime: svc.arriveTime,
          seats: sell.seats,
          status: 'SS',
          confirmationNumber: `RC${hotelConfirmationFor(svc.provider, svc.trainNumber, wa.pnr.railSegments.length)}`,
        };
        wa.pnr.railSegments.push(seg);
        recordHistory(wa.pnr, `SELL TRN ${svc.provider}${svc.trainNumber}${sell.bookingClass}/${rail.date}`);
        try { wa.machine.transition(SessionEvent.SELL); } catch { /* */ }
        return ` ${seg.segmentNumber}. TRN ${seg.provider} ${seg.trainNumber} ${seg.bookingClass} ${seg.date} ${seg.origin} ${seg.destination} SS${seg.seats}`;
      }
      const avail = wa.lastAvailability;
      if (!avail) return NO_AVAIL;
      const line = avail.lines[sell.line - 1];
      if (!line) return NO_AVAIL;
      const remaining = ctx.backend.inventory.sell(avail.date, line.carrier, line.flightNumber, sell.bookingClass, sell.seats);
      if (!remaining) return 'CLASS NOT AVAILABLE';
      const segment: AirSegment = {
        segmentNumber: wa.pnr.segments.length + wa.pnr.hotelSegments.length +
          wa.pnr.carSegments.length + wa.pnr.railSegments.length + 1,
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
      // End-transaction confirms sold segments: SS -> HK. Every
      // committed PNR in the Service Hub samples (453392470 etc.)
      // shows HK status; SS only appears pre-commit.
      for (const sgm of pnr.segments) {
        if (sgm.status === StatusCode.SS) sgm.status = StatusCode.HK;
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
    // `DMLGW-LHR` (inter-airport pair).
    //
    // Chunk 26 upgraded the single MIN_CONNECT_MINUTES constant to a
    // layered MCT model following OAG's documented hierarchy (airport
    // default → carrier exception → carrier-pair re-override; see
    // src/models/mct.ts + docs/behavior-layer-research-2026-06-09.md).
    // Seeded airports show their per-connection-type standards +
    // carrier exceptions; unseeded airports fall back to the global
    // 45-minute default that the auto-connect builder uses.
    //
    // DMI — Check MCT and segment continuity in the current PNR.
    // Resolves each connection's MCT through the same layered model,
    // using the arriving + departing carriers so carrier exceptions
    // surface in the continuity check.
    if (entry === 'DMI') {
      if (wa.pnr.segments.length < 2) return 'NO CONNECTIONS TO CHECK';
      const checks: string[] = [];
      for (let i = 0; i < wa.pnr.segments.length - 1; i++) {
        const a = wa.pnr.segments[i];
        const b = wa.pnr.segments[i + 1];
        if (a.destination === b.origin) {
          // Chunk 28: connection type inferred from leg countries
          // (D when origin + destination share a country, else I) —
          // so a JFK→ORD then ORD→FRA connection resolves the DI
          // standard at ORD, not the DD one.
          const type = connectionTypeFor(a, b);
          const mct = ctx.backend.inventory.mctFor(a.destination, type, a.carrier, b.carrier);
          const sourceTag = mct.source === 'fallback' ? '' : ` (${mct.source.toUpperCase()})`;
          checks.push(`  ${i + 1}-${i + 2}: ${a.destination} ${type} OK / MCT ${mct.minutes}M${sourceTag}`);
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
      const records = ctx.backend.inventory.mctRecordsFor(airport);
      if (records.length === 0) {
        // Unseeded airport — global default, same wording as before
        // chunk 26 so existing operator muscle-memory holds.
        return `DM ${route}${dateTail}\n  MCT ${MIN_CONNECT_MINUTES} MIN`;
      }
      const lines = [`DM ${route}${dateTail}`];
      // Airport standards first, then carrier exceptions, then pair
      // re-overrides — mirrors the OAG layering order.
      const standards = records.filter((r) => !r.carrier);
      const carrierExc = records.filter((r) => r.carrier && !r.toCarrier);
      const pairExc = records.filter((r) => r.carrier && r.toCarrier);
      for (const r of standards) {
        lines.push(`  ${r.connectionType}  STANDARD            ${r.minutes} MIN`);
      }
      for (const r of carrierExc) {
        lines.push(`  ${r.connectionType}  ${r.carrier} TO ALL           ${r.minutes} MIN`);
      }
      for (const r of pairExc) {
        const val = r.minutes === 9999 ? 'STANDARD APPLIES' : `${r.minutes} MIN`;
        lines.push(`  ${r.connectionType}  ${r.carrier} TO ${r.toCarrier}            ${val}`);
      }
      return lines.join('\n');
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
      const hasItin = wa.pnr.segments.length > 0 || wa.pnr.hotelSegments.length > 0 ||
        wa.pnr.carSegments.length > 0 || wa.pnr.railSegments.length > 0;
      if (!hasItin) return NO_ITINERARY;
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
      if (wa.pnr.segments.length === 0 && wa.pnr.railSegments.length === 0) return NO_ITINERARY;
      const toCancel = new Set(segs);
      const kept: AirSegment[] = [];
      for (const seg of wa.pnr.segments) {
        if (toCancel.has(seg.segmentNumber)) {
          ctx.backend.inventory.release(seg.date, seg.carrier, seg.flightNumber, seg.bookingClass, seg.seats);
        } else {
          kept.push(seg);
        }
      }
      // Rail segments cancel via the same XE element cancel (the QRG
      // rail chapter documents no rail-specific cancel verb).
      wa.pnr.railSegments = wa.pnr.railSegments.filter((r) => !toCancel.has(r.segmentNumber));
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

    // ERK — accept ALL advice codes at once (Service Hub 938974,
    // verbatim semantics: "changes the advice codes in Air, Hotel,
    // Car, Auxiliary segments, and in any SSR element. Inactive
    // advice codes (NO, UN, HX and UC) are automatically transferred
    // to the history of the PNR" — the sample shows KL1→HK1 and the
    // UC1 SSR removed). Response: the updated PNR display.
    if (entry === 'ERK') {
      const INACTIVE = new Set(['NO', 'UN', 'HX', 'UC']);
      const ADVICE_TO_HK = new Set(['KK', 'KL', 'TK', 'TL', 'US']);
      let touched = 0;
      const allSegs: { status: string }[] = [
        ...wa.pnr.segments, ...wa.pnr.hotelSegments,
        ...wa.pnr.carSegments, ...wa.pnr.railSegments, ...wa.pnr.svcSegments,
      ];
      for (const seg of allSegs) {
        if (ADVICE_TO_HK.has(seg.status)) { seg.status = 'HK'; touched++; }
      }
      wa.pnr.segments = wa.pnr.segments.filter((seg) => {
        if (INACTIVE.has(seg.status)) {
          recordHistory(wa.pnr, `ERK PURGE ${seg.carrier}${seg.flightNumber} ${seg.status}`);
          touched++;
          return false;
        }
        return true;
      });
      wa.pnr.ssrs = wa.pnr.ssrs.filter((ssr) => {
        if (ADVICE_TO_HK.has(ssr.status)) { ssr.status = 'HK'; touched++; return true; }
        if (INACTIVE.has(ssr.status)) {
          recordHistory(wa.pnr, `ERK PURGE SSR ${ssr.code} ${ssr.status}`);
          touched++;
          return false;
        }
        return true;
      });
      if (touched === 0) return 'NO ADVICE CODES TO ACCEPT';
      recordHistory(wa.pnr, `ERK ${touched} ADVICE CODE(S) ACCEPTED`);
      try { wa.machine.transition(SessionEvent.MODIFY); } catch { /* */ }
      return renderAmadeusPnr(wa.pnr, ctx.pcc, wa.agent);
    }

    // <n>/RR — reconfirm ("You can only use this entry for segments
    // with a confirmed status code", 938974).
    const rrMatch = /^([1-9]\d?)\/RR$/.exec(entry);
    if (rrMatch) {
      const seg = wa.pnr.segments.find((x) => x.segmentNumber === parseInt(rrMatch[1], 10));
      if (!seg) return 'SEGMENT NOT IN ITINERARY';
      if (seg.status !== 'HK') return 'SEGMENT NOT CONFIRMED';
      seg.status = 'RR';
      recordHistory(wa.pnr, `RECONFIRM ${seg.carrier}${seg.flightNumber}`);
      return renderAmadeusItinerary(wa.pnr);
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
    // SR<code>-<freetext>[/S<n>][/P<n>] — the 823571 verbatim form:
    //   SRXBAG-PDBG-10KGS-60x80x50/S2/P1
    // → SSR XBAG AF HK1 PDBG-10KGS-60X80X50/S2 (text uppercased,
    // segment suffix kept on the text; carrier defaults to the
    // first air segment's).
    const srFree = /^SR([A-Z]{4})-([^/]+)(\/S\d{1,2})?(?:\/P(\d{1,2}))?$/.exec(entry);
    if (srFree) {
      wa.pnr.ssrs.push({
        code: srFree[1],
        carrier: wa.pnr.segments[0]?.carrier ?? 'YY',
        text: `${srFree[2].toUpperCase()}${srFree[3] ?? ''}`,
        nameRef: srFree[4] ? { item: parseInt(srFree[4], 10) } : undefined,
        status: 'NN',
      });
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }

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
      // 906462 post-issuance rule (verbatim rule, reconstructed
      // wording): "you cannot change the name element" once an
      // e-ticket exists.
      if (wa.pnr.tickets.length > 0) return 'NAME CHANGE NOT ALLOWED - TICKET ISSUED';
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

    // --- v4 chunk 25: FF accrual / redemption / upgrade / display ---
    // Per Amadeus Service Hub solution 862136 (verbatim extracted
    // 2026-06-09 via Playwright Cloudflare bypass; see
    // docs/behavior-layer-research-2026-06-09.md for the dig). Three
    // verbs all create SSR elements with FQT* codes; the fourth
    // displays them.
    //
    //   FFA<carrier>-<number>                    accrual → SSR FQTV
    //   FFA<carrier>-<number>, <c2>, <c3>...     multi-airline accrual
    //   FFR<carrier>-<number>                    redemption → SSR FQTR
    //   FFR<carrier>-<number>-CARDHOLDER <sur>/<gn>  cross-cardholder redemption
    //   FFU<carrier>-<number>                    upgrade → SSR FQTU
    //   FFD                                       display FF SSRs from PNR
    //
    // Response format (verbatim from Service Hub sample):
    //   RP/XXXXXXXXX/
    //     1.VIRTA/VILLE MR
    //     2 *SSR FQTV YY HK/ AY608479929/4
    //
    // When the FF program has agreements with other carriers, the SSR
    // airline code is `YY` (industry default) and end-of-transaction
    // fans out one SSR per agreement carrier. When no agreements, the
    // SSR airline code is the card-owning carrier.
    const ffaMatch = /^FFA([A-Z0-9]{2})-([A-Z0-9]+)((?:,\s*[A-Z]{2})*)$/.exec(entry);
    if (ffaMatch) {
      if (wa.pnr.segments.length === 0) return NO_ITINERARY;
      const ownerCarrier = ffaMatch[1];
      const number = ffaMatch[2];
      const extraCarriers = (ffaMatch[3] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      // Per Service Hub: if multi-airline OR the program has FF
      // agreements, SSR airline code is YY; else owner carrier.
      const hasAgreements = extraCarriers.length > 0 || (ownerCarrier in VFFD_PROGRAMS);
      const ssrAirline = hasAgreements ? 'YY' : ownerCarrier;
      wa.pnr.ssrs.push({
        code: 'FQTV',
        carrier: ssrAirline,
        text: `${ownerCarrier}${number}`,
        status: 'HK',
      });
      // Also record on frequentFlyers so VFFD/FFD see it consistently.
      wa.pnr.frequentFlyers.push({
        carrier: ownerCarrier,
        number,
      });
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }

    const ffrMatch = /^FFR([A-Z0-9]{2})-([A-Z0-9]+)(?:-CARDHOLDER\s+(.+))?$/.exec(entry);
    if (ffrMatch) {
      if (wa.pnr.segments.length === 0) return NO_ITINERARY;
      if (wa.pnr.names.length === 0) return 'NEEDS NAME';
      const carrier = ffrMatch[1];
      const number = ffrMatch[2];
      const cardholder = ffrMatch[3];
      wa.pnr.ssrs.push({
        code: 'FQTR',
        carrier,
        text: cardholder ? `${carrier}${number} CARDHOLDER ${cardholder}` : `${carrier}${number}`,
        status: 'HK',
      });
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }

    const ffuMatch = /^FFU([A-Z0-9]{2})-([A-Z0-9]+)$/.exec(entry);
    if (ffuMatch) {
      if (wa.pnr.segments.length === 0) return NO_ITINERARY;
      if (wa.pnr.names.length === 0) return 'NEEDS NAME';
      wa.pnr.ssrs.push({
        code: 'FQTU',
        carrier: ffuMatch[1],
        text: `${ffuMatch[1]}${ffuMatch[2]}`,
        status: 'HK',
      });
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
      return 'OK';
    }

    if (entry === 'FFD') {
      const ffSsrs = wa.pnr.ssrs.filter((s) => /^FQT[VRU]$/.test(s.code));
      if (ffSsrs.length === 0) return 'NO FREQUENT FLYER DATA';
      const lines = ['FF DISPLAY'];
      ffSsrs.forEach((s, i) => {
        lines.push(`  ${i + 1} *SSR ${s.code} ${s.carrier} ${s.status}/ ${s.text ?? ''}`.trimEnd());
      });
      return lines.join('\n');
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
    // TTP/TTM — tickets + EMDs in one entry ("the TTP entry always
    // comes first", solution 797696). Issue tickets via the normal
    // TTP path, then chain a TTM for the chargeable SSRs.
    if (entry === 'TTP/TTM' || entry.startsWith('TTP/TTM/')) {
      const ttp = this.dispatchEntry(entry.includes('/RT') ? 'TTP' : 'TTP', wa, ctx);
      if (ttp !== 'OK ETKT' && !ttp.startsWith('OK ETKT')) return ttp;
      const ttm = this.dispatchEntry(entry.includes('/RT') ? 'TTM/RT' : 'TTM', wa, ctx);
      return `${ttp}\n${ttm}`;
    }

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

    // --- chunk 31.2: EMD issuance (TTM) + record display (EWD) ---
    // Entry forms verbatim from the QRG (p.172 issuance, p.214
    // displays) + Service Hub solutions 797696 ("How to issue an
    // EMD") and 873296 ("How to display an EMD record"):
    //   TTM[/P<n>][/L<n>][/INF][/RT]   issue EMDs for chargeable
    //                                  SSRs (code present in the
    //                                  carrier's EMD guide)
    //   TTP/TTM                        tickets + EMDs together (TTP
    //                                  always first, per the solution)
    //   EWD / EWD/L<n> / EWD/<n>       record display / by FA element
    //                                  / from list
    //   EWD/EMD<3num>-<10num>          by document number
    //   EWDRL / EWDRT                  redisplay list / record
    // The EMD list screen is verbatim (873296); the record screen is
    // reconstructed on the TWD pattern (no published sample), flagged.
    // --- polish: ticketing/EMD interline agreements (TGAD) ---
    // Forms + screen VERBATIM from Service Hub solution 2318986.
    // BA's table is the published data; other carriers fall back to
    // a reconstructed all-TPED grid over our seeded carriers.
    const tgadMatch = /^TGAD-([A-Z0-9]{2})(?:\/([A-Z0-9]{2}))?$/.exec(entry);
    if (tgadMatch) {
      const rows = TGAD_AGREEMENTS[tgadMatch[1]] ??
        ['AA', 'AF', 'B6', 'BA', 'DL', 'FI', 'LH', 'UA', '6X'].filter((c) => c !== tgadMatch[1]).map((c) => [c, 'TPED'] as [string, string]);
      if (tgadMatch[2]) {
        const pair = rows.find(([c]) => c === tgadMatch[2]);
        if (!pair) return 'NO AGREEMENT';
        // Pair display spaces the flag letters (verbatim: IB  T P E D).
        return `--AIRLINES HAVING AGREEMENT WITH: ${tgadMatch[1]}\n${pair[0]}  ${pair[1].split('').join(' ')}`;
      }
      // Verbatim cell join: flags padded to 4, ' - ' separator.
      const cells = rows.map(([c, f]) => `${c}  ${f.padEnd(4)}`);
      const lines: string[] = [`--AIRLINES HAVING AGREEMENT WITH: ${tgadMatch[1]}`];
      for (let i = 0; i < cells.length; i += 4) {
        lines.push(cells.slice(i, i + 4).join(' - ').trimEnd());
      }
      return lines.join('\n');
    }

    // --- polish: TSM-P flow (TMC create / TQM index / TTM/M issue) ---
    // TMC mask layout VERBATIM from solution 823571; TQM wording
    // reconstructed (the QRG documents the entry, not the screen).
    const tmcMatch = /^TMC\/V([A-Z0-9]{2})\/L(\d{1,2})$/.exec(entry);
    if (tmcMatch) {
      const charge = chargeableSsrs(wa.pnr, ctx).filter((c) => c.service.carrier === tmcMatch[1]);
      const item = charge[parseInt(tmcMatch[2], 10) - 1];
      if (!item) return 'INVALID LINE';
      const paxName = `${wa.pnr.names[0]?.surname ?? ''}/${wa.pnr.names[0]?.passengers[0]?.firstName ?? ''}`;
      const tsm: import('../../models/emd.js').TsmRecord = {
        number: wa.pnr.tsms.length + 1,
        carrier: item.service.carrier,
        code: item.service.code,
        rfic: item.service.rfic,
        rfisc: item.service.rfisc,
        description: item.service.description.toUpperCase(),
        elementRef: item.index,
        origin: wa.pnr.segments[0]?.origin,
        destination: wa.pnr.segments[0]?.destination,
        passenger: paxName,
        issued: false,
      };
      wa.pnr.tsms.push(tsm);
      return renderAmadeusTsmMask(tsm, ctx.pcc, wa.agent);
    }
    if (entry === 'TQM') {
      if (wa.pnr.tsms.length === 0) return 'NO TSM RECORD';
      return ['TSM INDEX', ...wa.pnr.tsms.map((t) =>
        ` ${t.number}  TYPE P  ${t.carrier} ${t.code} ${t.rfic}/${t.rfisc}  ${t.issued ? 'ISSUED' : 'OPEN'}`,
      )].join('\n');
    }

    if (entry === 'TTM' || entry.startsWith('TTM/')) {
      if (wa.pnr.names.length === 0) return 'NEEDS NAME';
      // TTM/M<n>[-<m>,…] — issue specific TSM-Ps (QRG p.172; the TSM
      // number comes from the TQM index).
      const mSel = /^TTM\/M([\d,-]+)/.exec(entry);
      if (mSel) {
        const nums = expandSelection(mSel[1]);
        const targets = wa.pnr.tsms.filter((t) => nums.includes(t.number) && !t.issued);
        if (targets.length === 0) return 'NO TSM RECORD';
        const issuedRecs: import('../../models/emd.js').EmdRecord[] = [];
        for (const t of targets) {
          const svcRow = ctx.backend.inventory.emdServicesFor(t.carrier).find((e2) => e2.code === t.code);
          const tn = ticketNumber(t.carrier, ctx.backend.nextTicketSerial());
          issuedRecs.push({
            number: `${tn.slice(0, 3)}-${tn.slice(3)}`,
            carrier: t.carrier, serviceCode: t.code, rfic: t.rfic, rfisc: t.rfisc,
            emdType: 'A', passenger: t.passenger, elementRef: t.elementRef,
            amount: svcRow?.amount ?? 0, currency: svcRow?.currency ?? '',
            status: 'OPEN', issuedAt: new Date(), pcc: ctx.pcc,
            history: [{ coupon: 1, rfisc: t.rfisc, status: 'O', office: ctx.pcc, sign: wa.agent ?? 'GS', at: new Date() }],
          });
          t.issued = true;
        }
        wa.pnr.emds.push(...issuedRecs);
        recordHistory(wa.pnr, `TTM/M ${issuedRecs.length} EMD(S) ISSUED`);
        const ok = ['OK EMD', ...issuedRecs.map((e) => `  ${e.number} ${e.serviceCode} ${e.rfic}/${e.rfisc} ${e.currency}${e.amount.toFixed(2)}`)].join('\n');
        return entry.includes('/RT') ? `${ok}\n${renderAmadeusPnr(wa.pnr, ctx.pcc, wa.agent)}` : ok;
      }
      const charge = chargeableSsrs(wa.pnr, ctx);
      // SVC segments issue too — booking method SVC rows of the
      // carrier's EMD guide (QRG: "Issue the EMDs for all SSR
      // elements/SVC segments"). This is what makes the LH CANC/
      // DPST/PENF guide rows sellable end-to-end.
      wa.pnr.svcSegments.forEach((svc, i) => {
        const svcService = ctx.backend.inventory.emdServicesFor(svc.carrier)
          .find((e2) => e2.code === svc.code && e2.bookingMethod === 'SVC');
        if (svcService && svcService.taIssuable) {
          charge.push({
            ssr: { code: svc.code, carrier: svc.carrier, status: 'HK' },
            service: { ...svcService, detail: { ...(svcService.detail ?? {}), emdType: 'S' } },
            index: 100 + i, // distinct elementRef space from SSRs
          });
        }
      });
      if (charge.length === 0) return 'NO CHARGEABLE SERVICES';
      let selected = charge;
      const lMatch = /\/L(\d+)(?:-(\d+))?/.exec(entry);
      if (lMatch) {
        // /L<n> selects by chargeable-element position. APPROXIMATION:
        // real Amadeus uses the PNR display line number of the SSR
        // element; we don't track display line numbers, so n indexes
        // the chargeable-SSR list. Flagged.
        const lo = parseInt(lMatch[1], 10);
        const hi = lMatch[2] ? parseInt(lMatch[2], 10) : lo;
        selected = charge.slice(lo - 1, hi);
        if (selected.length === 0) return 'INVALID LINE';
      }
      const pMatch = /\/P(\d+)/.exec(entry);
      if (pMatch) {
        const pax = parseInt(pMatch[1], 10);
        selected = selected.filter((c) => !c.ssr.nameRef || c.ssr.nameRef.item === pax);
        if (selected.length === 0) return 'NO CHARGEABLE SERVICES FOR PASSENGER';
      }
      if (entry.includes('/INF')) {
        selected = selected.filter((c) => c.ssr.code === 'INFT');
        if (selected.length === 0) return 'NO INFANT SERVICES';
      }
      const already = new Set(wa.pnr.emds.map((e) => `${e.serviceCode}|${e.elementRef}`));
      const fresh = selected.filter((c) => !already.has(`${c.service.code}|${c.index}`));
      if (fresh.length === 0) return 'EMD ALREADY ISSUED';
      const issued: import('../../models/emd.js').EmdRecord[] = [];
      const paxName = `${wa.pnr.names[0].surname}/${wa.pnr.names[0].passengers[0]?.firstName ?? ''}`;
      for (const c of fresh) {
        // EMD numbers render with the 3-digit prefix dashed off
        // (FA-line verbatim: 057-1812899556).
        const tn = ticketNumber(c.service.carrier, ctx.backend.nextTicketSerial());
        // EMD-A: associate to the e-ticket when one exists (866006's
        // ICW line — auto-association at issuance).
        const icw = wa.pnr.tickets[0]?.number;
        issued.push({
          number: `${tn.slice(0, 3)}-${tn.slice(3)}`,
          icwTicket: icw,
          icwAssociated: icw != null,
          carrier: c.service.carrier,
          serviceCode: c.service.code,
          rfic: c.service.rfic,
          rfisc: c.service.rfisc,
          emdType: (c.service.detail?.emdType ?? 'A') as 'A' | 'S',
          passenger: paxName,
          elementRef: c.index,
          amount: c.service.amount,
          currency: c.service.currency,
          status: 'OPEN',
          issuedAt: new Date(),
          pcc: ctx.pcc,
          history: [{
            coupon: 1,
            rfisc: c.service.rfisc,
            status: 'O',
            office: ctx.pcc,
            sign: wa.agent ?? 'GS',
            at: new Date(),
          }],
        });
      }
      wa.pnr.emds.push(...issued);
      recordHistory(wa.pnr, `TTM ${issued.length} EMD(S) ISSUED`);
      // Response: "the PNR is updated with FA/FB lines" (solution
      // 797696) — TTM/RT shows the PNR; plain TTM gets an OK line
      // (reconstructed, mirroring the TTP renderer).
      const ok = ['OK EMD', ...issued.map((e) => `  ${e.number} ${e.serviceCode} ${e.rfic}/${e.rfisc} ${e.currency}${e.amount.toFixed(2)}`)].join('\n');
      if (entry.includes('/RT')) {
        return `${ok}\n${renderAmadeusPnr(wa.pnr, ctx.pcc, wa.agent)}`;
      }
      return ok;
    }

    // EWA/ASC — re-associate an EMD to a ticket (866006 verbatim:
    //   EWA/ASC/E1-2/TKT057-5417737101/E1-2
    //   → AF EMD:  OK EMD RECORD UPDATED).
    // Operates on the displayed EMD record (the solution's flow is
    // EWD → check ICW (D) → EWA). The disassociation code isn't
    // shown in the published page — only ASC is implemented.
    const ewaMatch = /^EWA\/ASC\/E[\d-]+\/TKT(\d{3})-(\d{10})\/E[\d-]+$/.exec(entry);
    if (ewaMatch) {
      const idx = wa.lastEmdIndex;
      if (idx == null || !wa.pnr.emds[idx]) return 'NO EMD RECORD DISPLAYED';
      const rec = wa.pnr.emds[idx];
      rec.icwTicket = `${ewaMatch[1]}${ewaMatch[2]}`;
      rec.icwAssociated = true;
      return `${rec.carrier} EMD:  OK EMD RECORD UPDATED`;
    }

    if (entry === 'EWD' || entry.startsWith('EWD/') || entry === 'EWDRL' || entry === 'EWDRT') {
      if (wa.pnr.emds.length === 0) return 'NO EMD RECORD';
      if (entry === 'EWDRL') return renderAmadeusEwdList(wa.pnr.emds);
      if (entry === 'EWDRT') {
        const idx = wa.lastEmdIndex;
        if (idx == null || !wa.pnr.emds[idx]) return 'NO EMD RECORD TO REDISPLAY';
        return renderAmadeusEwdRecord(wa.pnr.emds[idx], idx + 1);
      }
      const byNumber = /^EWD\/EMD(\d{3})-(\d{10})$/.exec(entry);
      if (byNumber) {
        const full = `${byNumber[1]}-${byNumber[2]}`;
        const idx = wa.pnr.emds.findIndex((e) => e.number === full);
        if (idx < 0) return 'NO EMD RECORD';
        wa.lastEmdIndex = idx;
        return renderAmadeusEwdRecord(wa.pnr.emds[idx], idx + 1);
      }
      // EWD/L<n> — by FA/FHD element position (insertion order);
      // EWD/<n> — by EMD-list line, which is date-sorted most recent
      // first (873296: "enter the line number of the EMD record
      // that you want to display" from the list).
      const byElement = /^EWD\/L(\d+)$/.exec(entry);
      if (byElement) {
        const idx = parseInt(byElement[1], 10) - 1;
        if (!wa.pnr.emds[idx]) return 'NO EMD RECORD';
        wa.lastEmdIndex = idx;
        return renderAmadeusEwdRecord(wa.pnr.emds[idx], idx + 1);
      }
      const byListLine = /^EWD\/(\d+)$/.exec(entry);
      if (byListLine) {
        const sorted = [...wa.pnr.emds].sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
        const rec = sorted[parseInt(byListLine[1], 10) - 1];
        if (!rec) return 'NO EMD RECORD';
        const idx = wa.pnr.emds.indexOf(rec);
        wa.lastEmdIndex = idx;
        return renderAmadeusEwdRecord(rec, parseInt(byListLine[1], 10));
      }
      // Bare EWD: one record displays directly; several show the
      // list, "sorted by issue date, from the most recent" (873296).
      if (wa.pnr.emds.length === 1) {
        wa.lastEmdIndex = 0;
        return renderAmadeusEwdRecord(wa.pnr.emds[0], 1);
      }
      return renderAmadeusEwdList(wa.pnr.emds);
    }

    // --- chunk 32: EMD history (EWH) + coupon reprint (EMR) +
    //     manual document numbers (FHD/FHP) ---
    // EWH forms + screen VERBATIM from Service Hub solution 828612;
    // EMR + FHD/FHP forms verbatim from QRG pp.169/172 (EMR response
    // wording reconstructed — not published). The TA-side EMD
    // exchange entry is unpublished (reissue solution login-gated;
    // QRG documents only airline-agent TTM/IVI / TTM/OVNE), so
    // EWD/O* old-record display stays deferred.
    if (entry === 'EWH' || entry.startsWith('EWH/')) {
      let rec: import('../../models/emd.js').EmdRecord | undefined;
      const byNumber = /^EWH\/EMD(\d{3}-\d{10})$/.exec(entry);
      if (byNumber) {
        rec = wa.pnr.emds.find((e) => e.number === byNumber[1]);
      } else if (entry === 'EWH') {
        // From the displayed EMD record (the 873296/828612 flow:
        // EWD … then EWH).
        rec = wa.lastEmdIndex != null ? wa.pnr.emds[wa.lastEmdIndex] : undefined;
      } else {
        return FORMAT_ERROR;
      }
      if (!rec) return 'NO EMD RECORD';
      if (rec.manual || !rec.history || rec.history.length === 0) return 'NO HISTORY';
      return renderAmadeusEwh(rec);
    }

    if (entry === 'EMR' || entry.startsWith('EMR/')) {
      const real = wa.pnr.emds.filter((e) => !e.manual);
      if (real.length === 0) return 'NO EMD RECORD';
      let selected = real;
      const byNumber = /^EMR\/EMD(\d{3}-\d{10})$/.exec(entry);
      const pSel = /^EMR\/P([\d,-]+)$/.exec(entry);
      const lSel = /^EMR\/L([\d,-]+)$/.exec(entry);
      if (byNumber) {
        selected = real.filter((e) => e.number === byNumber[1]);
      } else if (pSel) {
        const paxes = expandSelection(pSel[1]);
        // Passenger selection: our EMDs carry the lead passenger only;
        // P1 selects all, higher numbers select nothing (single-pax
        // approximation, flagged).
        selected = paxes.includes(1) ? real : [];
      } else if (lSel) {
        const linesSel = expandSelection(lSel[1]);
        selected = linesSel.map((n) => real[n - 1]).filter(Boolean);
      } else if (entry !== 'EMR') {
        return FORMAT_ERROR;
      }
      if (selected.length === 0) return 'NO EMD RECORD';
      // Response reconstructed (the QRG documents the entries, not
      // the reprint acknowledgement).
      return ['OK COUPON REPRINT', ...selected.map((e) => `  ${e.number} ${e.serviceCode} ACCOUNTING COUPON REPRINTED`)].join('\n');
    }

    // FHD/FHP — manually enter a document number (QRG p.169):
    //   FHD057-1234567890/E6-7   EMD number + SSR element association
    //   FHD057-1234567890/S2     + SVC/segment association
    //   FHP…/E6-7/P1             misc doc (no EMD exists) + pax assoc
    const fhMatch = /^FH([DP])(\d{3})-(\d{10})\/([ES])(\d+)(?:-(\d+))?(?:\/P(\d+))?$/.exec(entry);
    if (fhMatch) {
      if (wa.pnr.names.length === 0) return 'NEEDS NAME';
      const kind = fhMatch[1] === 'D' ? 'FHD' : 'FHP';
      const number = `${fhMatch[2]}-${fhMatch[3]}`;
      if (wa.pnr.emds.some((e) => e.number === number)) return 'DOCUMENT ALREADY ON PNR';
      const elementRef = parseInt(fhMatch[5], 10);
      const paxName = `${wa.pnr.names[0].surname}/${wa.pnr.names[0].passengers[0]?.firstName ?? ''}`;
      wa.pnr.emds.push({
        number,
        carrier: numericToCarrier(fhMatch[2]),
        serviceCode: 'MANL',
        rfic: '-',
        rfisc: '-',
        emdType: 'A',
        passenger: paxName,
        elementRef,
        amount: 0,
        currency: '',
        status: 'OPEN',
        issuedAt: new Date(),
        pcc: ctx.pcc,
        manual: kind as 'FHD' | 'FHP',
      });
      recordHistory(wa.pnr, `${kind} ${number} MANUAL DOCUMENT ADDED`);
      return 'OK';
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

    // --- chunk 36b: ancillary services catalogue (FXK) + book (FWK) ---
    // Screen + entries VERBATIM from Service Hub solution 828431:
    //   FXK            catalog for all pax + whole itinerary
    //   FXK/P1,3       passenger filter      FXK/S4-5  segment filter
    //   FWK<n>         book + price the service in catalog line n
    //   (SR <code> books too — already implemented)
    // Catalog content = the segment carrier's EMD guide rows with
    // booking method SSR (the screen's FLIGHT RELATED section). The
    // PR column (blank in the published sample) and non-flight-
    // related sections aren't modeled.
    const fxkMatch = /^FXK(?:\/P([\d,-]+))?(?:\/S([\d,-]+))?$/.exec(entry);
    if (fxkMatch) {
      if (wa.pnr.segments.length === 0) return NO_ITINERARY;
      if (wa.pnr.names.length === 0) return 'NEEDS NAME';
      const paxSel = fxkMatch[1] ? expandSelection(fxkMatch[1]) : undefined;
      const segSel = fxkMatch[2] ? expandSelection(fxkMatch[2]) : undefined;
      const paxCount = wa.pnr.names.reduce((acc, nm) => acc + nm.passengers.length, 0);
      const catalog: { carrier: string; code: string; passenger: number }[] = [];
      const rows: string[] = [];
      let cur = '';
      for (let pax = 1; pax <= paxCount; pax++) {
        if (paxSel && !paxSel.includes(pax)) continue;
        for (const sgm of wa.pnr.segments) {
          if (segSel && !segSel.includes(sgm.segmentNumber)) continue;
          for (const svc of ctx.backend.inventory.emdServicesFor(sgm.carrier)) {
            if (svc.bookingMethod !== 'SSR' || !svc.taIssuable) continue;
            catalog.push({ carrier: svc.carrier, code: svc.code, passenger: pax });
            cur = svc.currency;
            const line = String(catalog.length).padStart(3, '0');
            rows.push(
              `${line} P${pax}              ${sgm.carrier} ${sgm.origin}-${sgm.destination} ${sgm.bookingClass} ${svc.rfisc} ${svc.code} ADT SSR  ${svc.currency}${svc.amount.toFixed(0)}     OK`,
            );
            rows.push(`    ${svc.description.toUpperCase()} -`);
          }
        }
      }
      if (catalog.length === 0) return 'NO ANCILLARY SERVICES';
      wa.lastFxkCatalog = catalog;
      return [
        'FXK',
        `    PASSENGER       PR FROM-TO C SC  SRV  PTC BKM (${cur})TOTAL  AV`,
        'FLIGHT RELATED',
        ...rows,
      ].join('\n');
    }

    const fwkMatch = /^FWK(\d{1,3})$/.exec(entry);
    if (fwkMatch) {
      const cat = wa.lastFxkCatalog;
      if (!cat) return 'NO CATALOG DISPLAYED - FXK FIRST';
      const item = cat[parseInt(fwkMatch[1], 10) - 1];
      if (!item) return 'INVALID LINE';
      wa.pnr.ssrs.push({
        code: item.code,
        carrier: item.carrier,
        status: 'NN',
        nameRef: { item: item.passenger },
      });
      recordHistory(wa.pnr, `FWK ${item.code} BOOKED`);
      return ` SSR ${item.code} ${item.carrier} NN1/P${item.passenger}`;
    }

    // --- chunk 36: auxiliary service segment (IU) ---
    // Entry + PNR line VERBATIM from Service Hub solution 843687:
    //   IU 6X NN1 LOUS JFK/15APR-VIP XXX/P1
    //   -> 2 /SVC 6X HK1 LOUS JFK 15APR-VIP XXX
    // NN confirms to HK immediately (local segment, never sent to a
    // DCS). Multi-pax PNRs require the /P association (per the
    // solution). The 4-day purge rule isn't modeled (no clock).
    const iuMatch = /^IU ([A-Z0-9]{2}) NN(\d) ([A-Z]{4})(?: ([A-Z]{3}))?(?:\/(\d{1,2}[A-Z]{3}))?(?:-([^/]+))?(?:\/P(\d+))?$/.exec(entry);
    if (iuMatch) {
      if (wa.pnr.names.length === 0) return 'NEEDS NAME';
      const paxCount = wa.pnr.names.reduce((acc, nm) => acc + nm.passengers.length, 0);
      if (paxCount > 1 && !iuMatch[7]) return 'PASSENGER ASSOCIATION REQUIRED';
      const seg: import('../../models/emd.js').SvcSegment = {
        segmentNumber: wa.pnr.segments.length + wa.pnr.hotelSegments.length +
          wa.pnr.carSegments.length + wa.pnr.railSegments.length +
          wa.pnr.svcSegments.length + 1,
        carrier: iuMatch[1],
        count: parseInt(iuMatch[2], 10),
        code: iuMatch[3],
        status: 'HK',
        origin: iuMatch[4],
        date: iuMatch[5],
        text: iuMatch[6],
        passenger: iuMatch[7] ? parseInt(iuMatch[7], 10) : undefined,
      };
      wa.pnr.svcSegments.push(seg);
      recordHistory(wa.pnr, `IU SVC ${seg.carrier} ${seg.code}`);
      return ` ${seg.segmentNumber} /SVC ${seg.carrier} HK${seg.count} ${seg.code}${seg.origin ? ' ' + seg.origin : ''}${seg.date ? ' ' + seg.date : ''}${seg.text ? '-' + seg.text : ''}`;
    }

    // --- chunk 31.1: EMD service guide (EGSD) ---
    // Verbs + screen layouts VERBATIM from Amadeus Service Hub
    // solution 848456 (see docs note in ROADMAP chunk 31):
    //   EGSD/V<cxr>              list of EMD services for an airline
    //   EGSD/V<cxr>/L<n>         go to a specific line (detail)
    //   EGSD/V<cxr>/BM-<method>  filter by booking method (SSR/SVC)
    //   EGSD/V<cxr>/SC-<code>    detail by service code
    //   EGSD/V<cxr>/RFIC-<ltr>   filter by RFIC letter
    const egsdMatch = /^EGSD\/V([A-Z0-9]{2})(?:\/(L\d+|BM-[A-Z]+|SC-[A-Z0-9]{3,4}|RFIC-[A-Z]))?$/.exec(entry);
    if (egsdMatch) {
      const carrier = egsdMatch[1];
      const services = ctx.backend.inventory.emdServicesFor(carrier);
      if (services.length === 0) return 'NO EMD GUIDE FOR AIRLINE';
      const qual = egsdMatch[2];
      if (!qual) return renderEgsdList(carrier, services);
      if (qual.startsWith('L')) {
        const svc = services[parseInt(qual.slice(1), 10) - 1];
        if (!svc) return 'INVALID LINE';
        return renderEgsdDetail(svc);
      }
      if (qual.startsWith('BM-')) {
        const method = qual.slice(3);
        const filtered = services.filter((x) => x.bookingMethod === method);
        if (filtered.length === 0) return 'NO SERVICES FOR BOOKING METHOD';
        return renderEgsdList(carrier, filtered);
      }
      if (qual.startsWith('SC-')) {
        const svc = services.find((x) => x.code === qual.slice(3));
        if (!svc) return 'SERVICE CODE NOT FOUND';
        return renderEgsdDetail(svc);
      }
      // RFIC-<letter>
      const letter = qual.slice(5);
      const filtered = services.filter((x) => x.rfic === letter);
      if (filtered.length === 0) return 'NO SERVICES FOR RFIC';
      return renderEgsdList(carrier, filtered);
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

    // --- v6 rail arc: Rail Mode availability (R/AD, R/AN) ---
    // Per QRG p.114 (Amadeus Rail):
    //   R/AD 20JULWASNYP5P    availability by departure time
    //   R/AN 20JULWASNYP5P    neutral availability
    // Optional trailing time qualifier (5P / 1130A) filters to
    // services departing at/after that time. The space after AD/AN
    // is optional (the QRG prints it; operators often omit).
    //
    // The sell from this display is the standard SS<seats><class>
    // <line> (QRG p.115) — handled in the SS branch, which prefers
    // the rail display when one is on screen. Cancel is the standard
    // XE<n> element cancel (no rail-specific cancel verb in the QRG).
    const railAvailMatch = /^R\/A([DN])\s?(\d{1,2}[A-Z]{3})([A-Z]{3})([A-Z]{3})(\d{1,4}[AP])?$/.exec(entry);
    if (railAvailMatch) {
      const date = railAvailMatch[2];
      const origin = railAvailMatch[3];
      const destination = railAvailMatch[4];
      const services = ctx.backend.inventory.railBetween(origin, destination);
      if (services.length === 0) return 'NO RAIL SERVICES';
      wa.lastRailAvail = { date, origin, destination, services };
      const lines = [`R/A${railAvailMatch[1]} ${date} ${origin}${destination}`];
      services.forEach((svc, i) => {
        const classes = Object.entries(svc.classSeats)
          .map(([cls, n]) => `${cls}${n}`)
          .join(' ');
        lines.push(
          `${(i + 1).toString().padStart(2, ' ')} ${svc.provider} ${svc.trainNumber}  ${svc.origin} ${svc.destination}  ${svc.departTime.padStart(5, ' ')} ${svc.arriveTime.padStart(5, ' ')}  ${classes}`,
        );
      });
      return lines.join('\n');
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
      // End-transaction confirms sold segments: SS -> HK. Every
      // committed PNR in the Service Hub samples (453392470 etc.)
      // shows HK status; SS only appears pre-commit.
      for (const sgm of pnr.segments) {
        if (sgm.status === StatusCode.SS) sgm.status = StatusCode.HK;
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
