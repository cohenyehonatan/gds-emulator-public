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
import { fareFor, BOOKING_CLASSES } from '../../store/tariff.js';
import { MIN_CONNECT_MINUTES } from '../../store/inventory.js';

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

/** Amadeus uses 3-letter month abbreviations in cryptic dates (DDMON). */
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_LETTERS = ['S', 'M', 'T', 'W', 'Q', 'F', 'J']; // Sun-Sat (Sabre convention)

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

const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR', 'PROF']);

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

    if (entry === 'TKOK' || entry.startsWith('TKTL')) {
      // Amadeus QRG p.40-ish: TKOK = "ticket now"; TKTL<date> = "ticket
      // by date". Both satisfy the ticketing field requirement.
      wa.pnr.ticketing = entry;
      try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
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
      const locator = entry.slice(2).trim();
      if (!locator) return FORMAT_ERROR;
      const found = ctx.backend.pnrs.get(locator);
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
