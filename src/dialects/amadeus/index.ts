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
import { StatusCode } from '../../protocol/constants.js';

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

/** Parse `NM1<surname>/<given> <title>` — single-pax for v2. */
function parseName(arg: string): { surname: string; given: string; title?: string } | undefined {
  // Accept `NM1SMITH/JOHN MR` → SMITH/JOHN MR. The leading `1` is the
  // passenger sequence; v2 supports only single-pax so we just verify it.
  const m = /^1([A-Z]+)\/([A-Z]+(?:\s+[A-Z]+)*)$/.exec(arg);
  if (!m) return undefined;
  // Last word of the given-name section is the title if it matches common
  // honorifics; otherwise it's part of the first name.
  const givenParts = m[2].split(/\s+/);
  const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR', 'PROF']);
  let title: string | undefined;
  let given = m[2];
  if (givenParts.length > 1 && TITLES.has(givenParts[givenParts.length - 1])) {
    title = givenParts[givenParts.length - 1];
    given = givenParts.slice(0, -1).join(' ');
  }
  return { surname: m[1], given, title };
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
      try { wa.machine.transition(SessionEvent.SELL); } catch { /* */ }
      return ` ${segment.segmentNumber}. ${segment.carrier} ${segment.flightNumber} ${segment.bookingClass} ${segment.date} ${segment.origin} ${segment.destination} SS${segment.seats}`;
    }

    if (entry.startsWith('NM')) {
      const name = parseName(entry.slice(2));
      if (!name) return FORMAT_ERROR;
      wa.pnr.names.push({
        surname: name.surname,
        passengers: [{ firstName: name.given, title: name.title }],
        count: 1, infant: false,
      });
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

    if (entry.startsWith('RT')) {
      const locator = entry.slice(2).trim();
      if (!locator) return FORMAT_ERROR;
      const found = ctx.backend.pnrs.get(locator);
      if (!found) return PNR_NOT_FOUND;
      wa.pnr = found;
      try { wa.machine.transition(SessionEvent.RETRIEVE); } catch { /* */ }
      // Render: locator + first name + segments (one per line). Amadeus
      // uses `RP/<office>/<agent>` headers; we use a simplified form.
      const lines: string[] = [`RP/${ctx.pcc}/${wa.agent ?? '----'}  ${locator}`];
      found.names.forEach((n, i) => {
        const pax = n.passengers[0];
        const title = pax.title ? ` ${pax.title}` : '';
        lines.push(`  ${i + 1}. ${n.surname}/${pax.firstName}${title}`);
      });
      found.segments.forEach((s) => {
        lines.push(`  ${s.segmentNumber}. ${s.carrier} ${s.flightNumber} ${s.bookingClass} ${s.date} ${s.origin} ${s.destination} ${s.status}${s.seats}`);
      });
      return lines.join('\n');
    }

    // Everything else: honest "not implemented" stub.
    return NOT_IMPLEMENTED;
  }

  isErrorResponse(response: string): boolean {
    return ERROR_RESPONSES.has(response);
  }
}
