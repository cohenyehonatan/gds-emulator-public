/**
 * Galileo handler dispatch — semantic operations on `ParsedEntry`,
 * emitting Galileo-flavored host responses.
 *
 * Architectural note: the FSM transitions, work-area model, and PNR
 * lifecycle are dialect-agnostic — sign-on always moves the session
 * state to SIGNED_ON, sign-off always tears down the work area. What
 * differs across dialects is the *response strings*. So Galileo's
 * dispatch re-uses the SessionMachine + WorkArea + reset semantics but
 * emits its own response wording, sourced (where the references allow)
 * from `references/galileo/`.
 *
 * Today only sign-on / sign-off land. The dispatch table grows as more
 * verbs come online; unrecognized kinds fall through to a Galileo-
 * specific NOT_IMPLEMENTED marker so the dialect's chain-halting set
 * can stop on them.
 */

import type {
  ParsedEntry,
  AvailabilityEntry,
  SellEntry,
  NameEntry,
  PhoneEntry,
  TicketingEntry,
  ReceivedFromEntry,
  EndTransactionEntry,
  DisplayEntry,
  CancelEntry,
  SegmentStatusEntry,
  PassiveCancelEntry,
  PricingEntry,
  TicketEntry,
  FlightInfoEntry,
} from '../../protocol/entry.js';
import { MANUAL_STATUS_CODES } from '../../protocol/constants.js';
import type { TicketRecord } from '../../models/ticket.js';
import { ticketNumber } from '../../models/ticket.js';
import { priceItinerary } from '../../session/handlers/pricing-handler.js';
import { LiveTravelportBackend } from '../../backends/live-travelport-backend.js';
import { mapCatalogProductOfferings } from '../../backends/travelport-mapper.js';
import { isRecordLocator } from '../../models/record-locator.js';
import type { WorkArea } from '../../session/work-area.js';
import type { HandlerContext } from '../../session/handlers/context.js';
import type { AirSegment } from '../../models/segment.js';
import type { MandatoryFieldKey } from '../../protocol/constants.js';
import { MandatoryField, StatusCode } from '../../protocol/constants.js';
import { parseNameText } from '../../models/name-element.js';
import { SessionEvent } from '../../session/session-state.js';
import { InvalidTransitionError } from '../../session/session-machine.js';
import { dayOfWeekLetter, dayOfWeekNumber } from '../../session/handlers/context.js';
import {
  renderGalileoSignInResponse,
  renderGalileoSignOffResponse,
  renderGalileoSwitchAreaResponse,
  renderGalileoAvailability,
  renderGalileoSoldSegment,
  renderGalileoPnr,
  renderGalileoItinerary,
  renderGalileoFareQuote,
  renderGalileoIssuedTickets,
  renderGalileoFlightInfo,
} from './serializer.js';
import { GalileoResponse } from './responses.js';

export const GALILEO_NOT_IMPLEMENTED = 'NOT IMPLEMENTED — galileo dialect';

export function dispatchGalileo(
  entry: ParsedEntry,
  wa: WorkArea,
  ctx: HandlerContext
): string | Promise<string> {
  try {
    switch (entry.kind) {
      case 'sign_in':
        wa.machine.transition(SessionEvent.SIGN_IN);
        wa.agent = entry.argument || undefined;
        return renderGalileoSignInResponse({ pcc: ctx.pcc, agent: wa.agent });

      case 'sign_out': {
        wa.machine.transition(SessionEvent.SIGN_OFF);
        const agent = wa.agent;
        wa.reset();
        return renderGalileoSignOffResponse({ pcc: ctx.pcc, agent });
      }

      case 'switch_area':
        if (!wa.switchTo(entry.targetArea)) return GalileoResponse.FORMAT;
        return renderGalileoSwitchAreaResponse({ pcc: ctx.pcc, agent: wa.agent }, wa.area);

      case 'availability':
        return handleGalileoAvailability(entry, wa, ctx);

      case 'sell':
        return handleGalileoSell(entry, wa, ctx);

      case 'name':
        return handleGalileoName(entry, wa);

      case 'phone':
        return handleGalileoPhone(entry, wa);

      case 'ticketing':
        return handleGalileoTicketing(entry, wa);

      case 'received_from':
        return handleGalileoReceivedFrom(entry, wa);

      case 'end_transaction':
        return handleGalileoEndTransaction(entry, wa, ctx);

      case 'ignore':
        wa.machine.transition(SessionEvent.IGNORE);
        wa.reset();
        return GalileoResponse.IGNORED;

      case 'display':
        return handleGalileoDisplay(entry, wa, ctx);

      case 'cancel':
        return handleGalileoCancel(entry, wa);

      case 'segment_status':
        return handleGalileoSegmentStatus(entry, wa);

      case 'passive_cancel':
        return handleGalileoPassiveCancel(entry, wa);

      case 'pricing':
        return handleGalileoPricing(entry, wa);

      case 'ticket':
        return handleGalileoTicket(entry, wa, ctx);

      case 'flight_info':
        return handleGalileoFlightInfo(entry, wa);

      default:
        return GALILEO_NOT_IMPLEMENTED;
    }
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      return 'OUT OF SEQUENCE'; // reconstructed — matches the Sabre placeholder
    }
    throw err;
  }
}

