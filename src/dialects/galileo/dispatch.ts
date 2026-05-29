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
  VoidEntry,
  QueueEntry,
  DivideEntry,
  IgnoreEntry,
} from '../../protocol/entry.js';
import { MANUAL_STATUS_CODES } from '../../protocol/constants.js';
import type { TicketRecord } from '../../models/ticket.js';
import { ticketNumber } from '../../models/ticket.js';
import { priceItinerary } from '../../session/handlers/pricing-handler.js';
import { LiveTravelportBackend } from '../../backends/live-travelport-backend.js';
import {
  mapCatalogProductOfferings,
  mapReservation,
  mapPricedOffer,
  mapReceipts,
  extractSegmentOfferIds,
  mapQueueList,
} from '../../backends/travelport-mapper.js';
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
  renderGalileoTicketList,
  renderGalileoFlightInfo,
  renderGalileoQueueList,
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
        return handleGalileoName(entry, wa, ctx);

      case 'phone':
        return handleGalileoPhone(entry, wa, ctx);

      case 'ticketing':
        return handleGalileoTicketing(entry, wa);

      case 'received_from':
        return handleGalileoReceivedFrom(entry, wa);

      case 'end_transaction':
        return handleGalileoEndTransaction(entry, wa, ctx);

      case 'ignore':
        return handleGalileoIgnore(entry, wa, ctx);

      case 'display':
        return handleGalileoDisplay(entry, wa, ctx);

      case 'cancel':
        return handleGalileoCancel(entry, wa, ctx);

      case 'segment_status':
        return handleGalileoSegmentStatus(entry, wa);

      case 'passive_cancel':
        return handleGalileoPassiveCancel(entry, wa, ctx);

      case 'pricing':
        return handleGalileoPricing(entry, wa, ctx);

      case 'ticket':
        return handleGalileoTicket(entry, wa, ctx);

      case 'flight_info':
        return handleGalileoFlightInfo(entry, wa);

      case 'void':
        return handleGalileoVoid(entry, wa, ctx);

      case 'queue':
        return handleGalileoQueue(entry, wa, ctx);

      case 'divide':
        return handleGalileoDivide(entry, wa, ctx);

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
 * `N<seats><class><line>` — single- or multi-leg sell from cached
 * availability. EmulatedBackend: decrement local inventory + push
 * AirSegment to slot PNR. LiveTravelportBackend: ensure a workbench
 * (creating one on the slot if needed), POST each chosen line's
 * `vendorRef.offerId` via addOffer, then mirror the segment locally
 * so downstream cryptic entries (`N.<name>`, `ER`) still operate on
 * a coherent in-memory PNR.
 *
 * Star-connection (`N1C5*`) deferred to a follow-up commit.
 */
async function handleGalileoSell(
  entry: SellEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
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

  // Live path: ensure a workbench, then POST one offer per leg.
  // Each leg's vendorRef.offerId must have been captured by the
  // availability mapper; absent it, we can't address the offer on
  // the live side and refuse rather than silently fall back.
  if (ctx.backend instanceof LiveTravelportBackend) {
    const liveBackend = ctx.backend;
    for (const leg of legs) {
      const line = avail.lines.find((l) => l.line === leg.line)!;
      if (!line.vendorRef?.offerId) return 'LIVE OFFER ID MISSING'; // reconstructed
    }
    try {
      if (!wa.liveWorkbenchId) {
        wa.liveWorkbenchId = await liveBackend.createWorkbench();
      }
      for (const leg of legs) {
        const line = avail.lines.find((l) => l.line === leg.line)!;
        await liveBackend.addOffer(wa.liveWorkbenchId, line.vendorRef!.offerId!, entry.seats);
      }
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }

  wa.machine.transition(SessionEvent.SELL);
  const added: AirSegment[] = [];
  for (const leg of legs) {
    const line = avail.lines.find((l) => l.line === leg.line)!;
    // Emulated path: decrement inventory. Live path: the live backend
    // owns its own seat counts on the vendor side, so we skip the
    // local Inventory.sell — the EmulatedBackend's Inventory wouldn't
    // know anything about the live-search lines anyway.
    if (!(ctx.backend instanceof LiveTravelportBackend)) {
      ctx.backend.inventory.sell(avail.date, line.carrier, line.flightNumber, leg.bookingClass, entry.seats);
    }
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
 *
 * Live path: ensure a workbench (creating one if name comes before any
 * sell), then POST one Traveler element per parsed passenger via
 * /11/air/book/traveler/.../travelers. The local NameItem still gets
 * pushed to wa.pnr.names so cryptic-side queries (*R, FQ) operate on
 * a coherent view.
 *
 * Multi-passenger names (`N.3SMITH/JOHN MR/JANE MRS/...`) emit one
 * Traveler call per passenger sequentially. The Travelport batch
 * endpoint (`/travelers/list`) would be the optimization.
 */
async function handleGalileoName(
  entry: NameEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  const nameItem = parseNameText(entry.text);

  if (ctx.backend instanceof LiveTravelportBackend) {
    const liveBackend = ctx.backend;
    try {
      if (!wa.liveWorkbenchId) {
        wa.liveWorkbenchId = await liveBackend.createWorkbench();
      }
      for (const pax of nameItem.passengers) {
        await liveBackend.addTraveler(wa.liveWorkbenchId, {
          givenName: pax.firstName,
          surname: nameItem.surname,
        });
      }
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }

  wa.machine.transition(SessionEvent.ADD_FIELD);
  wa.pnr.names.push(nameItem);
  return GalileoResponse.OK;
}

/**
 * `P.<rest>` — phone / contact field. Galileo's phone field carries
 * agency contacts, hotel numbers, and email addresses, so we don't
 * try to split city/number/type (Sabre's parsePhoneText would mangle
 * the agency-T* / hotel-A* forms documented at Mini Guide v2 p.16). The
 * raw text rides through in PhoneElement.number; a Galileo PNR
 * renderer can format it back out unchanged when that lands.
 *
 * Live path: ensure workbench (creating one if P. comes before sell /
 * name), POST to /primarycontacts. The local PhoneElement still gets
 * pushed so *R renders the BF correctly.
 */
async function handleGalileoPhone(
  entry: PhoneEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  if (ctx.backend instanceof LiveTravelportBackend) {
    const liveBackend = ctx.backend;
    try {
      if (!wa.liveWorkbenchId) {
        wa.liveWorkbenchId = await liveBackend.createWorkbench();
      }
      await liveBackend.addPrimaryContact(wa.liveWorkbenchId, entry.text);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }

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

/**
 * `I` (ignore) / `IR` (ignore + retrieve). Source: Mini Format Guide
 * v2 p.17. The ignore semantics are shared:
 *  - Live: send polite-citizen `DELETE .../reservationworkbench/{wb}`
 *    if a workbench is open. Failures are swallowed (server's 30-min
 *    TTL would clean up anyway); the cryptic still returns `IGNORED`.
 *  - Clear the work area + transition IGNORE.
 *
 * `IR` then re-retrieves whatever locator was on screen before — same
 * code path as `*<locator>`. If there was no locator (mid-build with
 * no prior retrieve), IR degrades to plain I.
 */
async function handleGalileoIgnore(
  entry: IgnoreEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  const priorLocator = wa.pnr.locator;
  if (ctx.backend instanceof LiveTravelportBackend && wa.liveWorkbenchId) {
    try {
      await ctx.backend.deleteWorkbench(wa.liveWorkbenchId);
    } catch {
      // Polite-citizen — server's 30-min TTL handles failures here.
    }
  }
  wa.machine.transition(SessionEvent.IGNORE);
  wa.reset();

  if (entry.retrieve && priorLocator) {
    const sig = { pcc: ctx.pcc, agent: wa.agent };
    if (ctx.backend instanceof LiveTravelportBackend) {
      return retrieveGalileoLive(priorLocator, wa, ctx, ctx.backend, sig);
    }
    const pnr = ctx.backend.pnrs.get(priorLocator);
    if (!pnr) return GalileoResponse.NO_PNR;
    wa.pnr = pnr;
    wa.machine.transition(SessionEvent.RETRIEVE);
    return renderGalileoPnr(pnr, sig);
  }
  return GalileoResponse.IGNORED;
}

function handleGalileoEndTransaction(
  entry: EndTransactionEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> | string {
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

  // Live path: commit the workbench → server returns the real locator
  // → we stamp it on the in-memory PNR and ALSO write to the local
  // pnrStore so a follow-up *<locator> retrieve finds it locally until
  // live retrieve lands. The workbench is consumed server-side; clear
  // wa.liveWorkbenchId so a future build starts a fresh one.
  if (ctx.backend instanceof LiveTravelportBackend) {
    if (!wa.liveWorkbenchId) {
      // The mandatory-field check above should have caught the no-itinerary
      // case, but if somehow we get here without a workbench, the live
      // commit has nothing to commit. Refuse rather than silently committing
      // a phantom local PNR.
      return 'LIVE WORKBENCH MISSING'; // reconstructed
    }
    return commitGalileoLive(entry, wa, ctx, ctx.backend, wa.liveWorkbenchId);
  }

  const locator = ctx.backend.pnrs.commit(wa.pnr);
  const committed = wa.pnr;
  const agent = wa.agent;
  wa.machine.transition(SessionEvent.END_TX);
  wa.reset();
  return entry.redisplay ? renderGalileoPnr(committed, { pcc: ctx.pcc, agent }) : locator;
}

async function commitGalileoLive(
  entry: EndTransactionEntry,
  wa: WorkArea,
  ctx: HandlerContext,
  backend: LiveTravelportBackend,
  workbenchId: string
): Promise<string> {
  let locator: string;
  try {
    locator = await backend.commitWorkbench(workbenchId, {
      ticketing: wa.pnr.ticketing, // T.T* / T.TAU/10JUN — rides inline on the commit per v11 spec
    });
  } catch (err) {
    return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
  }
  wa.pnr.locator = locator;
  // Pragmatic: also write to local pnrs store so *<locator> retrieve
  // finds it until live retrieve lands. The committed PNR is then
  // available both via the live backend and the local cache.
  ctx.backend.pnrs.commit(wa.pnr);
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
function handleGalileoDisplay(
  entry: DisplayEntry,
  wa: WorkArea,
  ctx: HandlerContext
): string | Promise<string> {
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

  // `*HTI` / `*HTE` — display ticket numbers / etickets. Source: Mini
  // Format Guide v2 p.53. Live path GETs /receipts; emulated reads the
  // local TicketRecord[]. Both render via renderGalileoTicketList.
  if (arg.toUpperCase() === 'HTI' || arg.toUpperCase() === 'HTE') {
    return ticketListGalileo(wa, ctx);
  }

  // Surname retrieve — `*-SMITH`. No documented REST equivalent in
  // TripServices (the spec calls surname search "GDS-host-only"), so
  // this stays local-only even when the backend is live. The local
  // pnrStore was populated as a pragmatic shadow by the live commit
  // path, so committed live PNRs are findable by name here too.
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

  // Record locator (6-char alphanumeric). Live path GETs the reservation
  // from TripServices and maps it; emulated path reads from pnrStore.
  if (isRecordLocator(arg)) {
    if (ctx.backend instanceof LiveTravelportBackend) {
      return retrieveGalileoLive(arg, wa, ctx, ctx.backend, sig);
    }
    const pnr = ctx.backend.pnrs.get(arg);
    if (!pnr) return GalileoResponse.NO_PNR;
    wa.pnr = pnr;
    wa.machine.transition(SessionEvent.RETRIEVE);
    return renderGalileoPnr(pnr, sig);
  }

  return GalileoResponse.FORMAT;
}

async function retrieveGalileoLive(
  locator: string,
  wa: WorkArea,
  ctx: HandlerContext,
  backend: LiveTravelportBackend,
  sig: { pcc: string; agent?: string }
): Promise<string> {
  let response;
  try {
    response = await backend.retrieveReservation(locator);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 404 / 410 → reservation doesn't exist; surface the Galileo
    // dialect's NO BOOKING FILE rather than the raw upstream error.
    if (/HTTP 40[4]|HTTP 410/.test(msg)) return GalileoResponse.NO_PNR;
    return `LIVE BACKEND ERROR: ${msg}`; // reconstructed
  }
  const pnr = mapReservation(response, locator);
  wa.pnr = pnr;
  // Mirror to local pnrStore so a subsequent surname search finds it,
  // matching the pragmatic shadow the commit path already uses.
  ctx.backend.pnrs.commit(pnr);
  wa.machine.transition(SessionEvent.RETRIEVE);
  return renderGalileoPnr(pnr, sig);
}

/**
 * `X<sel>`, `XI`, `XA` — cancel segments. Source: Mini Format Guide v2
 * p.17. Behavior parallels Sabre's handleCancel: validate segments,
 * remove, renumber, transition MODIFY. Response shape uses Galileo's
 * itinerary renderer when segments remain, an `ITINERARY CANCELLED`
 * placeholder otherwise (reconstructed — Mini Guide doesn't quote the
 * empty-itinerary wording).
 *
 * Live-backend routing (three cases):
 *   - In-flight workbench (`wa.liveWorkbenchId` populated): cancel via
 *     `POST /book/reservationworkbench/{wb}/reservations/cancelitems`.
 *     XI / XA send the empty body; X<n> sends `Segments: [{ segmentNumber }]`.
 *   - Committed BF retrieved by `*<locator>` (locator + no workbench):
 *     cancel via `POST /11/air/receipt/reservations/{loc}/receipts`. Only
 *     full-itinerary cancels (XI / XA) are supported live in v1 — partial
 *     cancel of a committed reservation requires a post-commit-workbench
 *     flow (`buildfromlocator`) which is deferred.
 *   - Neither: emulated path (handleGalileoCancelEmulated).
 */
function handleGalileoCancel(
  entry: CancelEntry,
  wa: WorkArea,
  ctx: HandlerContext
): string | Promise<string> {
  if (wa.pnr.segments.length === 0) return GalileoResponse.NEED_ITINERARY;

  if (ctx.backend instanceof LiveTravelportBackend) {
    if (wa.liveWorkbenchId) {
      return cancelGalileoLiveWorkbench(entry, wa, ctx, ctx.backend);
    }
    if (wa.pnr.locator) {
      return cancelGalileoLiveCommitted(entry, wa, ctx, ctx.backend);
    }
    // Fall through to emulated for the (unusual) live-backend case with
    // neither workbench nor locator — segments would be entirely local.
  }

  return handleGalileoCancelEmulated(entry, wa);
}

function handleGalileoCancelEmulated(entry: CancelEntry, wa: WorkArea): string {
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

async function cancelGalileoLiveWorkbench(
  entry: CancelEntry,
  wa: WorkArea,
  ctx: HandlerContext,
  backend: LiveTravelportBackend
): Promise<string> {
  const max = wa.pnr.segments.length;
  // Partial cancel: validate selection before posting (so we don't
  // partially deplete the workbench and leave the local view drifting).
  if (entry.mode !== 'itinerary' && entry.mode !== 'all_air') {
    for (const n of entry.segments) {
      if (n < 1 || n > max) return 'SEGMENT NUMBER NOT IN ITINERARY'; // reconstructed
    }
  }
  try {
    const isFull = entry.mode === 'itinerary' || entry.mode === 'all_air';
    if (isFull) {
      await backend.cancelWorkbenchItems(wa.liveWorkbenchId!, { all: true });
    } else {
      // Per-segment cancel: resolve each segment's `vendorRef.offerId` by
      // matching against the cached availability lines (carrier + flight
      // number). Group by offer ID — TripServices cancels at the offer
      // level when we don't supply per-segment productID + sequence,
      // which means selecting any segment of a multi-leg offer cancels
      // the whole offer. The local view is renumbered to match after
      // the POST returns OK.
      const offerIds = collectOfferIdsForSegments(wa, entry.segments);
      if (offerIds.length === 0) {
        return 'LIVE OFFER ID MISSING'; // reconstructed — same as live-sell
      }
      await backend.cancelWorkbenchItems(wa.liveWorkbenchId!, { offerIds });
    }
  } catch (err) {
    return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
  }
  wa.machine.transition(SessionEvent.MODIFY);
  if (entry.mode === 'itinerary' || entry.mode === 'all_air') {
    wa.pnr.segments = [];
  } else {
    const remove = new Set(entry.segments);
    wa.pnr.segments = wa.pnr.segments.filter((s) => !remove.has(s.segmentNumber));
    wa.pnr.renumberSegments();
  }
  return wa.pnr.segments.length > 0
    ? renderGalileoItinerary(wa.pnr)
    : 'ITINERARY CANCELLED'; // reconstructed
}

async function cancelGalileoLiveCommitted(
  entry: CancelEntry,
  wa: WorkArea,
  ctx: HandlerContext,
  backend: LiveTravelportBackend
): Promise<string> {
  if (entry.mode === 'itinerary' || entry.mode === 'all_air') {
    try {
      await backend.cancelReservation(wa.pnr.locator!);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
    wa.machine.transition(SessionEvent.MODIFY);
    wa.pnr.segments = [];
    // Mirror the cancel locally too — the committed BF in pnrStore was
    // a pragmatic shadow; cancelling it on the server should clear the
    // local copy's segments so a subsequent *R reflects the cancel.
    const local = ctx.backend.pnrs.get(wa.pnr.locator!);
    if (local) local.segments = [];
    return 'ITINERARY CANCELLED'; // reconstructed
  }

  // Partial cancel against a committed BF: open a post-commit
  // workbench via `buildfromlocator`, map cryptic segment numbers to
  // offer IDs from the reservation in the response (the cached
  // availability is typically empty after a retrieve), cancel those
  // offers in the workbench, then re-commit. Same locator persists
  // across the cancel-and-recommit per the v11 spec.
  const max = wa.pnr.segments.length;
  for (const n of entry.segments) {
    if (n < 1 || n > max) return 'SEGMENT NUMBER NOT IN ITINERARY'; // reconstructed
  }
  let workbenchId: string;
  let segmentOfferIds: Map<string, string>;
  try {
    const opened = await backend.openWorkbenchFromLocator(wa.pnr.locator!);
    workbenchId = opened.workbenchId;
    segmentOfferIds = extractSegmentOfferIds(opened.raw);
  } catch (err) {
    return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
  }
  const offerIds = new Set<string>();
  for (const n of entry.segments) {
    const seg = wa.pnr.segments.find((s) => s.segmentNumber === n);
    if (!seg) continue;
    const id = segmentOfferIds.get(`${seg.carrier}-${seg.flightNumber}`);
    if (id) offerIds.add(id);
  }
  if (offerIds.size === 0) {
    return 'LIVE OFFER ID MISSING'; // reconstructed — same as live-sell
  }
  try {
    await backend.cancelWorkbenchItems(workbenchId, { offerIds: [...offerIds] });
    await backend.commitWorkbench(workbenchId);
  } catch (err) {
    return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
  }
  wa.machine.transition(SessionEvent.MODIFY);
  const remove = new Set(entry.segments);
  wa.pnr.segments = wa.pnr.segments.filter((s) => !remove.has(s.segmentNumber));
  wa.pnr.renumberSegments();
  const local = ctx.backend.pnrs.get(wa.pnr.locator!);
  if (local) {
    local.segments = local.segments.filter((s) => !remove.has(s.segmentNumber));
    local.renumberSegments();
  }
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
 * passively (for all airlines except EK)". Live path against an open
 * workbench routes through `cancelitems` with the canonical
 * `CancelSelectedOffers` body and `sendPassiveNotificationInd: true`
 * per the v11 spec — the flag distinguishes passive cancel from a
 * standard cancel that would notify the carrier. Outside a workbench
 * (committed BF or emulated backend) we fall back to local-only
 * removal, since no documented REST path covers passive cancel of a
 * committed BF.
 */
async function handleGalileoPassiveCancel(
  entry: PassiveCancelEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  if (wa.pnr.segments.length === 0) return GalileoResponse.NEED_ITINERARY;
  const max = wa.pnr.segments.length;
  for (const n of entry.segments) {
    if (n < 1 || n > max) return 'SEGMENT NUMBER NOT IN ITINERARY'; // reconstructed
  }
  if (ctx.backend instanceof LiveTravelportBackend && wa.liveWorkbenchId) {
    const offerIds = collectOfferIdsForSegments(wa, entry.segments);
    if (offerIds.length === 0) {
      return 'LIVE OFFER ID MISSING'; // reconstructed — same as live-sell
    }
    try {
      await ctx.backend.cancelWorkbenchItems(wa.liveWorkbenchId, {
        offerIds,
        passive: true,
      });
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
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
 * `FQ` — Fare Quote. Source: Mini Format Guide v2 p.27. Always stores
 * the resulting quote on the PNR so a later `TKP<n>` can issue from it.
 *
 * Live path: look up the `vendorRef.offerId` for the first segment by
 * matching against cached availability, POST to /price/offers/
 * buildfromcatalogproductofferings, and map the response to FareQuote.
 * Falls back to emulated `priceItinerary` when no offerId is reachable
 * (e.g. retrieved committed BF with no recent availability cache, or
 * line dropped its vendorRef).
 *
 * Multi-offer FQ (each segment from a different offer) deferred — the
 * common case is single-offer, and the emulated path handles the rest.
 */
async function handleGalileoPricing(
  _entry: PricingEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  if (wa.pnr.segments.length === 0) return GalileoResponse.NEED_ITINERARY;
  if (wa.pnr.names.length === 0) return GalileoResponse.NEED_NAME;

  if (ctx.backend instanceof LiveTravelportBackend) {
    const offerId = findOfferIdForFirstSegment(wa);
    if (offerId) {
      try {
        const response = await ctx.backend.priceOffer(offerId, wa.pnr.passengerCount() || 1);
        const fq = mapPricedOffer(response, {
          departureDate: wa.pnr.segments[0]?.date ?? '',
        });
        if (fq) {
          wa.pnr.priceQuotes.push(fq);
          wa.lastPricing = fq;
          return renderGalileoFareQuote(fq, wa.pnr.priceQuotes.length);
        }
        // Mapper returned null — fall through to emulated.
      } catch (err) {
        return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
      }
    }
    // No offerId reachable → fall through to emulated below.
  }

  const fq = priceItinerary(wa.pnr, {});
  if (!fq) return 'FARE QUOTE NOT AVAILABLE'; // reconstructed
  wa.pnr.priceQuotes.push(fq);
  wa.lastPricing = fq;
  return renderGalileoFareQuote(fq, wa.pnr.priceQuotes.length);
}

/**
 * Pull the Travelport offerId for the work area's first segment by
 * matching against the cached availability's line vendorRefs. Returns
 * undefined if there's no availability cache, no matching line, or no
 * vendorRef on the matched line — caller falls back to emulated.
 */
function findOfferIdForFirstSegment(wa: WorkArea): string | undefined {
  const seg = wa.pnr.segments[0];
  const avail = wa.lastAvailability;
  if (!seg || !avail) return undefined;
  const line = avail.lines.find(
    (l) => l.carrier === seg.carrier && l.flightNumber === seg.flightNumber
  );
  return line?.vendorRef?.offerId;
}

/**
 * Resolve each cryptic segment number to its Travelport offer ID via
 * cached availability. Used by live partial cancel. Deduped so a
 * multi-leg offer cancel only generates one `offerProductSelection`
 * entry. Returns [] if no offer IDs could be resolved.
 */
function collectOfferIdsForSegments(wa: WorkArea, segmentNumbers: number[]): string[] {
  const avail = wa.lastAvailability;
  if (!avail) return [];
  const ids = new Set<string>();
  for (const n of segmentNumbers) {
    const seg = wa.pnr.segments.find((s) => s.segmentNumber === n);
    if (!seg) continue;
    const line = avail.lines.find(
      (l) => l.carrier === seg.carrier && l.flightNumber === seg.flightNumber
    );
    const offerId = line?.vendorRef?.offerId;
    if (offerId) ids.add(offerId);
  }
  return [...ids];
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
async function handleGalileoTicket(
  entry: TicketEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
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

  // Live path: POST a cash form-of-payment to the workbench. The actual
  // ticket issuance happens at commit (E/ER) once both the FOP and the
  // ticketing field are on the workbench. v1 only emits cash; the full
  // TMU<n>F<form> grammar (credit cards, government warrants, etc.)
  // hasn't been wired on the cryptic side yet.
  if (ctx.backend instanceof LiveTravelportBackend && wa.liveWorkbenchId) {
    try {
      await ctx.backend.addFormOfPayment(wa.liveWorkbenchId, { kind: 'cash' });
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }

  // One ticket per passenger, per the Sabre ticketing convention.
  // Each ticket lumps every priced segment's tariff into a single base/tax.
  // Locally-issued tickets keep the in-memory PNR coherent so *T queries
  // still work; the live commit will additionally produce server-side
  // ticket numbers in the response.
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

/**
 * `*HTI` / `*HTE` — list tickets on the current BF. Live path fetches
 * /receipts (authoritative); emulated path renders the local TicketRecord[].
 * Both render via renderGalileoTicketList.
 */
function ticketListGalileo(
  wa: WorkArea,
  ctx: HandlerContext
): string | Promise<string> {
  if (ctx.backend instanceof LiveTravelportBackend && wa.pnr.locator) {
    return liveTicketListGalileo(wa, ctx.backend, wa.pnr.locator);
  }
  if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
  return renderGalileoTicketList(wa.pnr.tickets);
}

async function liveTicketListGalileo(
  wa: WorkArea,
  backend: LiveTravelportBackend,
  locator: string
): Promise<string> {
  let response;
  try {
    response = await backend.listReceipts(locator);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/HTTP 40[4]|HTTP 410/.test(msg)) return GalileoResponse.NO_PNR;
    return `LIVE BACKEND ERROR: ${msg}`; // reconstructed
  }
  const tickets = mapReceipts(response);
  // Mirror locally so subsequent cryptic queries don't need another fetch.
  wa.pnr.tickets = tickets;
  return renderGalileoTicketList(tickets);
}

/**
 * `TRV/<13-digit>` — void an eticket. Source: Mini Format Guide v2 p.53.
 * Live path PUTs /tickets/updatestatus; emulated path marks the matching
 * ticket VOIDED on the in-memory PNR.
 *
 * Only the manual mode (with `ticketNumber` set) is reachable through
 * the Galileo parser; the Sabre `WV*` list and by-item modes don't
 * have a Galileo cryptic equivalent.
 */
async function handleGalileoVoid(
  entry: VoidEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  if (entry.mode !== 'manual' || !entry.ticketNumber) {
    return GalileoResponse.FORMAT;
  }
  const ticketNumber = entry.ticketNumber;

  // Live path: PUT to /tickets/updatestatus. Same-day cutoff
  // is enforced server-side; the emulator doesn't model it.
  if (ctx.backend instanceof LiveTravelportBackend) {
    try {
      await ctx.backend.voidTicket(ticketNumber);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/HTTP 40[4]|HTTP 410/.test(msg)) return 'TKT NOT FOUND'; // reconstructed
      return `LIVE BACKEND ERROR: ${msg}`; // reconstructed
    }
  }

  // Local mirror — mark matching ticket VOIDED across the local pnr.tickets.
  // Find by ticket number across the in-memory PNR + all stored PNRs.
  let found: TicketRecord | undefined;
  found = wa.pnr.tickets.find((t) => t.number === ticketNumber);
  if (!found) {
    for (const pnr of ctx.backend.pnrs.values()) {
      const t = pnr.tickets.find((t) => t.number === ticketNumber);
      if (t) {
        found = t;
        break;
      }
    }
  }
  if (!found) return 'TKT NOT FOUND'; // reconstructed (consistent w/ Sabre WV)
  if (found.status === 'VOIDED') return 'TKT ALREADY VOIDED'; // reconstructed
  found.status = 'VOIDED';
  found.voidedAt = new Date();
  return `OK-VOID TKT ${ticketNumber}`; // reconstructed (Sabre voice)
}

/**
 * `QEB/<n>` — Place BF on queue `<n>` AND end transaction (Pocket Guide
 * p.3). Two ops in one verb: commit (if workbench in-flight) then queue
 * place against the resulting/existing locator. Live path POSTs /queue/
 * queue; emulated path appends to the shared backend.queues map.
 *
 * v1: place op only (`op === 'place'`, which is what the QEB parser
 * emits). Other queue ops (access / remove / exit) come with their own
 * cryptic verbs.
 */
async function handleGalileoQueue(
  entry: QueueEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  if (entry.op === 'exit' || entry.op === 'exit_ignore' || entry.op === 'exit_end_tx') {
    return handleGalileoQueueExit(entry, wa, ctx);
  }
  if (entry.op === 'remove') return handleGalileoQueueRemove(entry, wa, ctx);
  if (entry.op === 'remove_all_in_pcc') return handleGalileoQueueRemoveAll(entry, wa, ctx);
  if (!entry.queue) return GalileoResponse.FORMAT;
  if (entry.op === 'access') return handleGalileoQueueAccess(entry, wa, ctx);
  if (entry.op !== 'place') return GalileoResponse.FORMAT;
  const queue = entry.queue;

  // QEB embeds an end-transaction: commit first if no locator. QP
  // requires the BF to be already committed — no implicit commit.
  if (!wa.pnr.locator) {
    if (!entry.endTransaction) {
      // Match the Sabre analog: QP against an in-flight build is rejected
      // until the agent ends or ignores the transaction. The exact
      // Galileo wording isn't in our sources; reuse the reconstructed
      // FINISH OR IGNORE marker the QP cryptic shares with Sabre.
      return 'FINISH OR IGNORE'; // reconstructed
    }
    const commitResp = await commitForQueueEnd(wa, ctx);
    if (commitResp.error) return commitResp.error;
  }
  const locator = wa.pnr.locator!;

  // Live queue placement.
  if (ctx.backend instanceof LiveTravelportBackend) {
    try {
      await ctx.backend.placeOnQueue(locator, queue);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }

  // Emulated mirror: append the locator to the shared backend.queues map.
  const list = ctx.backend.queues.get(queue) ?? [];
  if (!list.includes(locator)) list.push(locator);
  ctx.backend.queues.set(queue, list);

  return `OK-QUEUE ${queue}`; // reconstructed
}

/**
 * `QR` — Remove the on-screen committed BF from the current queue.
 * Source: Galileo Pocket Guide p.13. Live path POSTs the canonical
 * `AgencyQueueSummary` body to `/queue/queue/remove` (verified verbatim
 * from `APIRef_QueueRemove.htm` 2026-05-29):
 *
 *   {
 *     "@type": "AgencyQueueSummary",
 *     "ReservationIdentifier": { "value": "<locator>" },
 *     "Queue": [{ "value": "<queue>" }]
 *   }
 *
 * Requires both `wa.currentQueue` (set by `Q/<n>` access) and a
 * locator on the on-screen BF — return `FORMAT` otherwise (Mini Guide
 * doesn't quote the rejection wording). Local mirror in
 * `backend.queues` is updated to match. v1: simple QR only; `QRQ/ALL`
 * (remove from all queues) deferred.
 */
async function handleGalileoQueueRemove(
  _entry: QueueEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  const queue = wa.currentQueue;
  const locator = wa.pnr.locator;
  if (!queue || !locator) return GalileoResponse.FORMAT;
  if (ctx.backend instanceof LiveTravelportBackend) {
    try {
      await ctx.backend.removeFromQueue(locator, queue);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }
  const list = ctx.backend.queues.get(queue) ?? [];
  const idx = list.indexOf(locator);
  if (idx !== -1) {
    list.splice(idx, 1);
    ctx.backend.queues.set(queue, list);
  }
  return `OK-QUEUE REMOVE ${queue}`; // reconstructed
}

/**
 * `QRQ/ALL` — Remove the on-screen BF from ALL queues in the agency
 * PCC. Source: Galileo Pocket Guide p.13. Precondition: NOT inside a
 * queue cursor (the source says "cannot be done if in the queue") AND
 * a committed BF is on screen.
 *
 * Queue list is derived from the local `backend.queues` mirror — the
 * union of every queue containing this locator. Server-side queues
 * the local shadow didn't see (e.g. a queue placement that happened
 * outside this session) are missed; v11 has a `QW` cryptic for
 * "queues containing this BF" but no REST equivalent in the
 * endpoints list, so the local view is the best we can do.
 *
 * If the local view shows no queues for this locator, the call is
 * skipped — there's nothing to ask the server to remove. The cryptic
 * still returns `OK-QUEUE REMOVE ALL` for idempotency.
 */
async function handleGalileoQueueRemoveAll(
  _entry: QueueEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  if (wa.currentQueue) return GalileoResponse.FORMAT; // "cannot be done if in the queue"
  const locator = wa.pnr.locator;
  if (!locator) return GalileoResponse.FORMAT;
  const queues: string[] = [];
  for (const [q, locators] of ctx.backend.queues.entries()) {
    if (locators.includes(locator)) queues.push(q);
  }
  if (ctx.backend instanceof LiveTravelportBackend && queues.length > 0) {
    try {
      await ctx.backend.removeFromQueues(locator, queues);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }
  for (const q of queues) {
    const list = ctx.backend.queues.get(q) ?? [];
    const idx = list.indexOf(locator);
    if (idx !== -1) {
      list.splice(idx, 1);
      ctx.backend.queues.set(q, list);
    }
  }
  return 'OK-QUEUE REMOVE ALL'; // reconstructed
}

/**
 * `QX` / `QXI` / `QXE` — Sign out of the queue cursor.
 *
 *  - QX:  pure exit. Clear `wa.currentQueue` and `wa.queueCursor`,
 *         return `OK-QUEUE EXIT`. Work area is untouched.
 *  - QXI: exit + ignore. Routes through the same path as `I` (live
 *         workbench DELETE + reset WA). Returns `IGNORED`.
 *  - QXE: exit + end-tx. Routes through the same path as `E`
 *         (mandatory-field check + commit). Returns the locator.
 *
 * No REST equivalent for the exit itself — pure cursor op. The
 * composed forms reuse the I/E handlers so behaviour stays in sync.
 *
 * `OK-QUEUE EXIT` is reconstructed — Pocket Guide documents the entry
 * forms (`QX`, `QX+I`, `QX+E`) but not the response wording.
 */
async function handleGalileoQueueExit(
  entry: QueueEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  wa.currentQueue = undefined;
  wa.queueCursor = undefined;
  if (entry.op === 'exit_ignore') {
    return handleGalileoIgnore(
      { kind: 'ignore', raw: entry.raw, timestamp: entry.timestamp },
      wa,
      ctx
    );
  }
  if (entry.op === 'exit_end_tx') {
    return handleGalileoEndTransaction(
      { kind: 'end_transaction', raw: entry.raw, timestamp: entry.timestamp, redisplay: false },
      wa,
      ctx
    );
  }
  return 'OK-QUEUE EXIT'; // reconstructed
}

/**
 * `Q/<n>` — Access a queue and display its contents. Live path POSTs
 * `/queue/queue/list` with an `AgencyQueueSummary` body and maps the
 * `QueueList[]` to a `QueueListResult`. Emulated path reads
 * `ctx.backend.queues` (a `Map<queueId, locator[]>`) and joins each
 * locator with the PNR store to populate names/dates.
 *
 * Tracks `wa.currentQueue` so a future `QR` (remove) or `QX` (exit)
 * has the right target. No FSM transition — Q/ is read-only.
 *
 * Empty queue renders `QUEUE <n>  EMPTY` (reconstructed); the Mini
 * Guide documents the entry but not the response screen.
 */
async function handleGalileoQueueAccess(
  entry: QueueEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  const queue = entry.queue!;
  if (ctx.backend instanceof LiveTravelportBackend) {
    try {
      const response = await ctx.backend.listQueue(queue);
      const result = mapQueueList(response, queue);
      wa.currentQueue = queue;
      return renderGalileoQueueList(result);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }
  // Emulated: cross the locator list against the PNR store for name + date.
  const locators = ctx.backend.queues.get(queue) ?? [];
  const items = locators.map((locator) => {
    const pnr = ctx.backend.pnrs.get(locator);
    const lead = pnr?.names[0];
    const surname = lead?.surname ?? '';
    const given = lead?.passengers[0]?.firstName ?? '';
    const name = surname && given ? `${surname}/${given.charAt(0)}` : surname || '';
    const travelDate = pnr?.segments[0]?.date ?? '';
    return { locator, name, travelDate };
  });
  wa.currentQueue = queue;
  return renderGalileoQueueList({ queue, items });
}

/**
 * Run the same commit logic the End-Transaction handler does, but
 * without returning the rendered BF — the QEB response is the queue
 * confirmation, not the BF display. Returns `{ error }` to short-circuit
 * QEB if the commit can't happen.
 */
async function commitForQueueEnd(
  wa: WorkArea,
  ctx: HandlerContext
): Promise<{ error?: string }> {
  const missing = wa.pnr.missingMandatory();
  if (missing.length > 0) return { error: GALILEO_MISSING_RESPONSE[missing[0]] };
  const pax = wa.pnr.passengerCount();
  if (wa.pnr.segments.some((s) => s.seats !== pax)) {
    return { error: GalileoResponse.NAMES_NOT_EQUAL };
  }
  wa.pnr.segments.forEach((s) => {
    if (s.status === 'LL') s.status = 'HL';
  });
  if (ctx.backend instanceof LiveTravelportBackend) {
    if (!wa.liveWorkbenchId) return { error: 'LIVE WORKBENCH MISSING' }; // reconstructed
    let locator: string;
    try {
      locator = await ctx.backend.commitWorkbench(wa.liveWorkbenchId, {
        ticketing: wa.pnr.ticketing,
      });
    } catch (err) {
      return { error: `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}` }; // reconstructed
    }
    wa.pnr.locator = locator;
    ctx.backend.pnrs.commit(wa.pnr);
    wa.liveWorkbenchId = undefined;
  } else {
    wa.pnr.locator = ctx.backend.pnrs.commit(wa.pnr);
  }
  wa.machine.transition(SessionEvent.END_TX);
  return {};
}

/**
 * `DP<n>` — Divide passenger `<n>` from the booking file. Source: Mini
 * Format Guide v2 p.39. v1 is single-shot: live POSTs /reservations/
 * divide; emulated returns OK-DIVIDE without actually splitting the
 * local Pnr (the full multi-step Galileo divide flow — DP<n> → R. →
 * F → R. → E — is a follow-up).
 *
 * Galileo "passenger 2" means overall passenger index across all name
 * elements. The handler validates the index is in range against the
 * current PNR's passenger count.
 */
async function handleGalileoDivide(
  entry: DivideEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  const passenger = entry.refs[0]?.item;
  if (!passenger || passenger < 1) return GalileoResponse.FORMAT;
  if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
  if (passenger > wa.pnr.passengerCount()) return GalileoResponse.FORMAT;

  // Live path: must have a locator (committed or retrieved BF).
  if (ctx.backend instanceof LiveTravelportBackend) {
    if (!wa.pnr.locator) {
      return 'LIVE DIVIDE REQUIRES COMMITTED BF'; // reconstructed
    }
    try {
      await ctx.backend.divideReservation(wa.pnr.locator, [passenger]);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }

  // Emulated path: stub for v1. The full multi-step flow would stash
  // the original PNR on wa.dividedOriginal and switch the active PNR
  // to the divided slice; that's the existing Sabre handleDivide
  // semantics but the Mini Guide's DP<n> is a one-shot. Defer until
  // we have a Galileo-shaped divide test fixture to source against.
  wa.machine.transition(SessionEvent.MODIFY);
  return `OK-DIVIDE P${passenger}`; // reconstructed
}