/**
 * `A<DDMMM><orig><dest>` neutral / carrier-filtered availability.
 * Uses the EmulatedBackend inventory (same one Sabre uses) — the
 * matrix's whole point. Caches the result on the slot so the next
 * `N<seats><class><line>` can resolve a line number.
 *
 * Sort prefixes (AD/AJ/AA/AF) are accepted at parse time but treated
 * the same as default sort here, since the inventory layer only
 * orders by departure time. AF (7-day window) would require ranged
 * queries — deferred. Flagged in the parser docstring.
 */
async function handleGalileoAvailability(
  entry: AvailabilityEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  if (entry.mode !== 'display') return GALILEO_NOT_IMPLEMENTED;
  const date = entry.date!;
  const dow = {
    letter: dayOfWeekLetter(date.month, date.day),
    num: dayOfWeekNumber(date.month, date.day),
  };

  // LiveTravelportBackend path: dispatch to the TripServices REST API
  // (CatalogProductOfferings), then run the response through the mapper.
  // Emulated path: the existing dialect-shared Inventory.availability.
  let lines;
  if (ctx.backend instanceof LiveTravelportBackend) {
    try {
      const response = await ctx.backend.airSearch({
        origin: entry.origin!,
        destination: entry.destination!,
        departureDate: toIsoDate(date.raw, date.month, date.day),
      });
      lines = mapCatalogProductOfferings(response, {
        date: date.raw,
        dayOfWeekLetter: dow.letter,
        dayOfWeekNum: dow.num,
      });
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  } else {
    lines = ctx.backend.inventory.availability(date.raw, dow, entry.origin!, entry.destination!, {
      carriers: entry.carriers,
      connectingCity: entry.connectingCity,
    });
  }

  const result = {
    date: date.raw,
    origin: entry.origin!,
    destination: entry.destination!,
    lines,
  };
  wa.lastAvailability = result;
  if (lines.length === 0) return 'NO FLIGHTS'; // reconstructed
  return renderGalileoAvailability(result);
}

/**
 * Convert a Sabre date token + month/day pair into the ISO `YYYY-MM-DD`
 * shape Travelport expects in CatalogProductOfferingsRequest. Year is
 * inferred forward — if the requested month/day is already past in the
 * current year, roll to next year, matching the GDS convention.
 */
function toIsoDate(_token: string, month: number, day: number): string {
  const now = new Date();
  let year = now.getFullYear();
  const candidate = new Date(year, month, day);
  if (candidate < now) year += 1;
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * `N<seats><class><line>` — single-segment sell from the cached
 * availability. Decrements inventory and appends an AirSegment to
 * the slot's PNR; returns the sold-segment echo (Module-2 style).
 *
 * Multi-leg (`N2F1F2Y3`) and star-connection (`N1C5*`) deferred to a
 * follow-up commit.
 */
function handleGalileoSell(entry: SellEntry, wa: WorkArea, ctx: HandlerContext): string {
  const avail = wa.lastAvailability;
  if (!avail) return 'NO AVAILABILITY DISPLAYED'; // reconstructed

  // Single-segment sells set `bookingClass` + `line` at the top; multi-leg
  // sells additionally populate `legs`. Normalize to a single array.
  const legs = entry.legs ?? [{ bookingClass: entry.bookingClass, line: entry.line! }];

  // Validate every (line, class) pair before mutating anything — a partial
  // multi-leg sell would leave the PNR in a bad state.
  for (const leg of legs) {
    const line = avail.lines.find((l) => l.line === leg.line);
    if (!line) return GalileoResponse.FORMAT;
    if ((line.classes[leg.bookingClass] ?? 0) < entry.seats) {
      return 'CLASS NOT AVAILABLE'; // reconstructed
    }
  }

  wa.machine.transition(SessionEvent.SELL);
  const added: AirSegment[] = [];
  for (const leg of legs) {
    const line = avail.lines.find((l) => l.line === leg.line)!;
    ctx.backend.inventory.sell(avail.date, line.carrier, line.flightNumber, leg.bookingClass, entry.seats);
    const seg: AirSegment = {
      segmentNumber: wa.pnr.segments.length + added.length + 1,
      carrier: line.carrier,
      flightNumber: line.flightNumber,
      bookingClass: leg.bookingClass,
      date: avail.date,
      dayOfWeek: line.dayOfWeek,
      dayOfWeekNum: line.dayOfWeekNum,
      origin: line.origin,
      destination: line.destination,
      status: StatusCode.SS,
      seats: entry.seats,
      departTime: line.departTime,
      arriveTime: line.arriveTime,
    };
    added.push(seg);
  }
  for (const s of added) wa.pnr.segments.push(s);
  return added.map(renderGalileoSoldSegment).join('\n');
}

/**
 * `N.<surname>/<given>[<title>]` — name field. Sources the same
 * parseNameText that Sabre's `-SURNAME/GIVEN` handler uses, since the
 * post-prefix shape is identical (Mini Format Guide v2 p.14-15).
 */
function handleGalileoName(entry: NameEntry, wa: WorkArea): string {
  wa.machine.transition(SessionEvent.ADD_FIELD);
  wa.pnr.names.push(parseNameText(entry.text));
  return GalileoResponse.OK;
}

/**
 * `P.<rest>` — phone / contact field. Galileo's phone field carries
 * agency contacts, hotel numbers, and email addresses, so we don't
 * try to split city/number/type (Sabre's parsePhoneText would mangle
 * the agency-T* / hotel-A* forms documented at Mini Guide v2 p.16). The
 * raw text rides through in PhoneElement.number; a Galileo PNR
 * renderer can format it back out unchanged when that lands.
 */
function handleGalileoPhone(entry: PhoneEntry, wa: WorkArea): string {
  wa.machine.transition(SessionEvent.ADD_FIELD);
  wa.pnr.phones.push({ number: entry.text });
  return GalileoResponse.OK;
}

/**
 * `T.<rest>` — ticketing / time-limit field. Mini Guide v2 p.16
 * documents `T.T*` minimum input, `T.TAU/<DDMMM>` queue+date, the
 * `*<remark>` suffix, and the `@` change prefix. The handler stores
 * the raw text; downstream consumers (PNR display, ticket-issue) can
 * inspect it as they need to.
 */
function handleGalileoTicketing(entry: TicketingEntry, wa: WorkArea): string {
  wa.machine.transition(SessionEvent.ADD_FIELD);
  wa.pnr.ticketing = entry.text;
  return GalileoResponse.OK;
}

/**
 * `R.<rest>` — received from field. Mini Guide v2 p.16: `R.AGT`,
 * `R.YY` (agent initials).
 */
function handleGalileoReceivedFrom(entry: ReceivedFromEntry, wa: WorkArea): string {
  wa.machine.transition(SessionEvent.ADD_FIELD);
  wa.pnr.receivedFrom = entry.text;
  return GalileoResponse.OK;
}

/**
 * `E`/`ET` end transaction (Mini Guide v2 p.17). Mandatory-field
 * checks mirror Sabre's: name, ticketing, received-from, phone,
 * itinerary — all five are required before the booking file commits.
 * Names==seats is also checked (carries over since the PNR data
 * model is shared).
 *
 * `ER` (end + retrieve) returns the locator like `E`/`ET` for v1;
 * the Galileo BF redisplay renderer lands with the PNR display verb
 * in a follow-up commit.
 */
const GALILEO_MISSING_RESPONSE: Record<MandatoryFieldKey, string> = {
  [MandatoryField.PHONE]: GalileoResponse.NEED_PHONE,
  [MandatoryField.RECEIVED_FROM]: GalileoResponse.NEED_RECEIVED_FROM,
  [MandatoryField.ITINERARY]: GalileoResponse.NEED_ITINERARY,
  [MandatoryField.NAME]: GalileoResponse.NEED_NAME,
  [MandatoryField.TICKETING]: GalileoResponse.NEED_TICKETING,
};

function handleGalileoEndTransaction(
  entry: EndTransactionEntry,
  wa: WorkArea,
  ctx: HandlerContext
): string {
  const missing = wa.pnr.missingMandatory();
  if (missing.length > 0) return GALILEO_MISSING_RESPONSE[missing[0]];

  const pax = wa.pnr.passengerCount();
  if (wa.pnr.segments.some((s) => s.seats !== pax)) {
    return GalileoResponse.NAMES_NOT_EQUAL;
  }

  // Waitlisted segments confirm to HL at end-tx (Zenon course p.13;
  // the convention is shared across mainframe GDS).
  wa.pnr.segments.forEach((s) => {
    if (s.status === 'LL') s.status = 'HL';
  });

  const locator = ctx.backend.pnrs.commit(wa.pnr);
  const committed = wa.pnr;
  const agent = wa.agent;
  wa.machine.transition(SessionEvent.END_TX);
  wa.reset();
  return entry.redisplay ? renderGalileoPnr(committed, { pcc: ctx.pcc, agent }) : locator;
}

/**
 * `*R` / `*I` / `*<locator>` / `*-<surname>` — retrieve and display.
 * Sources: Mini Format Guide v2 p.17 (retrieve forms) + Smartpoint
 * Module 2 p.27 (`*R` / `*I` display verbs).
 *
 * Argument shapes:
 *   ""        bare `*` — same as `*R` (redisplay current BF)
 *   "R"       redisplay current BF
 *   "I"       itinerary-only redisplay
 *   "-NAME"   surname search; first-match retrieves into slot
 *   "ABCDEF"  6-letter record locator → retrieve
 *
 * Multi-match surname results return the locators on one line each
 * for now — the `*<n>` selection-from-list flow is deferred.
 */
function handleGalileoDisplay(entry: DisplayEntry, wa: WorkArea, ctx: HandlerContext): string {
  const arg = entry.argument;
  const sig = { pcc: ctx.pcc, agent: wa.agent };

  // Redisplay verbs — operate on whatever's in the active slot.
  if (arg === '' || arg.toUpperCase() === 'R') {
    if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
    return renderGalileoPnr(wa.pnr, sig);
  }
  if (arg.toUpperCase() === 'I') {
    if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
    return renderGalileoItinerary(wa.pnr);
  }

  // Surname retrieve — `*-SMITH`. For >1 match, list locators; the agent
  // re-issues against a specific locator. (The `*<n>` similar-name-list
  // selection is a Sabre-only convention not documented for Galileo.)
  if (arg.startsWith('-')) {
    const surname = arg.slice(1).trim().split('/')[0]; // strip any "/GIVEN"
    const matches = ctx.backend.pnrs.findBySurname(surname);
    if (matches.length === 0) return GalileoResponse.NO_PNR;
    if (matches.length > 1) {
      // Reconstructed multi-match listing — Mini Guide doesn't quote the
      // layout, so we just present the locators one per line.
      return matches.map((p, i) => `${i + 1}. ${p.locator}`).join('\n');
    }
    wa.pnr = matches[0];
    wa.machine.transition(SessionEvent.RETRIEVE);
    return renderGalileoPnr(matches[0], sig);
  }

  // Record locator (6-char alphanumeric per generateRecordLocator).
  if (isRecordLocator(arg)) {
    const pnr = ctx.backend.pnrs.get(arg);
    if (!pnr) return GalileoResponse.NO_PNR;
    wa.pnr = pnr;
    wa.machine.transition(SessionEvent.RETRIEVE);
    return renderGalileoPnr(pnr, sig);
  }

  return GalileoResponse.FORMAT;
}

/**
 * `X<sel>`, `XI`, `XA` — cancel segments. Source: Mini Format Guide v2
 * p.17. Behavior parallels Sabre's handleCancel: validate segments,
 * remove, renumber, transition MODIFY. Response shape uses Galileo's
 * itinerary renderer when segments remain, an `ITINERARY CANCELLED`
 * placeholder otherwise (reconstructed — Mini Guide doesn't quote the
 * empty-itinerary wording).
 */
function handleGalileoCancel(entry: CancelEntry, wa: WorkArea): string {
  if (wa.pnr.segments.length === 0) return GalileoResponse.NEED_ITINERARY;

  if (entry.mode === 'itinerary' || entry.mode === 'all_air') {
    wa.machine.transition(SessionEvent.MODIFY);
    wa.pnr.segments = [];
    return 'ITINERARY CANCELLED'; // reconstructed
  }

  const max = wa.pnr.segments.length;
  for (const n of entry.segments) {
    if (n < 1 || n > max) return 'SEGMENT NUMBER NOT IN ITINERARY'; // reconstructed
  }

  wa.machine.transition(SessionEvent.MODIFY);
  const remove = new Set(entry.segments);
  wa.pnr.segments = wa.pnr.segments.filter((s) => !remove.has(s.segmentNumber));
  wa.pnr.renumberSegments();

  return wa.pnr.segments.length > 0
    ? renderGalileoItinerary(wa.pnr)
    : 'ITINERARY CANCELLED'; // reconstructed
}

/**
 * `@<n>HK` — change a segment's status code. Source: Galileo Pocket
 * Guide p.3. Status code is validated against the Sabre-shared
 * MANUAL_STATUS_CODES set since manual-entry codes (HK, HL, NN, GK,
 * BK, etc.) are industry-standard rather than dialect-specific.
 */
function handleGalileoSegmentStatus(entry: SegmentStatusEntry, wa: WorkArea): string {
  if (wa.pnr.segments.length === 0) return GalileoResponse.NEED_ITINERARY;
  if (!MANUAL_STATUS_CODES.has(entry.status)) return 'INVALID STATUS CODE'; // reconstructed
  const seg = wa.pnr.segments.find((s) => s.segmentNumber === entry.segment);
  if (!seg) return 'SEGMENT NUMBER NOT IN ITINERARY'; // reconstructed
  wa.machine.transition(SessionEvent.MODIFY);
  seg.status = entry.status;
  return renderGalileoItinerary(wa.pnr);
}

/**
 * `@<n>XK` — passive cancel. Mini Guide v2 p.17: "Remove a HX segment
 * passively (for all airlines except EK)". Same observable behavior as
 * a normal cancel in this emulator (we don't model an airline party);
 * dispatch is separate to honor the wire-format distinction.
 */
function handleGalileoPassiveCancel(entry: PassiveCancelEntry, wa: WorkArea): string {
  if (wa.pnr.segments.length === 0) return GalileoResponse.NEED_ITINERARY;
  const max = wa.pnr.segments.length;
  for (const n of entry.segments) {
    if (n < 1 || n > max) return 'SEGMENT NUMBER NOT IN ITINERARY'; // reconstructed
  }
  wa.machine.transition(SessionEvent.MODIFY);
  const remove = new Set(entry.segments);
  wa.pnr.segments = wa.pnr.segments.filter((s) => !remove.has(s.segmentNumber));
  wa.pnr.renumberSegments();
  return wa.pnr.segments.length > 0
    ? renderGalileoItinerary(wa.pnr)
    : 'ITINERARY CANCELLED'; // reconstructed
}

/**
 * `FQ` — Fare Quote. Source: Mini Format Guide v2 p.27. The Sabre
 * pricing engine (priceItinerary) is reused — it's tariff-driven and
 * dialect-agnostic. FQ always stores the resulting quote on the PNR
 * so a later `TKP<n>` can issue from it.
 */
function handleGalileoPricing(_entry: PricingEntry, wa: WorkArea): string {
  if (wa.pnr.segments.length === 0) return GalileoResponse.NEED_ITINERARY;
  if (wa.pnr.names.length === 0) return GalileoResponse.NEED_NAME;
  const fq = priceItinerary(wa.pnr, {});
  if (!fq) return 'FARE QUOTE NOT AVAILABLE'; // reconstructed
  wa.pnr.priceQuotes.push(fq);
  wa.lastPricing = fq;
  return renderGalileoFareQuote(fq, wa.pnr.priceQuotes.length);
}

/**
 * `TKP<n>` — Issue ticket and associated documents for filed fare `<n>`.
 * Source: Mini Format Guide v2 p.53. Constructs one TicketRecord per
 * passenger for each priced segment block, pushes to pnr.tickets, and
 * returns a Galileo-style ticket-issue echo.
 *
 * v1 limitations:
 *   - issues for ALL passenger blocks in the quote; per-passenger
 *     TKP<n>P<m> deferred.
 *   - no FOP / commission / ticket modifiers (TMU<n>...) — those come
 *     in a follow-up commit.
 *   - issuance does not depend on `T.` ticketing-field state.
 */
function handleGalileoTicket(entry: TicketEntry, wa: WorkArea, ctx: HandlerContext): string {
  if (entry.source !== 'pq') return GalileoResponse.FORMAT; // shouldn't happen via Galileo parser
  const idx = (entry.pqRecord ?? 1) - 1;
  if (idx < 0 || idx >= wa.pnr.priceQuotes.length) {
    return 'FILED FARE NOT FOUND'; // reconstructed
  }
  const fq = wa.pnr.priceQuotes[idx];

  // Determine which segments to issue — for FQ-stored quotes, that's
  // every segment the quote covers. We use pnr.segments since FQ
  // priced the whole itinerary.
  const segments = wa.pnr.segments;
  if (segments.length === 0) return GalileoResponse.NEED_ITINERARY;

  // One ticket per passenger, per the Sabre ticketing convention.
  // Each ticket lumps every priced segment's tariff into a single base/tax.
  const tariff: 'D' | 'I' = 'D'; // v1: assume domestic; international tariff comes with international markets
  const issued: TicketRecord[] = [];
  for (const block of fq.passengers) {
    for (let i = 0; i < block.count; i++) {
      const name = wa.pnr.names[0]?.passengers[i];
      const passenger = name
        ? `${wa.pnr.names[0].surname}/${name.firstName.charAt(0)}`
        : `${block.passengerType}/${i + 1}`;
      const record: TicketRecord = {
        number: ticketNumber(fq.validatingCarrier, ctx.backend.nextTicketSerial()),
        type: 'TE',
        stock: 'AT',
        passenger,
        pcc: ctx.pcc,
        agent: wa.agent,
        issuedAt: new Date(),
        tariff,
        validatingCarrier: fq.validatingCarrier,
        base: block.base,
        taxTotal: block.taxTotal,
        total: block.total,
      };
      wa.pnr.tickets.push(record);
      issued.push(record);
    }
  }
  return renderGalileoIssuedTickets(issued);
}

/**
 * `TTL<n>` — show flight info for line `<n>` of the cached availability.
 * Source: Mini Format Guide v2 p.11. The handler:
 *   1. Reads wa.lastAvailability (whatever the latest A<date>... cached)
 *   2. Resolves line `<n>` to an AvailabilityLine
 *   3. Renders carrier / flight / orig / dest / depart / arrive / equip
 *   4. When the line has a vendorRef (came from a live backend), surfaces
 *      the Travelport offerId so an operator can confirm which offer
 *      the line maps to — useful when troubleshooting live-availability
 *      drift between cached and re-queried results.
 */
function handleGalileoFlightInfo(entry: FlightInfoEntry, wa: WorkArea): string {
  if (entry.source !== 'availability') return GALILEO_NOT_IMPLEMENTED;
  const avail = wa.lastAvailability;
  if (!avail) return 'NO AVAILABILITY DISPLAYED'; // reconstructed
  const target = entry.lines?.[0];
  if (target == null) return GalileoResponse.FORMAT;
  const line = avail.lines.find((l) => l.line === target);
  if (!line) return GalileoResponse.FORMAT;
  return renderGalileoFlightInfo(line, avail.date);
}
