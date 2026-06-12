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
  SsrEntry,
  OsiEntry,
  RemarkEntry,
  TicketModifierEntry,
  FareDisplayEntry,
  FareNotesEntry,
} from '../../protocol/entry.js';
import { MANUAL_STATUS_CODES } from '../../protocol/constants.js';
import type { TicketRecord } from '../../models/ticket.js';
import { ticketNumber } from '../../models/ticket.js';
import { priceItinerary } from '../../session/handlers/pricing-handler.js';
import { LiveTravelportBackend } from '../../backends/live-travelport-backend.js';
import { to24h } from '../../utils/validation.js';
import { clonePnr } from '../../store/json-file-pnr-store.js';
import {
  extractSearchIdentifier,
  mapCatalogProductOfferings,
  mapReservation,
  mapPricedOffer,
  mapReceipts,
  extractSegmentOfferIds,
  mapQueueList,
  mapFareDisplay,
} from '../../backends/travelport-mapper.js';
import { isRecordLocator } from '../../models/record-locator.js';
import type { WorkArea } from '../../session/work-area.js';
import type { HandlerContext } from '../../session/handlers/context.js';
import type { AirSegment } from '../../models/segment.js';
import type { FareQuote, PassengerFare } from '../../models/fare.js';
import type { MandatoryFieldKey } from '../../protocol/constants.js';
import { MandatoryField, StatusCode } from '../../protocol/constants.js';
import { parseNameText } from '../../models/name-element.js';
import { SessionEvent } from '../../session/session-state.js';
import { InvalidTransitionError } from '../../session/session-machine.js';
import { dayOfWeekLetter, dayOfWeekNumber } from '../../session/handlers/context.js';
import { renderGalileoFieldDisplay,
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
  renderGalileoFareDisplay,
} from './serializer.js';
import { GalileoResponse } from './responses.js';
import { synthesizeAvailability, SCC_LABELS } from '../../models/seat-map.js';
import { handleSeatRequest } from '../../session/handlers/seat-request-handler.js';
import { renderGalileoHelp } from './help.js';
import { renderStoreStatus } from '../../session/store-status.js';
import { renderMarkets } from '../../session/markets-status.js';
import { renderSeatMap, galileoSeatMapHeader } from '../../render/seat-map-render.js';

export const GALILEO_NOT_IMPLEMENTED = 'NOT IMPLEMENTED — galileo dialect';

/**
 * Trailer appended to responses from verbs that are LOCAL-ONLY BY DESIGN
 * (no v11 REST equivalent) when running against a live backend. The
 * roadmap principle is "silent stubs are worse than an honest
 * boundary" — operators should see immediately when a response
 * reflects only the in-memory PNR shadow, not authoritative server
 * state. Verified 2026-06-06 via the GDS reference-payload devkit:
 * neither `*H` (BF change-log history), `@<n>HK` (segment-status
 * manual override), nor `*-<surname>` (surname-keyed retrieve) have
 * a corresponding endpoint — they're mainframe-era patterns that
 * Travelport's modern REST surface doesn't expose.
 *
 * Emulated backend: no trailer (the local store IS authoritative).
 * Live backend: trailer makes the local-only nature visible.
 */
const LOCAL_ONLY_TRAILER = '[LOCAL VIEW ONLY — no v11 REST equivalent]';

function appendLocalOnlyTrailer(response: string, ctx: HandlerContext): string {
  if (!(ctx.backend instanceof LiveTravelportBackend)) return response;
  // Don't pollute error responses — the operator already gets feedback
  // there, and a trailer on FORMAT/NEED_PNR/etc. adds noise.
  if (response === GalileoResponse.FORMAT || response === GalileoResponse.NO_PNR) {
    return response;
  }
  return `${response}\n${LOCAL_ONLY_TRAILER}`;
}

/**
 * Mirror of `wa.machine.transition(SessionEvent.MODIFY)` that ALSO
 * marks the queue working set's current item dirty when we're in a
 * queue context. QP consults this flag to refuse a navigation that
 * would lose unsaved changes; QPI ignores it and navigates anyway.
 */
function modifyTransition(wa: WorkArea, historyText?: string): void {
  wa.machine.transition(SessionEvent.MODIFY);
  if (wa.currentQueue) wa.queueCurrentDirty = true;
  recordHistory(wa, historyText ?? 'MODIFY');
}

/**
 * Same for SELL — adding a segment to a queue-retrieved BF is also a
 * modification.
 */
function sellTransition(wa: WorkArea, historyText?: string): void {
  wa.machine.transition(SessionEvent.SELL);
  if (wa.currentQueue) wa.queueCurrentDirty = true;
  recordHistory(wa, historyText ?? 'SELL');
}

/**
 * Append a row to `wa.pnr.history[]` — the client-side mutation log
 * `*H` renders. v11 has no change-log REST equivalent so this is the
 * only source. No-op if there's no PNR yet (sign-on / pre-build).
 */
function recordHistory(wa: WorkArea, text: string): void {
  wa.pnr.history.push({ timestamp: new Date(), text, code: historyCodeFor(text) });
}

/**
 * Map a mutation text to its Galileo history code (H/HIST table,
 * verbatim in references/galileo/booking-file-display-options.md).
 * Prefix-keyed off the texts our handlers record. AI ("Added Special
 * Remarks field") is the closest documented add-code for notepads.
 * Mutations without a documented code stay uncoded.
 */
function historyCodeFor(text: string): string | undefined {
  const RULES: [RegExp, string][] = [
    [/^NAME ADD/, 'AN'],
    [/^NAME (CHANGE|DELETE)/, 'XN'],
    [/^(SELL|HOTEL|CAR|RAIL)/, 'AS'],
    [/^CANCEL/, 'XS'],
    [/^STATUS/, 'SC'],
    [/^SSR/, 'AG'],
    [/^OSI/, 'AO'],
    [/^MM ADD/, 'AM'],
    [/^MM DELETE/, 'XM'],
    [/^PHONE (CHANGE|DELETE)/, 'XP'],
    [/^(NP|NOTEPAD)/, 'AI'],
    [/^SEAT CANCEL/, 'SX'],
    [/^SEAT/, 'SA'],
    [/^ADDRESS WRITTEN ADD/, 'AW'],
    [/^ADDRESS WRITTEN (CHANGE|DELETE)/, 'XW'],
    [/^ADDRESS DELIVERY ADD/, 'AA'],
    [/^FOP (CHANGE|DELETE)/, 'FP'],
    [/^QUEUE PLACE/, 'AQ'],
    [/^QUEUE REMOVE/, 'XQ'],
  ];
  for (const [re, code] of RULES) if (re.test(text)) return code;
  return undefined;
}

/**
 * Wrap an ADD_FIELD transition so we get the same history-recording
 * symmetry as MODIFY/SELL. Many handlers call
 * `wa.machine.transition(SessionEvent.ADD_FIELD)` directly today;
 * those sites that want a meaningful audit row can use this helper
 * instead.
 */
function addFieldTransition(wa: WorkArea, historyText: string): void {
  wa.machine.transition(SessionEvent.ADD_FIELD);
  if (wa.currentQueue) wa.queueCurrentDirty = true;
  recordHistory(wa, historyText);
}

export function dispatchGalileo(
  entry: ParsedEntry,
  wa: WorkArea,
  ctx: HandlerContext
): string | Promise<string> {
  // The inner try/catch below only covers SYNCHRONOUS throws — an
  // async handler that throws (e.g. sellTransition firing SELL while
  // SIGNED_OFF inside async handleGalileoSell) surfaces as a REJECTED
  // PROMISE that the sync catch returns un-awaited, crashing the
  // server. Wrap promise results so both paths translate the same
  // way. (Found by a live session: N2F1 before SON killed the
  // start:server process.)
  const result = dispatchGalileoInner(entry, wa, ctx);
  if (result instanceof Promise) {
    return result.catch((err) => {
      if (err instanceof InvalidTransitionError) {
        return 'OUT OF SEQUENCE'; // reconstructed — matches the Sabre placeholder
      }
      throw err;
    });
  }
  return result;
}

function dispatchGalileoInner(
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
        // An air availability display replaces any hotel/car display
        // on screen — N-sells reference air again.
        wa.lastHotelAvail = undefined;
        wa.lastCarAvail = undefined;
        return handleGalileoAvailability(entry, wa, ctx);

      case 'sell':
        // Hotel/car reference sells share the air-sell shape (the
        // Comparison Guide's verbatim rows: hotel `N1A2D3`, car
        // `N1A4`) — disambiguate by display context, same as real
        // hosts: the sell references whatever availability is on
        // screen. A hotel/car display is set by HOA/CAL and cleared
        // by an air availability (and by each other).
        if (entry.mode === 'availability' && (wa.lastHotelAvail || wa.lastCarAvail)) {
          return handleGalileoAuxSell(entry, wa, ctx);
        }
        return handleGalileoSell(entry, wa, ctx);

      case 'hotel':
        return handleGalileoHotel(entry, wa, ctx);

      case 'car':
        return handleGalileoCar(entry, wa, ctx);

      case 'name':
        return handleGalileoName(entry, wa, ctx);

      case 'phone':
        return handleGalileoPhone(entry, wa, ctx);

      case 'ticketing':
        return handleGalileoTicketing(entry, wa);

      case 'received_from':
        return handleGalileoReceivedFrom(entry, wa, ctx);

      case 'end_transaction':
        return handleGalileoEndTransaction(entry, wa, ctx);

      case 'ignore':
        return handleGalileoIgnore(entry, wa, ctx);

      case 'display':
        return handleGalileoDisplay(entry, wa, ctx);

      case 'cancel':
        return handleGalileoCancel(entry, wa, ctx);

      case 'segment_status':
        return handleGalileoSegmentStatus(entry, wa, ctx);

      case 'passive_cancel':
        return handleGalileoPassiveCancel(entry, wa, ctx);

      case 'pricing':
        return handleGalileoPricing(entry, wa, ctx);

      case 'ticket':
        return handleGalileoTicket(entry, wa, ctx);

      case 'flight_info':
        return handleGalileoFlightInfo(entry, wa);

      case 'seat_map':
        return handleGalileoSeatMap(entry, wa, ctx);

      case 'help':
        // MARKETS renders live from the inventory — operators can
        // discover what the emulated seed actually serves instead
        // of guessing city pairs into NO FLIGHTS.
        if (entry.topic === 'MARKETS') {
          return renderMarkets(ctx.backend);
        }
        if (entry.topic === 'STORE') {
          return renderStoreStatus(ctx.backend);
        }
        return renderGalileoHelp(entry.topic);

      case 'seat_request':
        // Cross-dialect handler — same store the Amadeus ST family
        // writes (pnr.seatRequests). Reached by Galileo S., Apollo
        // (unchanged passthrough), and Worldspan 4R via translation.
        return handleSeatRequest(entry, wa, ctx);

      case 'void':
        return handleGalileoVoid(entry, wa, ctx);

      case 'queue':
        return handleGalileoQueue(entry, wa, ctx);

      case 'divide':
        return handleGalileoDivide(entry, wa, ctx);

      case 'ssr':
        return handleGalileoSsr(entry, wa, ctx);

      case 'osi':
        return handleGalileoOsi(entry, wa, ctx);

      case 'remark':
        return handleGalileoRemark(entry, wa, ctx);

      case 'address_field': {
        // W./D. are single fields (one written + one delivery per BF).
        // Stored on the shared AddressElement model: written → kind
        // mailing/subtype standard; delivery → kind mailing/subtype
        // delivery (the Amadeus AM/D convention).
        const subtype = entry.sigil === 'D' ? 'delivery' : 'standard';
        const existing = wa.pnr.addresses.find((a) => a.kind === 'mailing' && (a.subtype === 'delivery') === (subtype === 'delivery'));
        const label = entry.sigil === 'W' ? 'WRITTEN' : 'DELIVERY';
        if (entry.op === 'delete') {
          if (!existing) return GalileoResponse.FORMAT;
          wa.pnr.addresses = wa.pnr.addresses.filter((a) => a !== existing);
          addFieldTransition(wa, `ADDRESS ${label} DELETE`);
          return GalileoResponse.OK;
        }
        if (entry.op === 'change' || entry.op === 'change_subfield') {
          if (!existing) return GalileoResponse.FORMAT;
          if (entry.op === 'change') {
            existing.text = entry.text!;
          } else {
            const parts = existing.text.split('*');
            if (entry.subfield! < 1 || entry.subfield! > parts.length) return GalileoResponse.FORMAT;
            parts[entry.subfield! - 1] = entry.text!;
            existing.text = parts.join('*');
          }
          addFieldTransition(wa, `ADDRESS ${label} CHANGE ${existing.text}`);
          return GalileoResponse.OK;
        }
        if (existing) wa.pnr.addresses = wa.pnr.addresses.filter((a) => a !== existing);
        wa.pnr.addresses.push({ kind: 'mailing', subtype, text: entry.text! });
        addFieldTransition(wa, `ADDRESS ${label} ADD ${entry.text}`);
        return GalileoResponse.OK;
      }

      case 'fop_field': {
        // F. is a single-item BF field (Formats Guide: "Single item
        // field."). Local-only on live: the v11 FOP rides the ticket
        // flow (addFormOfPayment at issuance), not the BF build.
        if (entry.op === 'delete') {
          if (!wa.pnr.fopField) return GalileoResponse.FORMAT;
          wa.pnr.fopField = undefined;
          addFieldTransition(wa, 'FOP DELETE');
          return GalileoResponse.OK;
        }
        if (entry.op === 'change') {
          if (!wa.pnr.fopField) return GalileoResponse.FORMAT;
          wa.pnr.fopField = entry.text;
          addFieldTransition(wa, `FOP CHANGE ${entry.text}`);
          return GalileoResponse.OK;
        }
        wa.pnr.fopField = entry.text;
        addFieldTransition(wa, `FOP ADD ${entry.text}`);
        return GalileoResponse.OK;
      }

      case 'frequent_flyer': {
        // M.<cxr><number> add / M.@ delete-all — webhelp BF-fields
        // compare rows verbatim; response wording reconstructed.
        if (entry.operation === 'delete') {
          wa.pnr.frequentFlyers = [];
          addFieldTransition(wa, 'MM DELETE ALL');
          return GalileoResponse.OK;
        }
        wa.pnr.frequentFlyers.push({ carrier: entry.carrier!, number: entry.number! });
        addFieldTransition(wa, `MM ADD ${entry.carrier}${entry.number}`);
        return GalileoResponse.OK;
      }

      case 'ticket_modifier':
        return handleGalileoTicketModifier(entry, wa);

      case 'fare_display':
        return handleGalileoFareDisplay(entry, wa, ctx);

      case 'fare_notes':
        return handleGalileoFareNotes(entry, wa, ctx);

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
  let searchIdentifier: string | undefined;
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
      searchIdentifier = extractSearchIdentifier(response);
      // Passive market learning — feeds the live HELP MARKETS view.
      ctx.backend.recordObservedMarket(
        entry.origin!,
        entry.destination!,
        lines.map((l) => l.carrier),
      );
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
    searchIdentifier,
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
  let legs = entry.legs ?? [{ bookingClass: entry.bookingClass, line: entry.line! }];

  // `N1Y1*` — expand to the referenced line's full connection group,
  // same class on every leg (mirrors the Sabre 0Y1* expansion in
  // pnr-build-handler.ts).
  if (entry.connectionStar) {
    const first = avail.lines.find((l) => l.line === legs[0].line);
    if (!first) return GalileoResponse.FORMAT;
    if (first.connectionGroup == null) return 'NOT A CONNECTION'; // reconstructed
    legs = avail.lines
      .filter((l) => l.connectionGroup === first.connectionGroup)
      .sort((a, b) => (a.legIndex ?? 0) - (b.legIndex ?? 0))
      .map((l) => ({ bookingClass: legs[0].bookingClass, line: l.line }));
  }

  // LIVE auto-expansion: under the JSON API the booking unit is the
  // OFFER — a connection option's legs are ONE CatalogProductOffering,
  // so "selling half an offer" is unrepresentable. addOffer books the
  // whole journey no matter which leg's line the entry references
  // (dogfooding find 2026-06-12: N1N27 then N1N28 hit the pre-prod
  // duplicate-offer rejection, with the local mirror holding only leg
  // 1 while the server already held both flights). Expand every leg
  // to its full connection group so the local mirror matches what the
  // server will hold. Emulated keeps the real host's per-line sell.
  if (ctx.backend instanceof LiveTravelportBackend) {
    const expanded: typeof legs = [];
    const seenLines = new Set<number>();
    for (const leg of legs) {
      const line = avail.lines.find((l) => l.line === leg.line);
      if (!line) return GalileoResponse.FORMAT;
      const group =
        line.connectionGroup == null
          ? [line]
          : avail.lines
              .filter((l) => l.connectionGroup === line.connectionGroup)
              .sort((a, b) => (a.legIndex ?? 0) - (b.legIndex ?? 0));
      for (const l of group) {
        if (!seenLines.has(l.line)) {
          seenLines.add(l.line);
          expanded.push({ bookingClass: leg.bookingClass, line: l.line });
        }
      }
    }
    legs = expanded;
  }

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
  // addOffer needs THREE identifiers: the search-transaction
  // identifier (one per availability cache), plus per-leg offerId +
  // productId on each AvailabilityLine.vendorRef. Refuse cleanly if
  // any are missing rather than POSTing an invalid body.
  if (ctx.backend instanceof LiveTravelportBackend) {
    const liveBackend = ctx.backend;
    if (wa.pnr.locator) return retrievedBfLiveModifyRefusal(wa.pnr.locator);
    if (!avail.searchIdentifier) return 'LIVE SEARCH ID MISSING'; // reconstructed
    for (const leg of legs) {
      const line = avail.lines.find((l) => l.line === leg.line)!;
      if (!line.vendorRef?.offerId) return 'LIVE OFFER ID MISSING'; // reconstructed
      if (!line.vendorRef?.productId) return 'LIVE PRODUCT ID MISSING'; // reconstructed
    }
    try {
      if (!wa.liveWorkbenchId) {
        wa.liveWorkbenchId = await liveBackend.createWorkbench();
      }
      // Connection legs share the same offer + product (a single
      // CatalogProductOffering covers the whole journey including all
      // its segments). Posting addOffer twice with the same
      // (offerId, productId) pair triggers pre-prod's "OFFER ID AND
      // PRODUCT ID CANNOT BE DUPLICATE WHEN ADDING AN OFFER TO THE
      // BOOKING" — so dedupe by the pair and only POST once per
      // unique offer. wa.liveWorkbenchOfferIds still gets one entry
      // per leg (same UUID repeated for connection legs) so
      // downstream per-leg SSR / cancel can index it cleanly.
      // Pre-flight duplicate guard (cross-entry): the offer pair may
      // already be in the booking from an earlier sell — e.g. the
      // auto-expanded other leg of this connection. Refuse locally
      // rather than burning a vendor call on the server's
      // duplicate-offer rejection. Polite-citizen + discoverable.
      const postedKeys = wa.livePostedOfferKeys ?? new Set<string>();
      for (const leg of legs) {
        const line = avail.lines.find((l) => l.line === leg.line)!;
        const key = `${line.vendorRef!.offerId!}|${line.vendorRef!.productId!}`;
        if (postedKeys.has(key)) {
          return 'OFFER ALREADY IN BOOKING - SEE SEGMENTS SOLD ABOVE'; // reconstructed
        }
      }
      const wbOfferIds = wa.liveWorkbenchOfferIds ?? [];
      const posted = new Map<string, string>(); // (offerId|productId) → workbench UUID
      for (const leg of legs) {
        const line = avail.lines.find((l) => l.line === leg.line)!;
        const offerId = line.vendorRef!.offerId!;
        const productId = line.vendorRef!.productId!;
        const key = `${offerId}|${productId}`;
        let wbUuid = posted.get(key);
        if (wbUuid === undefined) {
          const result = await liveBackend.addOffer(wa.liveWorkbenchId, {
            searchIdentifier: avail.searchIdentifier,
            offerId,
            productId,
          });
          wbUuid = result.workbenchOfferId ?? '';
          posted.set(key, wbUuid);
        }
        wbOfferIds.push(wbUuid);
        postedKeys.add(key);
      }
      wa.liveWorkbenchOfferIds = wbOfferIds;
      wa.livePostedOfferKeys = postedKeys;
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }

  const sellSummary = legs
    .map((leg) => {
      const f = avail.lines.find((l) => l.line === leg.line)!;
      return `${f.carrier}${f.flightNumber}${leg.bookingClass}`;
    })
    .join(' ');
  sellTransition(wa, `SELL ${entry.seats} ${sellSummary}`);
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
    if (ctx.backend instanceof LiveTravelportBackend && line.vendorRef?.offerId && line.vendorRef?.productId && avail.searchIdentifier) {
      seg.vendorRef = {
        searchIdentifier: avail.searchIdentifier,
        offerId: line.vendorRef.offerId,
        productId: line.vendorRef.productId,
      };
    }
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
 * Multi-passenger names (`N.SMITH/JOHN MR/JANE MRS/...`) post to the
 * `/travelers/list` batch endpoint when more than one passenger is
 * present — one round-trip instead of N. Single-passenger names use
 * the singular `/travelers` endpoint to keep the body shape minimal.
 */
/**
 * Post addTraveler / addTravelers to the live workbench iff we have
 * BOTH a name (pnr.names) AND a phone — Travelport's commit rejects
 * Travelers without an embedded `Telephone[]` ("TELEPHONE IS A
 * REQUIRED FIELD"), and Galileo cryptic separates `N.` from `P.`.
 * Idempotent on the (name count, traveler IDs captured) pair:
 *   - 0 names → noop (wait for first N.)
 *   - 0 phone → noop (wait for P.)
 *   - all names already posted (length matches) → noop
 *   - some new names since last post → post just the delta (the
 *     names added AFTER the previous post), append the returned
 *     traveler IDs to `wa.liveTravelerIds`. Batches when the delta
 *     has >1 passenger, singular otherwise.
 *
 * Call from both N. and P. handlers; from N. the new name rides
 * along in `extraNames` so we don't have to mutate `pnr.names`
 * before the live call (which would leak local state on a live
 * error).
 */
async function ensureLiveTravelersPosted(
  wa: WorkArea,
  backend: LiveTravelportBackend,
  phoneOverride?: string,
  extraNames?: ReturnType<typeof parseNameText>[]
): Promise<void> {
  const phone = phoneOverride ?? wa.pnr.phones[0]?.number;
  if (!phone) return;
  // Compose the name list from already-saved pnr.names + any
  // not-yet-pushed names handed in via extraNames.
  const allNames = [...wa.pnr.names, ...(extraNames ?? [])];
  if (allNames.length === 0) return;
  const allTravelers = allNames.flatMap((nameItem) =>
    nameItem.passengers.map((pax) => ({
      givenName: pax.firstName,
      surname: nameItem.surname,
      phone,
    }))
  );
  const alreadyPosted = wa.liveTravelerIds?.length ?? 0;
  if (allTravelers.length === alreadyPosted) return; // already current
  const newTravelers = allTravelers.slice(alreadyPosted);
  if (newTravelers.length === 0) return;
  if (!wa.liveWorkbenchId) {
    wa.liveWorkbenchId = await backend.createWorkbench();
  }
  const prevIds = wa.liveTravelerIds ?? [];
  let newIds: string[];
  if (newTravelers.length > 1) {
    const result = await backend.addTravelers(wa.liveWorkbenchId, newTravelers);
    newIds = result.travelerIds;
  } else {
    const result = await backend.addTraveler(wa.liveWorkbenchId, newTravelers[0]);
    newIds = [result.travelerId ?? ''];
  }
  wa.liveTravelerIds = [...prevIds, ...newIds];
}

async function handleGalileoName(
  entry: NameEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  const nameItem = parseNameText(entry.text);

  if (ctx.backend instanceof LiveTravelportBackend) {
    if (wa.pnr.locator) return retrievedBfLiveModifyRefusal(wa.pnr.locator);
    const liveBackend = ctx.backend;
    try {
      // Ensure a workbench exists so future entries (sell, SSR, FQ)
      // can address one. addTraveler itself is deferred until P. is
      // also present — see ensureLiveTravelersPosted. We pass an
      // extra name via the override so the helper can include it in
      // the post without us having to push to wa.pnr.names first
      // (which would leak local state on a live error).
      if (!wa.liveWorkbenchId) {
        wa.liveWorkbenchId = await liveBackend.createWorkbench();
      }
      await ensureLiveTravelersPosted(wa, liveBackend, undefined, [nameItem]);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }

  const nameSummary = nameItem.passengers
    .map((p) => `${nameItem.surname}/${p.firstName}`)
    .join(' ');
  addFieldTransition(wa, `NAME ADD ${nameSummary}`);
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
    if (wa.pnr.locator) return retrievedBfLiveModifyRefusal(wa.pnr.locator);
    const liveBackend = ctx.backend;
    try {
      if (!wa.liveWorkbenchId) {
        wa.liveWorkbenchId = await liveBackend.createWorkbench();
      }
      // Post deferred Traveler(s) first (canonical workflow: Traveler
      // before PrimaryContact), then the PrimaryContact. Pass the
      // phone explicitly so we don't have to mutate wa.pnr.phones
      // before the live call (which would leak local state on failure).
      await ensureLiveTravelersPosted(wa, liveBackend, entry.text);
      await liveBackend.addPrimaryContact(wa.liveWorkbenchId, entry.text);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }

  addFieldTransition(wa, `PHONE ADD ${entry.text}`);
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
  addFieldTransition(wa, `T. ${entry.text}`);
  wa.pnr.ticketing = entry.text;
  return GalileoResponse.OK;
}

/**
 * `R.<rest>` — received-from field. Mini Guide v2 p.16: `R.AGT`,
 * `R.YY` (agent initials).
 *
 * Live REST: OAuth Bearer token already identifies the agent for
 * audit purposes — that's the canonical `R.` posture. Under the
 * polite-citizen opt-in (`LiveTravelportBackendOptions.
 * politeReceivedFromAudit = true`), R. additionally POSTs the
 * received-from text to the workbench's `/reservationcomments/list`
 * with `commentSource: "Agency"` so the identifier surfaces in the
 * BF body where other agents reviewing the file see it. Failure on
 * the polite-citizen POST is non-fatal: the local `receivedFrom` is
 * still set and a `LIVE BACKEND ERROR` returned (consistent with
 * other live ops' failure-surfaces-but-local-still-good pattern).
 */
async function handleGalileoReceivedFrom(
  entry: ReceivedFromEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  if (
    ctx.backend instanceof LiveTravelportBackend &&
    wa.liveWorkbenchId &&
    ctx.backend.politeReceivedFromAudit
  ) {
    try {
      await ctx.backend.addReservationComment(wa.liveWorkbenchId, `R. ${entry.text}`, {
        kind: 'notepad',
      });
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }
  addFieldTransition(wa, `R. ${entry.text}`);
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
/**
 * Live guard — the on-screen BF is a RETRIEVED committed one.
 * Building against it would open a blank workbench (not
 * buildfromlocator) and ER would commit that as a phantom NEW BF
 * duplicating fields. The correct live modify flow
 * (buildfromlocator) is deferred; until it lands we refuse honestly.
 * Dogfooding find (2026-06-12 log): the operator's R. + ER dance on
 * a queue-retrieved BF walked straight into this trap. Reconstructed.
 */
function retrievedBfLiveModifyRefusal(locator: string): string {
  return `BF ${locator} IS COMMITTED - LIVE MODIFY NOT SUPPORTED - USE I TO RELEASE`; // reconstructed
}

/**
 * Emulated retrieve: hand the work area a detached working copy of
 * the stored BF, with received-from stripped. Parity with the live
 * oracle (2026-06-12 session log): a freshly pulled BF never carries
 * R. — it's per-transaction, so every retrieve demands a fresh one
 * before ER. The clone also stops on-screen edits from writing
 * through to the store before commit.
 */
function retrieveStoredBf(ctx: HandlerContext, locator: string): Pnr | undefined {
  const stored = ctx.backend.pnrs.get(locator);
  if (!stored) return undefined;
  const pnr = clonePnr(stored);
  pnr.receivedFrom = undefined;
  return pnr;
}

const GALILEO_MISSING_RESPONSE: Record<MandatoryFieldKey, string> = {
  [MandatoryField.PHONE]: GalileoResponse.NEED_PHONE,
  [MandatoryField.RECEIVED_FROM]: GalileoResponse.NEED_RECEIVED_FROM,
  [MandatoryField.ITINERARY]: GalileoResponse.NEED_ITINERARY,
  [MandatoryField.NAME]: GalileoResponse.NEED_NAME,
  [MandatoryField.TICKETING]: GalileoResponse.NEED_TICKETING,
};

/**
 * `I` (ignore) / `IR` (ignore + retrieve). Two semantic modes:
 *
 * **Queue context** (`wa.currentQueue` + working set populated). Per
 * Travelport Smartpoint Cloud Help (verbatim 2026-05-29):
 *   I  "Return booking file to the bottom of the queue"
 * The current BF goes to the END of its queue (local mirror updated;
 * working set advances cursor + loads next BF). At end of working
 * set: return `QUEUE <n> EMPTY` and exit queue context. No workbench
 * DELETE — there's no in-flight workbench when navigating a queue.
 * `IR` in queue context falls through to the same path (no separate
 * re-retrieve semantic).
 *
 * **Non-queue context** (Mini Format Guide v2 p.17):
 *  - Live: send polite-citizen `DELETE .../reservationworkbench/{wb}`
 *    if a workbench is open. Failures are swallowed (server's 30-min
 *    TTL would clean up anyway); the cryptic still returns `IGNORED`.
 *  - Clear the work area + transition IGNORE.
 *  - `IR` then re-retrieves whatever locator was on screen before —
 *    same code path as `*<locator>`. If there was no locator (mid-
 *    build with no prior retrieve), IR degrades to plain I.
 */
async function handleGalileoIgnore(
  entry: IgnoreEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  // Queue-context branch: I = return current BF to bottom of queue
  // + advance cursor to next.
  if (
    wa.currentQueue &&
    wa.queueWorkingSet &&
    wa.queueCursor != null &&
    wa.queueWorkingSet[wa.queueCursor]
  ) {
    return handleGalileoIgnoreInQueue(wa, ctx);
  }

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
    const pnr = retrieveStoredBf(ctx, priorLocator);
    if (!pnr) return GalileoResponse.NO_PNR;
    wa.pnr = pnr;
    wa.machine.transition(SessionEvent.RETRIEVE);
    return renderGalileoPnr(pnr, sig);
  }
  return GalileoResponse.IGNORED;
}

/**
 * `I` inside a queue context: per Smartpoint Cloud, "Return booking
 * file to the bottom of the queue" — i.e. requeue the current BF to
 * the END of its queue, then advance to the next BF on screen.
 *
 * Live path: POST `/queue/queue` to place this locator back on the
 * current queue (it gets appended). The current item is also dropped
 * from the LOCAL working set (so we don't see it again this pass)
 * and the local mirror is updated to reflect the new "at the bottom"
 * position. Cursor stays where it is (since we removed the item at
 * the cursor, the next item slides in).
 *
 * End of working set: return `QUEUE <n> EMPTY` and exit queue
 * context (clear `currentQueue`, `queueCursor`, working set).
 */
async function handleGalileoIgnoreInQueue(
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  const queue = wa.currentQueue!;
  const set = wa.queueWorkingSet!;
  const cursor = wa.queueCursor!;
  const currentLocator = set[cursor];

  // Live: requeue (append) via place. Failures still let local mirror
  // advance — the BF stays where it was server-side, agent will get
  // it again on a re-access.
  if (ctx.backend instanceof LiveTravelportBackend) {
    try {
      await ctx.backend.placeOnQueue(currentLocator, [{ value: queue }]);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }

  // Local mirror: move currentLocator from its current position to the
  // bottom of the queue. The mirror is a flat locator[] regardless of
  // backend; safe to splice + push.
  const mirror = ctx.backend.queues.get(queue) ?? [];
  const mIdx = mirror.indexOf(currentLocator);
  if (mIdx !== -1) {
    mirror.splice(mIdx, 1);
    mirror.push(currentLocator);
    ctx.backend.queues.set(queue, mirror);
  }

  // Working-set advance: drop the current item; cursor stays — the
  // next item slid into position.
  set.splice(cursor, 1);

  if (set.length === 0) {
    // Queue worked through — exit queue context.
    wa.currentQueue = undefined;
    wa.queueCursor = undefined;
    wa.queueWorkingSet = undefined;
    return `QUEUE ${queue} EMPTY`; // reconstructed
  }

  if (cursor >= set.length) {
    // We were at the last item; cursor now past end. Reset to 0
    // (wrap to front) — agent works the (now-shorter) queue from top.
    wa.queueCursor = 0;
  }

  return loadQueueBfAtCursor(wa, ctx);
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
    if (wa.pnr.locator) {
      // Retrieved committed BF on screen — any open workbench here is
      // a stray build one, NOT a buildfromlocator modify workbench;
      // committing it would mint a phantom new BF. Refuse.
      return retrievedBfLiveModifyRefusal(wa.pnr.locator);
    }
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

  // If TKP filed local ticket records during build, run the canonical
  // post-commit ticket-issuance dance against the just-committed BF:
  // buildfromlocator → addFOP → applyPayment → commit-again. Failures
  // are non-fatal — the BF is committed; we just don't get server-side
  // tickets, which is the same state as not running TKP at all.
  if (committed.tickets.length > 0 && committed.priceQuotes.length > 0) {
    try {
      await issueTicketsPostCommit(backend, locator, committed.priceQuotes[committed.priceQuotes.length - 1]);
    } catch (err) {
      console.warn(
        `Galileo live ticket issuance failed post-commit: ${err instanceof Error ? err.message : String(err)} (BF ${locator} is committed, just unticketed)`
      );
    }
  }

  wa.machine.transition(SessionEvent.END_TX);
  wa.reset();
  return entry.redisplay ? renderGalileoPnr(committed, { pcc: ctx.pcc, agent }) : locator;
}

/**
 * Post-commit ticket issuance per the devkit's "5 - Ticket" canonical
 * flow. Opens a fresh workbench from the committed locator (which
 * surfaces the BF's actual offer UUIDs in the response), adds the
 * FOP, applies a Payment binding the FOP to those offers, then
 * commits the workbench. Each step is required: the apply-payment
 * step is what actually triggers ticket creation server-side.
 *
 * Errors propagate to the caller so the post-commit log can record
 * "BF committed, ticket issuance failed" without disturbing the
 * already-committed BF.
 */
async function issueTicketsPostCommit(
  backend: LiveTravelportBackend,
  locator: string,
  fq: FareQuote
): Promise<void> {
  const dumpEnabled = process.env.TVP_DEBUG_DUMP === '1';
  const dump = async (label: string, data: unknown) => {
    if (!dumpEnabled) return;
    try {
      const fs = await import('node:fs/promises');
      await fs.writeFile(
        `./tvp-diag-ticket-${label}.json`,
        JSON.stringify(data, null, 2),
        'utf8'
      );
    } catch {
      // best-effort
    }
  };
  const opened = await backend.openWorkbenchFromLocator(locator);
  const newWorkbenchId = opened.workbenchId;
  await dump('1-buildfromlocator', { workbenchId: newWorkbenchId, raw: opened.raw });
  // Extract the committed BF's offer UUIDs from the buildfromlocator
  // response. The post-commit workbench gives us a fresh set of offer
  // identifiers we use in applyPayment's OfferIdentifier[] field.
  const raw = opened.raw as any;
  const reservation =
    raw?.ReservationResponse?.Reservation ??
    raw?.Reservation ??
    raw;
  const offersRaw = reservation?.Offer;
  const offers = Array.isArray(offersRaw) ? offersRaw : offersRaw ? [offersRaw] : [];
  const offerUuids: string[] = [];
  for (const offer of offers) {
    const uuid = (offer as any)?.Identifier?.value;
    if (typeof uuid === 'string' && uuid.length > 0) offerUuids.push(uuid);
  }
  if (offerUuids.length === 0) return; // nothing to pay for — drop quietly
  // Extract traveler ids from the buildfromlocator response — we need
  // these to set commission per traveler (the next step). They live
  // at Reservation.Traveler[].id in pre-prod responses (e.g.
  // "travelerRefId_1"); fall back to Identifier.value if the local id
  // is missing.
  const travelerIds: string[] = [];
  for (const t of Array.isArray(reservation?.Traveler) ? reservation.Traveler : reservation?.Traveler ? [reservation.Traveler] : []) {
    const tid = (t as any)?.id ?? (t as any)?.Identifier?.value;
    if (typeof tid === 'string' && tid.length > 0) travelerIds.push(tid);
  }
  // Set commission FIRST. Travelport's ticket-issuance commit rejects
  // with "COMMISSION PERCENTAGE MUST BE ENTERED" if no commission is
  // recorded on the workbench, even for cash bookings without agency
  // commission. The TravelerIdentifierRef[].id field is the LOCAL
  // traveler id (e.g. "travelerRefId_1"), captured from the
  // buildfromlocator response. Also setting it on the BUILD workbench
  // at TKP time, but pre-prod may treat post-commit-set commissions
  // differently — belt-and-suspenders covers both.
  if (travelerIds.length > 0) {
    try {
      const commissionResp = await backend.setCommissionPercent(newWorkbenchId, {
        travelerIds,
        percent: 0,
      });
      await dump('2a-setcommission', { travelerIds, response: commissionResp });
    } catch (err) {
      await dump('2a-setcommission-error', { travelerIds, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }
  const fopResult = await backend.addFormOfPayment(
    newWorkbenchId,
    fq.fop ?? { kind: 'cash' }
  );
  await dump('2b-addfop', { fopUuid: fopResult.fopUuid, raw: fopResult.raw });
  if (!fopResult.fopUuid) return; // can't reference the FOP — abort
  const total = fq.passengers.reduce((sum, pf) => sum + pf.total * pf.count, 0);
  const applyResp = await backend.applyPayment(newWorkbenchId, {
    fopUuid: fopResult.fopUuid,
    offerUuids,
    amount: total,
    currency: fq.currency || 'USD',
  });
  await dump('3-applypayment', { offerUuids, amount: total, currency: fq.currency, response: applyResp });
  // Pre-ticket review — devkit's Step 4. Passive GET of the workbench
  // state. The devkit explicitly lists this between applyPayment and
  // the final commit; Travelport's workflow may use the GET as an
  // internal checkpoint that readies the workbench for ticket
  // issuance (some workflows do this — the GET puts a session marker
  // that the next commit reads). Failures here are non-fatal — we
  // proceed to the commit and let it decide.
  try {
    const reviewResp = await backend.getWorkbench(newWorkbenchId);
    await dump('4-preticketreview', reviewResp);
  } catch (err) {
    await dump('4-preticketreview-error', { error: err instanceof Error ? err.message : String(err) });
  }
  // Commit the post-commit workbench with the CANONICAL flat ticket-
  // issuance body (`forTicketIssuance: true` switches from our wrapped
  // build-commit shape to `{ "@type": "ReservationQueryCommitReservation" }`
  // per the devkit's Step 5). The build-commit body shape that pre-prod
  // accepts for ER might silently skip ticket creation here. We don't
  // need the returned locator — it's the same as the input one (the
  // workbench cancel-and-recommit pattern keeps the locator stable).
  try {
    const finalLocator = await backend.commitWorkbench(newWorkbenchId, { forTicketIssuance: true });
    await dump('5-finalcommit', { finalLocator });
  } catch (err) {
    await dump('5-finalcommit-error', { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
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
const histCodeIn = (...codes: string[]) => (h: { code?: string }) => codes.includes(h.code ?? '');
const histTextIs = (re: RegExp) => (h: { text: string }) => re.test(h.text);

/** History subsets — Formats Guide H/DIH + H/DCDH tables (in-tree). */
const HISTORY_SUBSETS: Record<string, { title: string; pred: (h: { code?: string; text: string }) => boolean }> = {
  HI: { title: 'ITINERARY', pred: histCodeIn('AS', 'XS', 'SC', 'HS') },
  HIA: { title: 'AIR', pred: (h) => histCodeIn('AS', 'XS', 'SC')(h) && !/^(HOTEL|CAR|RAIL)/.test(h.text) },
  HIH: { title: 'HOTEL', pred: histTextIs(/^HOTEL/) },
  HIC: { title: 'CAR', pred: histTextIs(/^CAR/) },
  HIN: { title: 'NON-AIR', pred: histTextIs(/^(HOTEL|CAR|RAIL)/) },
  HN: { title: 'NAME', pred: histCodeIn('AN', 'XN') },
  HP: { title: 'PHONE', pred: histTextIs(/^PHONE/) },
  HMM: { title: 'MILEAGE MEMBERSHIP', pred: histCodeIn('AM', 'XM') },
  HSR: { title: 'SSR', pred: histCodeIn('AG', 'XG') },
  HSO: { title: 'OSI', pred: histCodeIn('AO', 'XO') },
  HSI: { title: 'SERVICE INFORMATION', pred: histCodeIn('AG', 'XG', 'AO', 'XO') },
  HTD: { title: 'TICKETING', pred: histTextIs(/^T\. /) },
  HF: { title: 'FORM OF PAYMENT', pred: (h) => (h.code === 'FP') || /^FOP/.test(h.text) },
  HAD: { title: 'WRITTEN ADDRESS', pred: histCodeIn('AW', 'XW') },
  HQT: { title: 'QUEUE TRAIL', pred: histCodeIn('AQ', 'XQ') },
};

/**
 * Resolve one token of a combination display (`*N.I`, `*N.SI.VR`,
 * `*N.I+*HIA.SI` — Formats Guide "Combination of Display Entries").
 * Returns undefined for unknown tokens so the caller can reject the
 * whole chain (combinations are all-or-nothing).
 */
function resolveDisplayToken(token: string, wa: WorkArea, sig: GalileoSignature): string | undefined {
  if (token === 'R') return renderGalileoPnr(wa.pnr, sig);
  if (token === 'I') return renderGalileoItinerary(wa.pnr);
  if (token === 'IA' || token === 'IH' || token === 'IC' || token === 'IN') {
    return renderGalileoItinerary(wa.pnr, token.slice(1) as 'A' | 'H' | 'C' | 'N');
  }
  const field = renderGalileoFieldDisplay(wa.pnr, sig, token);
  if (field !== undefined) return field;
  const sub = HISTORY_SUBSETS[token];
  if (sub) return renderHistoryLog(wa, sub);
  return undefined;
}

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
  // Combination chains — Formats Guide "Combination of Display
  // Entries" (`*N.I`, `*N.SI.VR`) and "Combination of Active and
  // Historical Displays" (`*N.I+*HIA.SI`). Dot-joined tokens within
  // a group, `+`-joined groups; all-or-nothing (an unknown token
  // falls through to the other *-forms — locators, PQ-, TE/, -name).
  if (/[.+]/.test(arg) && !/^-|^PQ-|^TE/.test(arg.toUpperCase())) {
    // `+`-joined groups each carry their own leading `*` (the entry
    // was `*N.I+*HIA.SI`); strip it before tokenizing on dots.
    const tokens = arg
      .toUpperCase()
      .split('+')
      .flatMap((g) => g.replace(/^\*/, '').split('.'));
    if (tokens.length > 1 && tokens.every((t) => t.length > 0)) {
      const bodies = tokens.map((t) => resolveDisplayToken(t, wa, sig));
      if (bodies.every((b) => b !== undefined)) {
        if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
        return (bodies as string[]).join('\n');
      }
    }
  }

  // `*IA`/`*IH`/`*IC`/`*IN` — typed itinerary slices (H/BFD table).
  // *IS/*IT/*IX (surface/tour/air-taxi) — segment types we don't
  // model; honest empty.
  {
    const sliceKey = { IA: 'A', IH: 'H', IC: 'C', IN: 'N' }[arg.toUpperCase() as string];
    if (sliceKey) {
      if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
      return renderGalileoItinerary(wa.pnr, sliceKey as 'A' | 'H' | 'C' | 'N');
    }
    if (['IS', 'IT', 'IX'].includes(arg.toUpperCase())) {
      if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
      const what = { IS: 'SURFACE', IT: 'TOUR', IX: 'AIR TAXI' }[arg.toUpperCase() as string];
      return `NO ${what} SEGMENTS`; // reconstructed — segment types not modeled
    }
  }

  // `*RI<n>` / `*RI/S<n>` — itinerary-remark selectors (Formats
  // Guide H/BFD rows: "Display Itinerary Remark 3" / "related to
  // segment 1"). The bare *RI/*RIA/*RIU forms ride the field-display
  // arm below.
  {
    const riSel = /^RI(?:(\d+)|\/S(\d+))$/.exec(arg.toUpperCase());
    if (riSel) {
      if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
      const all = wa.pnr.remarks.filter((r) => r.type === 'itinerary');
      if (riSel[1]) {
        const r = all[Number(riSel[1]) - 1];
        return r ? `RI. ${riSel[1]}${r.segment != null ? ' S' + r.segment : ''} ${r.text}` : 'NO ITINERARY REMARKS';
      }
      const rows = all.filter((r) => r.segment === Number(riSel[2]));
      return rows.length
        ? rows.map((r, i) => `RI. ${i + 1} S${r.segment} ${r.text}`).join('\n')
        : 'NO ITINERARY REMARKS';
    }
  }

  // `*<field>` — Booking File field displays per the Formats Guide
  // H/BFD table (references/galileo/booking-file-display-options.md).
  // Checked before the history family so *NP/*SD/*SI resolve here;
  // keys that aren't field displays fall through.
  {
    const fieldKey = arg.toUpperCase();
    const body = renderGalileoFieldDisplay(wa.pnr, sig, fieldKey);
    if (body !== undefined) {
      if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
      return body;
    }
  }

  // `*SVC` / `*SVC<n>` — "Display Services for all booked segments /
  // for segment n" (Formats Guide H/BFD row; the Pocket Guide's
  // timetable chapter carries the same two rows as "In-flight
  // service"). Layout reconstructed from real model data only:
  // flight identity + equipment (inventory schedule, when known) +
  // computed flight time. No meal/amenity data is invented.
  {
    const svcMatch = /^SVC(\d+)?$/.exec(arg.toUpperCase());
    if (svcMatch) {
      if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
      const segs = svcMatch[1]
        ? wa.pnr.segments.filter((x) => x.segmentNumber === Number(svcMatch[1]))
        : wa.pnr.segments;
      if (svcMatch[1] && segs.length === 0) return 'SEGMENT NOT IN ITINERARY';
      if (segs.length === 0) return 'NO AIR SEGMENTS';
      const lines = segs.map((x) => {
        const sched = ctx.backend.inventory.scheduleFor(x.carrier, x.flightNumber);
        const eqp = sched ? `  EQP ${sched.equipment}` : '';
        const dep = to24h(x.departTime);
        const arr = to24h(x.arriveTime ?? '');
        let flt = '';
        if (/^\d{4}$/.test(dep) && /^\d{4}$/.test(arr)) {
          let mins = (Number(arr.slice(0, 2)) * 60 + Number(arr.slice(2))) - (Number(dep.slice(0, 2)) * 60 + Number(dep.slice(2)));
          if (mins < 0) mins += 24 * 60;
          flt = `  FLT TIME ${Math.floor(mins / 60)}HR${String(mins % 60).padStart(2, '0')}`;
        }
        return `SVC ${x.segmentNumber}. ${x.carrier}${x.flightNumber} ${x.bookingClass} ${x.date} ${x.origin}${x.destination}${eqp}${flt}`;
      });
      return lines.join('\n');
    }
  }

  // `*HTI` / `*HTE` — display ticket numbers / etickets. Source: Mini
  // Format Guide v2 p.53. Live path GETs /receipts; emulated reads the
  // local TicketRecord[]. Both render via renderGalileoTicketList.
  if (arg.toUpperCase() === 'HTI' || arg.toUpperCase() === 'HTE') {
    return ticketListGalileo(wa, ctx);
  }

  // `*H` family — history display (Mini Format Guide v2):
  //   *H    entire history
  //   *HI   itinerary history (incl. Hotel/Car — we only model Air)
  //   *HIA  air segment history
  //   *HFF  filed fares history
  //   *HNP  notepad history
  //
  // v11 REST has NO endpoint for itinerary / name / remark / filed-fare
  // change-log history. The only history endpoint is
  // `POST /documents/history` and it's ticket-scoped (TKT/MCO/EMD/INV).
  // So our v1 dispatch returns the *current* state of the relevant
  // sub-section as a stand-in for "history" — flagged here and in the
  // spec doc. Once a true change-log source materializes (or we
  // shadow it client-side) the rendering surface stays stable.
  const upper = arg.toUpperCase();
  if (upper === 'H') return appendLocalOnlyTrailer(historyAllGalileo(wa), ctx);
  // History subsets (Formats Guide H/DIH + H/DCDH tables, in-tree).
  // When a client-side mutation log exists, filter it by history
  // code / mutation text; with no log, *HI/*HIA keep the legacy
  // current-state stand-in. Hotel/car/rail rows all carry code AS —
  // the per-type itinerary slices discriminate on the text.
  {
    const sub = HISTORY_SUBSETS[upper];
    if (sub) {
      if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
      if (wa.pnr.history.length === 0 && (upper === 'HI' || upper === 'HIA')) {
        return appendLocalOnlyTrailer(historyItineraryGalileo(wa), ctx);
      }
      return appendLocalOnlyTrailer(renderHistoryLog(wa, sub), ctx);
    }
  }
  if (upper === 'HFF') return appendLocalOnlyTrailer(historyFiledFaresGalileo(wa), ctx);
  if (upper === 'HNP') return appendLocalOnlyTrailer(historyNotepadsGalileo(wa), ctx);

  // `PQ/R-<locator>` — past-date BF retrieve by locator. v11 has no
  // past-date REST endpoint; falls back to the local pnrStore which
  // retains every committed PNR for the session lifetime.
  if (arg.startsWith('PQ-R:')) {
    const locator = arg.slice('PQ-R:'.length);
    const pnr = retrieveStoredBf(ctx, locator);
    if (!pnr) return 'PAST DATE BF NOT FOUND'; // reconstructed
    wa.pnr = pnr;
    wa.machine.transition(SessionEvent.RETRIEVE);
    return renderGalileoPnr(pnr, sig);
  }
  // Other PQ forms (name/date search) — deferred since v11 archive
  // lookup isn't exposed.
  if (arg.startsWith('PQ-DEFERRED:')) {
    return 'PAST DATE BF SEARCH DEFERRED'; // reconstructed
  }

  // `*TE<n>` / `*TE/<ticket>` — Mini Format Guide v2 (verbatim
  // 2026-06-03):
  //   *TE2                Display second eticket from a list
  //   *TE/<13-digit>      Display eticket by ticket number
  // Both reuse the same `/receipts` GET as *HTE/*HTI, then filter or
  // index into the result. The ticket-detail render is the same
  // single-row format we use today for the list.
  // `*TEL` — redisplay the multiple e-ticket list; `*TEH` — e-ticket
  // history (follow-up after a *TE record display). Formats Guide
  // rows, in-tree.
  if (upper === 'TEL') return ticketListGalileo(wa, ctx);
  if (upper === 'TEH') return ticketHistoryGalileo(wa, ctx);
  if (upper.startsWith('TE')) {
    const after = arg.slice(2);
    if (/^\d+$/.test(after)) {
      // `*TE002` — zero-padded record index from the *HTE list.
      return ticketShowGalileo(wa, ctx, { index: Number(after) });
    }
    if (after.startsWith('/') && /^\d{10,14}$/.test(after.slice(1))) {
      return ticketShowGalileo(wa, ctx, { number: after.slice(1) });
    }
    // Vendor-keyed selectors (Formats Guide, verbatim entries):
    //   *TE/BA/FF10087654            by vendor + mileage membership
    //   *TE/BA/CC1234567890123       by vendor + credit card (FOP)
    //   *TE/BA/10AUG05LONABZ-SMITH   by vendor + date/board/off/name
    const vendorSel = /^\/([A-Z0-9]{2})\/(.+)$/.exec(after.toUpperCase());
    if (vendorSel) {
      const [, vendor, sel] = vendorSel;
      const byVendor = (t: TicketRecord) => t.validatingCarrier === vendor;
      if (sel.startsWith('FF')) {
        const num = sel.slice(2);
        const hasFf = wa.pnr.frequentFlyers.some((f) => f.carrier === vendor && f.number === num);
        return hasFf ? ticketShowGalileo(wa, ctx, { pred: byVendor }) : 'TICKET NOT FOUND'; // reconstructed
      }
      if (sel.startsWith('CC')) {
        const num = sel.slice(2);
        const fopHasCard = (wa.pnr.fopField ?? '').includes(num);
        return fopHasCard ? ticketShowGalileo(wa, ctx, { pred: byVendor }) : 'TICKET NOT FOUND'; // reconstructed
      }
      const dbo = /^(\d{1,2}[A-Z]{3}\d{0,2})([A-Z]{3})([A-Z]{3})-(.+)$/.exec(sel);
      if (dbo) {
        const [, date, board, off, surname] = dbo;
        const segMatch = wa.pnr.segments.some(
          (x) => x.origin === board && x.destination === off && date.startsWith(x.date)
        );
        return segMatch
          ? ticketShowGalileo(wa, ctx, { pred: (t) => byVendor(t) && t.passenger.startsWith(surname) })
          : 'TICKET NOT FOUND'; // reconstructed
      }
    }
  }

  // Surname retrieve — `*-SMITH`. No documented REST equivalent in
  // TripServices (the spec calls surname search "GDS-host-only"), so
  // this stays local-only even when the backend is live. The local
  // pnrStore was populated as a pragmatic shadow by the live commit
  // path, so committed live PNRs are findable by name here too —
  // but the trailer makes the session-only scope explicit when
  // running live.
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
    return appendLocalOnlyTrailer(renderGalileoPnr(matches[0], sig), ctx);
  }

  // Record locator (6-char alphanumeric). Live path GETs the reservation
  // from TripServices and maps it; emulated path reads from pnrStore.
  if (isRecordLocator(arg)) {
    if (ctx.backend instanceof LiveTravelportBackend) {
      return retrieveGalileoLive(arg, wa, ctx, ctx.backend, sig);
    }
    const pnr = retrieveStoredBf(ctx, arg);
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
    // Travelport JSON Air v11 returns HTTP 200 with a Result.Error[]
    // payload for not-found locators — extractor surfaces it as
    // "[VALIDATION/200] RECORD LOCATOR DOES NOT EXIST" (verified
    // 2026-06-07 against pre-prod 7K9S via *XYZ999). Translate to the
    // same NO_PNR string the emulated path returns so the diff oracle
    // sees IDENTICAL wording on both backends.
    if (/RECORD LOCATOR DOES NOT EXIST|BOOKING FILE NOT FOUND/i.test(msg)) {
      return GalileoResponse.NO_PNR;
    }
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
    modifyTransition(wa);
    wa.pnr.segments = [];
    return 'ITINERARY CANCELLED'; // reconstructed
  }

  const max = wa.pnr.segments.length;
  for (const n of entry.segments) {
    if (n < 1 || n > max) return 'SEGMENT NUMBER NOT IN ITINERARY'; // reconstructed
  }

  modifyTransition(wa);
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
  let cancelledOfferUuids: Set<string> = new Set();
  try {
    const isFull = entry.mode === 'itinerary' || entry.mode === 'all_air';
    if (isFull) {
      await backend.cancelWorkbenchItems(wa.liveWorkbenchId!, { all: true });
    } else {
      // Per-segment cancel: resolve each segment's workbench offer UUID
      // (NOT the search-side ref — see collectOfferIdsForSegments).
      // TripServices cancels at the OFFER level when we don't supply
      // per-segment productID + sequence, so selecting any segment of
      // a multi-leg offer cancels the whole offer. We capture the set
      // we sent so the local-state-cleanup step below drops the full
      // set of cancelled segments, not just the explicitly-listed one.
      const offerIds = collectOfferIdsForSegments(wa, entry.segments);
      if (offerIds.length === 0) {
        return 'LIVE OFFER ID MISSING'; // reconstructed — same as live-sell
      }
      // Per-offer cancel has two shipping paths against pre-prod:
      //   - cancelitems + CancelSelectedOffers — VERIFIED 2026-06-06 to
      //     silently return 200 + {} without actually removing the
      //     offer. Don't use.
      //   - /offers/canceloffer + OfferQueryCancelOffer — endpoint
      //     exists but returned "Not Authorized to Access this API"
      //     on the 7K9S trial tenant 2026-06-06.
      // Pragmatic fallback: when the offers we'd cancel cover EVERY
      // offer currently in the workbench (X<n> on a single-offer
      // workbench is the common case for connections), route through
      // cancelitems with `cancelAllInd: true` instead — devkit-
      // canonical, verified working. Otherwise try canceloffer and
      // surface whatever pre-prod says.
      const uniqueWbOffers = new Set(
        (wa.liveWorkbenchOfferIds ?? []).filter((u) => u && u.length > 0)
      );
      const cancellingAll =
        offerIds.length === uniqueWbOffers.size &&
        offerIds.every((id) => uniqueWbOffers.has(id));
      if (cancellingAll) {
        await backend.cancelWorkbenchItems(wa.liveWorkbenchId!, { all: true });
      } else {
        for (const uuid of offerIds) {
          await backend.cancelOfferInWorkbench(wa.liveWorkbenchId!, uuid);
        }
      }
      cancelledOfferUuids = new Set(offerIds);
    }
  } catch (err) {
    return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
  }
  modifyTransition(wa);
  if (entry.mode === 'itinerary' || entry.mode === 'all_air') {
    wa.pnr.segments = [];
    // Whole-itinerary cancel: drop ALL captured workbench offer UUIDs
    // alongside the segments so a subsequent addOffer starts clean.
    wa.liveWorkbenchOfferIds = undefined;
  } else {
    // Cancelled offers cover every segment whose workbench UUID is in
    // the set we just sent — the server dropped them all even though
    // the cryptic only named some. Drop them all locally too, so the
    // workbench view matches the server's.
    const wbIds = wa.liveWorkbenchOfferIds ?? [];
    const cancelledIndices = wbIds
      .map((uuid, i) => (uuid && cancelledOfferUuids.has(uuid) ? i : -1))
      .filter((i) => i >= 0);
    // Fall back to the cryptic-named segments if we have no UUID
    // tracking (emulated fixtures, etc.).
    const cancelledSet =
      cancelledIndices.length > 0
        ? new Set(cancelledIndices.map((i) => wa.pnr.segments[i]?.segmentNumber).filter((n): n is number => typeof n === 'number'))
        : new Set(entry.segments);
    const dropIndices =
      cancelledIndices.length > 0
        ? cancelledIndices
        : wa.pnr.segments.map((s, i) => (cancelledSet.has(s.segmentNumber) ? i : -1)).filter((i) => i >= 0);
    wa.pnr.segments = wa.pnr.segments.filter((s) => !cancelledSet.has(s.segmentNumber));
    wa.pnr.renumberSegments();
    dropLiveWorkbenchOfferIds(wa, dropIndices);
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
    modifyTransition(wa);
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
  // Same routing trick as the pre-commit partial cancel: when the
  // user names every segment, route through cancelReservation
  // against the locator instead of the workbench+canceloffer dance.
  // The 7K9S trial tenant returns "Not Authorized to Access this
  // API" on canceloffer; cancelReservation is verified working.
  const cancelledSegs = new Set(entry.segments);
  const cancellingAllSegments =
    wa.pnr.segments.length > 0 &&
    wa.pnr.segments.every((s) => cancelledSegs.has(s.segmentNumber));
  if (cancellingAllSegments) {
    try {
      await backend.cancelReservation(wa.pnr.locator!);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
    modifyTransition(wa);
    wa.pnr.segments = [];
    const local = ctx.backend.pnrs.get(wa.pnr.locator!);
    if (local) local.segments = [];
    return 'ITINERARY CANCELLED'; // reconstructed
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
    // Per-offer cancel: one canceloffer POST per unique offer UUID.
    for (const id of offerIds) {
      await backend.cancelOfferInWorkbench(workbenchId, id);
    }
    await backend.commitWorkbench(workbenchId);
  } catch (err) {
    return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
  }
  modifyTransition(wa);
  const remove = new Set(entry.segments);
  wa.pnr.segments = wa.pnr.segments.filter((s) => !remove.has(s.segmentNumber));
  wa.pnr.renumberSegments();
  const local = ctx.backend.pnrs.get(wa.pnr.locator!);
  // After a live retrieve, the pnrStore holds a reference to the same
  // Pnr object that wa.pnr now points at — filtering+renumbering
  // wa.pnr.segments already mutated the local copy. Skip the local
  // re-filter when they alias, otherwise the second filter would
  // remove the renumbered survivor whose new segmentNumber happens
  // to collide with the original `remove` set.
  if (local && local !== wa.pnr) {
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
 *
 * LOCAL-ONLY BY DESIGN. Verified 2026-06-06 against the v11 GDS
 * reference-payload devkit — there is NO canonical REST endpoint
 * for manual segment-status override in JSON Air v11. The devkit's
 * book/airoffer/ and book/airreservation/ surfaces don't expose
 * "set segment to HK" or equivalent. Travelport's model is that
 * status changes are server-driven: the airline confirms (HK) /
 * waitlists (HL) / declines (NN) asynchronously via vendor
 * notifications, not via agent override. `@<n>HK` is a legacy
 * mainframe agent-side pattern that doesn't map to the modern
 * REST surface. Update the in-memory PNR so cryptic queries
 * reflect the agent's intent; the next live retrieve will
 * re-sync from the actual server-side state.
 */
function handleGalileoSegmentStatus(
  entry: SegmentStatusEntry,
  wa: WorkArea,
  ctx: HandlerContext
): string {
  if (wa.pnr.segments.length === 0) return GalileoResponse.NEED_ITINERARY;
  if (!MANUAL_STATUS_CODES.has(entry.status)) return 'INVALID STATUS CODE'; // reconstructed
  const seg = wa.pnr.segments.find((s) => s.segmentNumber === entry.segment);
  if (!seg) return 'SEGMENT NUMBER NOT IN ITINERARY'; // reconstructed
  modifyTransition(wa);
  seg.status = entry.status;
  return appendLocalOnlyTrailer(renderGalileoItinerary(wa.pnr), ctx);
}

/**
 * `SI.<...>` — Galileo SSR entry. Push onto `wa.pnr.ssrs` (local
 * model). When in a live workbench, also POST to the canonical
 * `/specialservices/list` endpoint with `TravelerIdentifier` resolved
 * from `wa.liveTravelerIds` (per the `nameRef` scope when set, or
 * omitted for whole-BF SSRs) and `AppliesTo.OfferIdentifier` resolved
 * from the first cached availability line's `vendorRef.offerId`.
 *
 * v1 limitations:
 *  - Single SSR per call (Mini Guide allows chained SI. on one
 *    cryptic line; we don't merge).
 *  - Segment scope (S<n>) parsed but not surfaced to the live body
 *    — applies-to-first-offer is a reasonable proxy in v1; pre-prod
 *    will say whether per-segment ref is required.
 *  - Live failure surfaces `LIVE BACKEND ERROR` and skips the local
 *    push (consistent with NP. semantics).
 */
async function handleGalileoSsr(
  entry: SsrEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  if (entry.nameRef) {
    const item = wa.pnr.names[entry.nameRef.item - 1];
    if (!item) return GalileoResponse.FORMAT;
    const p = entry.nameRef.passenger;
    if (p != null && (p < 1 || p > item.passengers.length)) return GalileoResponse.FORMAT;
  }

  if (ctx.backend instanceof LiveTravelportBackend && wa.liveWorkbenchId) {
    // Resolve traveler ref: nameRef.item → liveTravelerIds index.
    // For whole-BF scope (no nameRef), omit TravelerIdentifier and
    // let pre-prod tell us if it's actually required.
    let travelerId: string | undefined;
    if (entry.nameRef && wa.liveTravelerIds) {
      const tid = wa.liveTravelerIds[entry.nameRef.item - 1];
      if (tid) travelerId = tid;
    }
    // VERIFIED PRE-PROD 2026-06-06: SSR's AppliesTo.OfferIdentifier
    // needs the WORKBENCH-side offer UUID assigned at addOffer time
    // (captured on wa.liveWorkbenchOfferIds), NOT the search-side
    // short ref (`o1`) cached in vendorRef. The earlier vendorRef-
    // based version returned 200 + Result.Error: OFFER ID/IDENTIFIER
    // VALUES MUST MATCH WITH THE RESERVATION WORKBENCH OFFER ID/
    // IDENTIFIER VALUES.
    //
    // Per-leg scope: `SI.S<n>/<code>` targets segment <n>. Pick the
    // workbench offer UUID for THAT segment (index = segmentRef-1).
    // No segment scope (whole-BF SSR) defaults to the first offer —
    // for multi-offer BFs this is the simplest pre-prod-tolerated
    // shape; future variants can pass all UUIDs in the array.
    //
    // Falls back to the search-side ID for emulated mocks that don't
    // populate the workbench offer list.
    const offerIdx =
      entry.segmentRef && entry.segmentRef > 0 ? entry.segmentRef - 1 : 0;
    const offerId =
      wa.liveWorkbenchOfferIds?.[offerIdx] ||
      wa.liveWorkbenchOfferIds?.[0] ||
      wa.lastAvailability?.lines[offerIdx]?.vendorRef?.offerId ||
      wa.lastAvailability?.lines[0]?.vendorRef?.offerId;
    try {
      await ctx.backend.addSpecialServices(wa.liveWorkbenchId, [
        {
          ssrCode: entry.code,
          travelerId,
          offerId,
          freeText: entry.text,
        },
      ]);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }

  addFieldTransition(wa, `SSR ${entry.code}${entry.text ? ` ${entry.text}` : ''}`);
  wa.pnr.ssrs.push({
    code: entry.code,
    carrier: entry.carrier,
    text: entry.text,
    nameRef: entry.nameRef,
    status: 'NN', // requested; airline confirms HK/HN/KK asynchronously
  });
  return renderGalileoSsrs(wa.pnr);
}

/**
 * `FQN` / `FN<...>` — Fare components / fare notes. Source: Mini
 * Format Guide v2 (verbatim 2026-06-03) + APIRef_FareRules.htm (REST
 * scope, verified 2026-06-03).
 *
 * v1 scope:
 *  - **FQN** (components): renders `wa.pnr.priceQuotes[]` as a
 *    fare-construction table. Local-only — the fare quote already
 *    holds the breakdown.
 *  - **FN*<line>** / **FN<seg>** (notes): would call
 *    `GET /11/air/farerule/farerules/fromfaredisplay` with the cached
 *    FD identifier + FareID. We don't yet cache the FareDisplay
 *    response Identifier on the WA, so this returns a deferred stub.
 *    Wiring requires (1) `WorkAreaSlot.lastFareDisplay?: { identifier,
 *    lines[] }`, (2) extending `mapFareDisplay` to extract the
 *    top-level Identifier, (3) a backend `fareRulesFromFareDisplay`
 *    method. Parked in spec doc Future Work.
 */
async function handleGalileoFareNotes(
  entry: FareNotesEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  if (entry.mode === 'components') {
    if (wa.pnr.priceQuotes.length === 0) return 'NO FILED FARES'; // reconstructed
    return wa.pnr.priceQuotes
      .map((fq, i) => {
        const lines = fq.passengers.map((p) => {
          const total = (p.total ?? 0) * (p.count ?? 1);
          return `    ${p.passengerType.padEnd(4)} ${String(p.count).padStart(2)} BASE ${p.base.toFixed(2)} TAX ${p.taxTotal.toFixed(2)} TOTAL ${total.toFixed(2)}`;
        });
        const fareCalc = fq.passengers[0]?.fareCalc ?? '';
        const head = `FQ ${i + 1} ${fq.validatingCarrier} ${fq.currency} ${fq.fareBasis.join(' ')}`;
        return [head, ...lines, fareCalc].filter((l) => l.length > 0).join('\n');
      })
      .join('\n');
  }

  // FN<...> notes — needs the cached FareDisplay identifier from a
  // prior `FD<...>`. The `notes_by_segment` form (`FN<seg>/ALL`) is
  // meant for after-FQN context which targets segments rather than
  // FD lines; v11's `/fromfaredisplay` is only line-keyed, so the
  // segment form returns NOT IMPLEMENTED for v1.
  if (entry.mode === 'notes_by_segment') {
    return 'FN SEGMENT MODE NOT IMPLEMENTED'; // reconstructed
  }
  const fd = wa.lastFareDisplay;
  if (!fd || !fd.identifier) {
    return 'NO FARE DISPLAY ON SCREEN'; // reconstructed
  }
  const line = entry.fareLine!;
  const target = fd.lines.find((l) => l.sequence === line);
  if (!target) {
    return `LINE ${line} NOT IN FARE DISPLAY`; // reconstructed
  }
  if (!(ctx.backend instanceof LiveTravelportBackend)) {
    // Emulated path — we don't synthesize narrative fare rules.
    return 'FN EMULATED NOT SUPPORTED'; // reconstructed
  }
  try {
    const response = await ctx.backend.fareRulesFromFareDisplay({
      fareRuleIdentifier: fd.identifier,
      FareID: line,
      fareRuleType: 'LongText',
    });
    return renderFareNotesText(response, fd, target);
  } catch (err) {
    return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
  }
}

/**
 * Render the `/fromfaredisplay` response — defensively walks common
 * shape variants and concatenates any narrative text we find.
 * Reconstructed output: a header line identifying the fare + the
 * paragraphs as line-separated text. The paragraph filter from the
 * cryptic (`/P8`, `/ALL`, etc.) is NOT applied here — `/fromfaredisplay`
 * doesn't take a category filter for ShortText/LongText, so we fetch
 * the whole narrative and let the agent scan. Filtering deferred.
 */
function renderFareNotesText(
  response: unknown,
  fd: import('../../models/fare-display.js').FareDisplayResult,
  line: import('../../models/fare-display.js').FareDisplayLine
): string {
  const r = response as any;
  const root = r?.FareRuleListResponse ?? r;
  const rules = Array.isArray(root?.FareRule) ? root.FareRule : [];
  const head = `FARE NOTES ${fd.origin}${fd.destination}  L${line.sequence} ${line.carrier} ${line.fareBasisCode}`;
  const paragraphs: string[] = [];
  for (const rule of rules) {
    const txt = rule?.text ?? rule?.LongText ?? rule?.shortText ?? rule?.ShortText;
    if (typeof txt === 'string' && txt.length > 0) paragraphs.push(txt);
    const ruleArr = Array.isArray(rule?.Rule) ? rule.Rule : [];
    for (const r2 of ruleArr) {
      const t2 = r2?.text ?? r2?.LongText ?? r2?.value;
      if (typeof t2 === 'string' && t2.length > 0) paragraphs.push(t2);
    }
  }
  if (paragraphs.length === 0) return 'NO FARE NOTES'; // reconstructed
  return [head, ...paragraphs].join('\n');
}

/**
 * `FD<...>` — Fare Display. Source: Mini Format Guide v2 (cryptic)
 * + `APIRef_FareDisplay.htm` (REST, verbatim 2026-06-03).
 *
 * Live path: POST `/11/air/faredisplay/fares` with
 * `FareDisplayQueryRequest` carrying `from`/`to`/`departureDate`/
 * optional `carrier[]`. Map response → cryptic tabular screen.
 *
 * Emulated path: synthesize lines from the inventory tariff —
 * one row per booking class for the requested O&D (or empty if no
 * inventory). Year defaults handled at the date-encode level: the
 * Sabre-style DDMMM cryptic doesn't carry a year, so we use current
 * year (assumption flagged here, not validated against the live
 * server's wrap behavior).
 */
async function handleGalileoFareDisplay(
  entry: FareDisplayEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  const dateToken = entry.date ? entry.date.raw : '';
  const isoDate = entry.date ? sabreDateToIso(entry.date) : undefined;

  if (ctx.backend instanceof LiveTravelportBackend) {
    try {
      const response = await ctx.backend.fareDisplay({
        from: entry.origin,
        to: entry.destination,
        departureDate: isoDate,
        carriers: entry.carriers,
      });
      const result = mapFareDisplay(response, {
        origin: entry.origin,
        destination: entry.destination,
        departureDate: dateToken || 'TODAY',
        carriers: entry.carriers ?? [],
      });
      // Cache for follow-on `FN<...>` queries — they need the
      // server-assigned Identifier + per-line sequence numbers to
      // call `/farerule/farerules/fromfaredisplay`.
      wa.lastFareDisplay = result;
      return renderGalileoFareDisplay(result);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }

  // Emulated: synthesize from the local tariff. Returns one row per
  // booking class observed on the requested O&D in inventory, with
  // amounts computed from `priceItinerary`'s tariff function. v1 is a
  // rough approximation — real fare display is a separate published-
  // fare table, not a per-leg inventory join.
  const classes = inventoryClassesForOd(ctx, entry.origin, entry.destination);
  const lines = classes.map((c, i) => ({
    sequence: i + 1,
    carrier: c.carrier,
    amount: c.amount,
    fareBasisCode: `${c.bookingClass}EM`,
    bookingClass: c.bookingClass,
    journeyType: 'OW' as const,
  }));
  return renderGalileoFareDisplay({
    origin: entry.origin,
    destination: entry.destination,
    departureDate: dateToken || 'TODAY',
    currency: 'USD',
    lines,
  });
}

/**
 * Convert a Sabre-style DDMMM date token to ISO YYYY-MM-DD. Uses the
 * current year — the Galileo cryptic doesn't carry a year, and v1
 * doesn't model server-side wrap (Mini Guide says the server picks
 * the next future occurrence). Pre-prod will surface any wrap drift.
 */
function sabreDateToIso(d: import('../../utils/validation.js').SabreDate): string {
  const year = new Date().getUTCFullYear();
  const month = String(d.month + 1).padStart(2, '0');
  const day = String(d.day).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Synthesize fare-display rows from the emulated inventory. One row
 * per (carrier, bookingClass) pair observed for the O&D, with
 * `amount` from the tariff. v1 approximation — see
 * `handleGalileoFareDisplay` docstring.
 */
function inventoryClassesForOd(
  ctx: HandlerContext,
  origin: string,
  destination: string
): Array<{ carrier: string; bookingClass: string; amount: number }> {
  // Reuse the existing availability lookup for a near-term date and
  // walk each line's classes map. v1 doesn't model a separate
  // published-fare table — the inventory's classes are the proxy.
  const today = new Date();
  const day = today.getUTCDate();
  const monthIdx = today.getUTCMonth();
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const dateToken = `${day}${months[monthIdx]}`;
  const lines = ctx.backend.inventory.availability(
    dateToken,
    { letter: '?', num: 0 },
    origin,
    destination
  );
  const out: Array<{ carrier: string; bookingClass: string; amount: number }> = [];
  const seen = new Set<string>();
  for (const f of lines) {
    for (const bookingClass of Object.keys(f.classes)) {
      const key = `${f.carrier}-${bookingClass}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Emulated base × class multiplier — same tariff convention as
      // priceItinerary uses; inlined to avoid a cycle.
      const base = 200;
      const mult = bookingClass === 'F' ? 4 : bookingClass === 'J' ? 3 : bookingClass === 'C' ? 2.5 : 1;
      out.push({ carrier: f.carrier, bookingClass, amount: base * mult });
    }
  }
  return out;
}

/**
 * `TMU<n>F<form>` — attach FOP to filed fare `<n>`. Source: Mini
 * Format Guide v2. v1 stores on `wa.pnr.priceQuotes[n-1].fop`; live
 * REST is deferred to TKP time (when the issue actually happens).
 * Real Galileo posts immediately to the workbench at TMU; we batch
 * to keep our TKP handler the single place that calls
 * `addFormOfPayment`, which simplifies error handling.
 *
 * Echo: `OK-TMU<n>` (reconstructed — Mini Guide documents the entry,
 * not the response).
 */
function handleGalileoTicketModifier(entry: TicketModifierEntry, wa: WorkArea): string {
  const idx = entry.filedFare - 1;
  const fq = wa.pnr.priceQuotes[idx];
  if (!fq) {
    return `NO FILED FARE ${entry.filedFare}`; // reconstructed
  }
  if (entry.fop) fq.fop = entry.fop;
  return `OK-TMU${entry.filedFare}`; // reconstructed
}

/**
 * `NP.<text>` and `NP.<qualifier>**<text>` — notepad / remark.
 * Source: Mini Format Guide v2.
 *
 * Local: push onto `wa.pnr.remarks`.
 * Live: when a workbench is open, POST to `/reservationcomments/list`
 * with `commentSource: "Agency"` + the appropriate Comment label
 * (Notepad vs Historical Notepad). The cryptic confidential
 * qualifier (`NP.C**`) currently maps to a plain notepad in the live
 * body — server-side confidentiality tier isn't part of the v11
 * schema we have.
 *
 * Marks the queue dirty flag in queue context like any other modify
 * op. Returns a reconstructed echo line.
 */
async function handleGalileoRemark(
  entry: RemarkEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  // RI. (itinerary) / DI. (document/ticketing) remarks — local-only
  // fields (no v11 BF-remark category mapping); webhelp BF-fields
  // compare gives the entry forms verbatim.
  if (entry.remarkType === 'itinerary' || entry.remarkType === 'document') {
    const sigil = entry.remarkType === 'itinerary' ? 'RI' : 'DI';
    const ofType = () => wa.pnr.remarks.filter((r) => r.type === entry.remarkType);
    if (entry.deleteIndex != null) {
      const target = ofType()[entry.deleteIndex - 1];
      if (!target) return GalileoResponse.FORMAT;
      wa.pnr.remarks = wa.pnr.remarks.filter((r) => r !== target);
      addFieldTransition(wa, `${sigil} DELETE ${entry.deleteIndex}`);
      return GalileoResponse.OK;
    }
    if (entry.remarkType === 'itinerary' && entry.segment != null) {
      if (!wa.pnr.segments.some((x) => x.segmentNumber === entry.segment)) {
        return 'SEGMENT NOT IN ITINERARY';
      }
    }
    wa.pnr.remarks.push({ type: entry.remarkType, text: entry.text, segment: entry.segment });
    addFieldTransition(wa, `${sigil} ADD ${entry.segment != null ? 'S' + entry.segment + ' ' : ''}${entry.text}`);
    return GalileoResponse.OK;
  }
  if (ctx.backend instanceof LiveTravelportBackend && wa.liveWorkbenchId) {
    try {
      await ctx.backend.addReservationComment(wa.liveWorkbenchId, entry.text, {
        kind: entry.remarkType === 'historical' ? 'historical' : 'notepad',
      });
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }
  addFieldTransition(
    wa,
    `NP${entry.remarkType === 'historical' ? '.H**' : '.'}${entry.text}`
  );
  wa.pnr.remarks.push({ type: entry.remarkType, text: entry.text });
  return `NP.${entry.text}`; // reconstructed echo
}

/**
 * `SI.<carrier>*<text>` — OSI dispatch. Pushes onto `wa.pnr.osis`
 * (the existing model field). When in a live workbench, also POSTs
 * to `/reservationcomments/list` with `commentSource: "Supplier"` +
 * `shareWithSupplier: [<carrier>]` + `Comment.name: "OSI Remarks"`
 * per the canonical schema. Same endpoint as NP. — backend
 * dispatches on `opts.kind`.
 *
 * Live failure surfaces `LIVE BACKEND ERROR` and skips the local
 * push (mirrors NP./SSR semantics). Outside a workbench (post-
 * retrieve or pre-build) OSI stays local.
 *
 * OSI text constraint per `Book/RemarksGuide.htm`: 1-99 chars, only
 * `.` / `/` / `-` as special chars. We don't enforce client-side
 * — server 4xx will surface.
 */
async function handleGalileoOsi(
  entry: OsiEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  if (ctx.backend instanceof LiveTravelportBackend && wa.liveWorkbenchId) {
    try {
      await ctx.backend.addReservationComment(wa.liveWorkbenchId, entry.text, {
        kind: 'osi',
        carrier: entry.carrier,
      });
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }
  addFieldTransition(wa, `OSI ${entry.carrier} ${entry.text}`);
  wa.pnr.osis.push({ carrier: entry.carrier, text: entry.text });
  return `OSI ${entry.carrier} ${entry.text}`; // reconstructed echo
}

function renderGalileoSsrs(pnr: { ssrs: Array<{ code: string; carrier: string; text?: string; nameRef?: { item: number; passenger?: number } }> }): string {
  if (pnr.ssrs.length === 0) return 'NO SSRS'; // reconstructed
  return pnr.ssrs
    .map((s, i) => {
      const nr = s.nameRef
        ? ` P${s.nameRef.item}${s.nameRef.passenger != null ? `.${s.nameRef.passenger}` : ''}`
        : '';
      const txt = s.text ? ` ${s.text}` : '';
      return `${i + 1}.SI.${s.code}${nr}${txt}`;
    })
    .join('\n');
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
      for (const id of offerIds) {
        await ctx.backend.cancelOfferInWorkbench(wa.liveWorkbenchId, id, {
          passive: true,
        });
      }
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }
  modifyTransition(wa);
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
    const refSets = collectPriceRefsForAllSegments(wa);
    if (refSets.length > 0) {
      try {
        // Multi-offer FQ: one priceOffer call per unique
        // (offerId, productId) pair across all segments. Merge the
        // resulting FareQuotes into a single quote so the rendered
        // FILED FARE shows one combined block (matching the cryptic
        // FQ semantics: one quote covers the whole booking, even
        // when its segments come from different offers).
        const quotes: FareQuote[] = [];
        for (const refs of refSets) {
          const response = await ctx.backend.priceOffer(refs);
          const fq = mapPricedOffer(response, {
            departureDate: wa.pnr.segments[0]?.date ?? '',
          });
          if (fq) quotes.push(fq);
        }
        const merged = mergeFareQuotes(quotes);
        if (merged) {
          wa.pnr.priceQuotes.push(merged);
          wa.lastPricing = merged;
          return renderGalileoFareQuote(merged, wa.pnr.priceQuotes.length);
        }
        // Mapper returned null on every quote — fall through to emulated.
      } catch (err) {
        return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
      }
    }
    // No usable refs → fall through to emulated below.
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
 * Like `findOfferIdForFirstSegment` but returns the 3-ID triple
 * `priceOffer` needs (searchIdentifier from the availability cache +
 * per-line offerId/productId from vendorRef). Falls back to undefined
 * if any of the three is missing so the caller can defer to
 * emulated pricing rather than POST an invalid live body.
 */
function findPriceRefsForFirstSegment(
  wa: WorkArea
): { searchIdentifier: string; offerId: string; productId: string } | undefined {
  const seg = wa.pnr.segments[0];
  const avail = wa.lastAvailability;
  if (!seg || !avail) return undefined;
  if (!avail.searchIdentifier) return undefined;
  const line = avail.lines.find(
    (l) => l.carrier === seg.carrier && l.flightNumber === seg.flightNumber
  );
  const offerId = line?.vendorRef?.offerId;
  const productId = line?.vendorRef?.productId;
  if (!offerId || !productId) return undefined;
  return { searchIdentifier: avail.searchIdentifier, offerId, productId };
}

/**
 * Collect the unique (offerId, productId) ref triples across every
 * segment in the workarea PNR. Multi-offer FQ posts one priceOffer
 * call per unique pair (a connection — multiple segments under one
 * offer — collapses to a single call). Returns empty when the
 * availability cache lacks any segment's refs, so the caller can
 * fall through to emulated pricing rather than POST a partial body.
 */
function collectPriceRefsForAllSegments(
  wa: WorkArea
): Array<{ searchIdentifier: string; offerId: string; productId: string }> {
  const avail = wa.lastAvailability;
  if (!avail?.searchIdentifier) return [];
  const seen = new Set<string>();
  const out: Array<{ searchIdentifier: string; offerId: string; productId: string }> = [];
  for (const seg of wa.pnr.segments) {
    const line = avail.lines.find(
      (l) => l.carrier === seg.carrier && l.flightNumber === seg.flightNumber
    );
    const offerId = line?.vendorRef?.offerId;
    const productId = line?.vendorRef?.productId;
    if (!offerId || !productId) continue;
    const key = `${offerId}|${productId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ searchIdentifier: avail.searchIdentifier, offerId, productId });
  }
  return out;
}

/**
 * Merge per-offer FareQuotes into a single quote covering the whole
 * booking. Each priceOffer call returns one FareQuote for one offer;
 * the cryptic FILED FARE for FQ expects a single combined block, so
 * we sum per-passenger amounts across all offers and concatenate
 * fare-basis codes in segment order. Returns the first quote when
 * given one (no-op), null when the input is empty.
 *
 * Assumptions:
 *  - Same currency across all quotes (Travelport normalizes to a
 *    single currency per search; mismatch is a server-side error).
 *  - Same passenger-type set across all quotes (matching the search
 *    PassengerCriteria — diverging mid-booking would mean the
 *    addOffer for one segment used a different pax count, which is
 *    a sell-side bug, not a pricing-side one).
 *  - Validating carrier from the first quote — multi-carrier
 *    itineraries typically have one common validator (the
 *    plating carrier); v1 doesn't model split validators.
 */
function mergeFareQuotes(quotes: FareQuote[]): FareQuote | null {
  if (quotes.length === 0) return null;
  if (quotes.length === 1) return quotes[0];
  const base = quotes[0];
  // Build a per-passenger-type accumulator from the first quote, then
  // add each subsequent quote's matching block to it.
  const byType = new Map<string, PassengerFare>();
  for (const pf of base.passengers) {
    byType.set(pf.passengerType, {
      passengerType: pf.passengerType,
      count: pf.count,
      base: pf.base,
      taxes: pf.taxes.map((t) => ({ ...t })),
      taxTotal: pf.taxTotal,
      total: pf.total,
      fareCalc: pf.fareCalc,
    });
  }
  for (let i = 1; i < quotes.length; i++) {
    for (const pf of quotes[i].passengers) {
      const acc = byType.get(pf.passengerType);
      if (!acc) {
        // Passenger type appeared only in a later quote — push it as-is
        // (rare; usually all quotes share the search PassengerCriteria).
        byType.set(pf.passengerType, {
          passengerType: pf.passengerType,
          count: pf.count,
          base: pf.base,
          taxes: pf.taxes.map((t) => ({ ...t })),
          taxTotal: pf.taxTotal,
          total: pf.total,
          fareCalc: pf.fareCalc,
        });
        continue;
      }
      acc.base += pf.base;
      acc.taxTotal += pf.taxTotal;
      acc.total += pf.total;
      // Merge tax breakdowns by code so the rendered breakdown shows
      // each tax once with its total amount.
      const byCode = new Map<string, number>();
      for (const t of acc.taxes) byCode.set(t.code, (byCode.get(t.code) ?? 0) + t.amount);
      for (const t of pf.taxes) byCode.set(t.code, (byCode.get(t.code) ?? 0) + t.amount);
      acc.taxes = [...byCode.entries()].map(([code, amount]) => ({ code, amount }));
      // Fare-calc lines append in segment order (Sabre/Galileo Pricing QR
      // shows a multi-line fare-construction string for multi-offer trips).
      if (pf.fareCalc) {
        acc.fareCalc = acc.fareCalc ? `${acc.fareCalc} ${pf.fareCalc}` : pf.fareCalc;
      }
    }
  }
  const fareBasis: string[] = [];
  for (const q of quotes) fareBasis.push(...q.fareBasis);
  return {
    departureDate: base.departureDate,
    validatingCarrier: base.validatingCarrier,
    currency: base.currency,
    fareBasis,
    passengers: [...byType.values()],
  };
}

/**
 * Resolve each cryptic segment number to its WORKBENCH-side offer
 * UUID — what `/cancelitems` actually needs. Returns the per-segment
 * UUIDs deduped (a multi-leg offer cancel only generates one
 * `offerProductSelection` entry). Returns [] if any segment can't be
 * resolved — caller refuses with LIVE OFFER ID MISSING rather than
 * POSTing a partial cancel that strands legs in the workbench.
 *
 * VERIFIED PRE-PROD 2026-06-06: the workbench reassigns offer IDs at
 * addOffer time (captured per leg on `wa.liveWorkbenchOfferIds`,
 * index-aligned with `pnr.segments`). Cancel needs THOSE UUIDs, not
 * the search-side short refs (`o1`) in `vendorRef.offerId` — pre-
 * prod returns OFFER ID/IDENTIFIER VALUES MUST MATCH WITH THE
 * RESERVATION WORKBENCH OFFER ID/IDENTIFIER VALUES when sent the
 * wrong one (same gotcha SSR hit).
 */
function collectOfferIdsForSegments(wa: WorkArea, segmentNumbers: number[]): string[] {
  const wbOfferIds = wa.liveWorkbenchOfferIds;
  const segments = wa.pnr.segments;
  const ids = new Set<string>();
  for (const n of segmentNumbers) {
    const idx = segments.findIndex((s) => s.segmentNumber === n);
    if (idx < 0) continue;
    // Prefer the workbench-side UUID we captured at addOffer time.
    const wbId = wbOfferIds?.[idx];
    if (wbId) {
      ids.add(wbId);
      continue;
    }
    // Emulated-only fallback for tests whose fixtures don't populate
    // liveWorkbenchOfferIds — search-side ID from cached availability.
    const seg = segments[idx];
    const line = wa.lastAvailability?.lines.find(
      (l) => l.carrier === seg.carrier && l.flightNumber === seg.flightNumber
    );
    const offerId = line?.vendorRef?.offerId;
    if (offerId) ids.add(offerId);
  }
  return [...ids];
}

/**
 * Drop the workbench-side offer UUIDs for cancelled segments and
 * keep `liveWorkbenchOfferIds` index-aligned with the renumbered
 * `pnr.segments` after a successful partial cancel.
 */
function dropLiveWorkbenchOfferIds(wa: WorkArea, cancelledIndices: number[]): void {
  if (!wa.liveWorkbenchOfferIds) return;
  const drop = new Set(cancelledIndices);
  wa.liveWorkbenchOfferIds = wa.liveWorkbenchOfferIds.filter((_, i) => !drop.has(i));
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

  // Live path: POST the form-of-payment to the workbench. Pull from
  // the filed fare's TMU-stored FOP when present (`TMU<n>F<form>`),
  // default to cash. Issuance happens at commit (E/ER) once both the
  // FOP and the ticketing field are on the workbench. Government
  // warrants (`TMU<n>FGR<...>`) deferred — v11 REST shape not
  // captured.
  // Live FOP + Payment + ticket-issue commit happens POST-COMMIT, not
  // here — see issueTicketsPostCommit in commitGalileoLive. An earlier
  // version of this handler called addFormOfPayment on the BUILD
  // workbench, but that created a duplicate-id collision when the
  // post-commit dance tried to call addFormOfPayment again ("FORM OF
  // PAYMENT REQUEST INVALID. DUPLICATE ID REFERENCE" — pre-prod
  // tracks FOP ids per-locator, not per-workbench). TKP-during-build
  // is now LOCAL-ONLY for ticket-record construction; the live
  // post-commit dance owns all FOP / Payment / ticket-commit work.
  //
  // EXCEPTION: commission. Travelport's ticket commit rejects with
  // "COMMISSION PERCENTAGE MUST BE ENTERED" if no commission has been
  // recorded on the workbench at ANY stage. Setting it post-commit
  // returns a successful DocumentOverrides UUID but the commit still
  // rejects (verified 2026-06-06 — tested setting commission both
  // before and after addFOP in the post-commit workbench; same
  // rejection both times). Conclusion: commission must be set on the
  // BUILD workbench, and inherited through the post-commit
  // buildfromlocator. So we set it here at TKP time (when the user
  // implicitly authorizes ticket-issuance) — 0% for cash by default,
  // overridable when TMU<n>C support lands.
  if (ctx.backend instanceof LiveTravelportBackend && wa.liveWorkbenchId && (wa.liveTravelerIds ?? []).length > 0) {
    try {
      // Commission body's `TravelerIdentifierRef[].id` is the
      // LOCAL traveler id (e.g. "travelerRefId_1"), NOT the UUID we
      // captured in wa.liveTravelerIds. The devkit's commission flow
      // extracts via `Reservation.Traveler[0].id`. Server-assigned,
      // sequential — predict by ordinal since we haven't GET'd the
      // workbench state.
      const localIds = (wa.liveTravelerIds ?? []).map((_, i) => `travelerRefId_${i + 1}`);
      await ctx.backend.setCommissionPercent(wa.liveWorkbenchId, {
        travelerIds: localIds,
        percent: 0,
      });
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
      // Interface record at issuance (MIR for Galileo/Apollo).
      ctx.backend.interfacePos.generate({
        kind: 'MIR', locator: wa.pnr.locator ?? '------', passenger: record.passenger,
        documentNumber: record.number, total: record.total, currency: 'USD', pcc: ctx.pcc,
      });
      issued.push(record);
    }
  }
  const render = renderGalileoIssuedTickets(issued);
  // GPM.net appendix: the printer buffer holds the ticket image
  // (one per BF, count 0 or 1) until printed or restarted out —
  // HQC counts it, HQS force-flushes it to the spool, HQX deletes.
  if (issued.length > 0) {
    ctx.backend.printSpool.holdTicketImage(wa.pnr.locator ?? 'PENDING', render);
  }
  return render;
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
 * Galileo SA/SM seat-map family (Pocket Guide).
 *   SA*S<n>          source='segment'   — display for segment n
 *   SA*              source='refresh'   — re-display last seat map
 *   SM*A<line>[<cls>] source='avail-line' — from cached availability
 *
 * Reuses the cross-dialect Inventory.seatMapFor + synthesizeAvailability
 * + renderSeatMap pipeline. Header built by `galileoSeatMapHeader`
 * (reconstructed format — Pocket Guide doesn't pin the wording).
 */
async function handleGalileoSeatMapLive(
  segment: AirSegment,
  segmentNumber: number,
  ctx: HandlerContext,
  wa: WorkArea,
  searchIdentifier: string,
  offerId: string,
  productId: string,
): Promise<string> {
  const backend = ctx.backend as LiveTravelportBackend;
  try {
    const raw = await backend.searchSeatAvailabilities({
      searchIdentifier,
      offerId,
      productId,
    });
    const { mapSeatAvailabilities, extractSeatMapError } = await import('../../backends/travelport-mapper.js');
    // Travelport JSON Air v11 returns HTTP 200 + Result.Error[] for
    // semantic errors. Check that envelope BEFORE attempting to map
    // the seat-map body. Same calibration pattern as chunk 1's
    // `retrieveGalileoLive` "RECORD LOCATOR DOES NOT EXIST" fix.
    const err = extractSeatMapError(raw);
    if (err) return err.message;
    const mapped = mapSeatAvailabilities(raw);
    if (!mapped) return 'NO SEAT MAP AVAILABLE';
    wa.lastSeatMap = { segment: segmentNumber, map: mapped.seatMap };
    const header = galileoSeatMapHeader(mapped.seatMap, segment);
    return renderSeatMap(mapped.seatMap, mapped.availability, header, 'V');
  } catch (err) {
    return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Rows shown per page in the paginated Galileo seat-map render. */
const GALILEO_SM_PAGE_SIZE = 20;

function handleGalileoSeatMap(
  entry: import('../../protocol/entry.js').SeatMapEntry,
  wa: WorkArea,
  ctx: HandlerContext,
): string | Promise<string> {
  // SC*<seat> — display IATA PADIS 9825 codes for one seat in the
  // cached seat map. Per the galileoindonesia.com guide.
  if (entry.source === 'direct' && entry.seatLabel) {
    const cached = wa.lastSeatMap;
    if (!cached) return 'NO SEAT MAP DISPLAYED';
    const seatLabel = entry.seatLabel;
    const m = /^(\d+)([A-Z])$/.exec(seatLabel);
    if (!m) return 'INVALID SEAT';
    const [, rowLabel, col] = m;
    const space = cached.map.Cabin
      .flatMap((c) => c.Row.filter((r) => r.label === rowLabel))
      .flatMap((r) => r.Space.filter((s) => s.location === col))[0];
    if (!space) return 'SEAT NOT FOUND';
    return renderSeatCharacteristics(seatLabel, space);
  }
  // MD / MU / MB / MT scroll the cached seat map. Bare verbs from the
  // Mini Format Guide; we route here for now (other display types
  // will need their own routing when they land).
  if (entry.source === 'scroll') {
    const cached = wa.lastSeatMap;
    if (!cached?.cachedSegment) return 'NO SEAT MAP DISPLAYED';
    const cachedSegment = cached.cachedSegment;
    const totalRows = cached.map.Cabin.reduce((sum, c) => sum + c.Row.length, 0);
    const maxOffset = Math.max(0, totalRows - GALILEO_SM_PAGE_SIZE);
    let newOffset = cached.scrollRow ?? 0;
    if (entry.direction === 'down') newOffset = Math.min(newOffset + GALILEO_SM_PAGE_SIZE, maxOffset);
    else if (entry.direction === 'up') newOffset = Math.max(newOffset - GALILEO_SM_PAGE_SIZE, 0);
    else if (entry.direction === 'bottom') newOffset = maxOffset;
    else newOffset = 0; // top
    cached.scrollRow = newOffset;
    const locatorKey = wa.pnr.locator ?? 'PENDING';
    const availability = synthesizeAvailability(cached.map, locatorKey, cachedSegment.date);
    const header = galileoSeatMapHeader(cached.map, cachedSegment);
    return renderSeatMap(cached.map, availability, header, 'V', {
      rowOffset: newOffset,
      rowsPerPage: GALILEO_SM_PAGE_SIZE,
    });
  }
  let segment: AirSegment;
  let segmentNumber: number;

  if (entry.source === 'segment') {
    if (wa.pnr.segments.length === 0) return GalileoResponse.NO_PNR;
    const seg = wa.pnr.segments.find((s) => s.segmentNumber === entry.segment);
    if (!seg) return 'SEGMENT NOT IN ITINERARY';
    segment = seg;
    segmentNumber = entry.segment!;
  } else if (entry.source === 'refresh') {
    // SA* refresh: re-display the most-recently-shown seat map. If
    // none, fall through to NO PNR / no display per Galileo conventions.
    if (!wa.lastSeatMap) return 'NO SEAT MAP DISPLAYED';
    const map = wa.lastSeatMap.map;
    const segNum = wa.lastSeatMap.segment;
    // Try to find the corresponding PNR segment for the header; if
    // not found (avail-line origin, since-cleared), construct a
    // minimal stand-in from the cached map.
    const pnrSeg = wa.pnr.segments.find((s) => s.segmentNumber === segNum);
    if (pnrSeg) {
      segment = pnrSeg;
      segmentNumber = segNum;
    } else {
      segment = {
        segmentNumber: segNum,
        carrier: map.carrier,
        flightNumber: map.flightNumber,
        bookingClass: 'Y',
        date: '01JAN',
        dayOfWeek: '?',
        dayOfWeekNum: 0,
        origin: '???',
        destination: '???',
        status: StatusCode.SS,
        seats: 1,
        departTime: '',
        arriveTime: '',
      };
      segmentNumber = segNum;
    }
    const locatorKey = wa.pnr.locator ?? 'PENDING';
    const availability = synthesizeAvailability(map, locatorKey, segment.date);
    const header = galileoSeatMapHeader(map, segment);
    // SA* refresh preserves the existing scroll position (don't reset).
    return renderSeatMap(map, availability, header, 'V', {
      rowOffset: wa.lastSeatMap.scrollRow ?? 0,
      rowsPerPage: GALILEO_SM_PAGE_SIZE,
    });
  } else if (entry.source === 'avail-line') {
    if (!wa.lastAvailability) return 'NO AVAILABILITY';
    const target = wa.lastAvailability.lines.find((l) => l.line === entry.line);
    if (!target) return 'LINE NOT IN AVAILABILITY';
    segment = {
      segmentNumber: 1,
      carrier: target.carrier,
      flightNumber: target.flightNumber,
      bookingClass: entry.bookingClass ?? 'Y',
      date: target.date,
      dayOfWeek: target.dayOfWeek,
      dayOfWeekNum: target.dayOfWeekNum,
      origin: target.origin,
      destination: target.destination,
      status: StatusCode.SS,
      seats: 1,
      departTime: target.departTime,
      arriveTime: target.arriveTime,
    };
    segmentNumber = 1;
  } else {
    return GalileoResponse.FORMAT; // unreachable
  }

  // Live discrimination: when ctx.backend is LiveTravelportBackend AND
  // we have a searchIdentifier + offerId on the source (avail-line) or
  // the segment's vendorRef, route to the live /seatmaps endpoint.
  // Otherwise use the emulated synthesizer.
  if (ctx.backend instanceof LiveTravelportBackend) {
    let searchIdentifier = wa.lastAvailability?.searchIdentifier;
    // Pull offerId + productId from the avail-line that backed this
    // query (avail-line source) or from the segment's vendorRef
    // (segment source after a live sell).
    let offerId: string | undefined;
    let productId: string | undefined;
    if (entry.source === 'avail-line' && wa.lastAvailability) {
      const target = wa.lastAvailability.lines.find((l) => l.line === entry.line);
      offerId = target?.vendorRef?.offerId;
      productId = target?.vendorRef?.productId;
    } else if (entry.source === 'segment') {
      // Prefer the refs stamped on the segment at sell time — they
      // survive availability churn and BF retrieval (dogfooding find
      // 2026-06-12: the display-cache lookup dies the moment any new
      // A entry replaces lastAvailability). Cache lookup remains as
      // the fallback for segments sold before stamping landed.
      if (segment.vendorRef) {
        searchIdentifier = segment.vendorRef.searchIdentifier;
        offerId = segment.vendorRef.offerId;
        productId = segment.vendorRef.productId;
      } else {
        const line = wa.lastAvailability?.lines.find(
          (l) => l.carrier === segment.carrier && l.flightNumber === segment.flightNumber,
        );
        offerId = line?.vendorRef?.offerId;
        productId = line?.vendorRef?.productId;
      }
    }
    if (searchIdentifier && offerId && productId) {
      return handleGalileoSeatMapLive(
        segment, segmentNumber, ctx, wa, searchIdentifier, offerId, productId,
      );
    }
    // Live backend but no vendorRef available — fall through to
    // emulated synth + LOCAL VIEW trailer. Operators see something
    // useful instead of a hard error.
  }

  const map = ctx.backend.inventory.seatMapFor(segment.carrier, segment.flightNumber);
  if (!map) return 'NO SEAT MAP AVAILABLE';

  const locatorKey = wa.pnr.locator ?? 'PENDING';
  const availability = synthesizeAvailability(map, locatorKey, segment.date);
  // Cache cachedSegment + scrollRow=0 so MD/MU/MB/MT can re-render
  // without re-resolving.
  wa.lastSeatMap = { segment: segmentNumber, map, cachedSegment: segment, scrollRow: 0 };

  const header = galileoSeatMapHeader(map, segment);
  // Filter suffixes: /<row> drives renderer rowOffset. The other
  // filters (preference, paxCount, cogOrigin) have no semantic effect
  // in our emulator — we accept them syntactically but don't filter
  // the rendered cabin. We resolve `fromRow` to an offset by walking
  // the cabin Row list to find the index whose label matches.
  const fromRow = entry.filters?.fromRow;
  const rowOffset = fromRow !== undefined ? rowOffsetForLabel(map, fromRow) : undefined;
  return renderSeatMap(map, availability, header, 'V', {
    rowsPerPage: GALILEO_SM_PAGE_SIZE,
    rowOffset,
  });
}

/**
 * Render the IATA PADIS 9825 characteristic codes for a single seat,
 * with human-readable labels from SCC_LABELS where available. Used by
 * the SC*<seat> verb.
 *
 * Sample output:
 *   SEAT 10A CHARACTERISTICS
 *   W   Window seat
 *   L   Leg space seat
 *
 * If a code has no SCC_LABELS entry, the code prints alone — operators
 * can cross-reference the IATA reference manually.
 */
function renderSeatCharacteristics(label: string, space: import('../../models/seat-map.js').SeatSpace): string {
  const codes = space.Characteristic ?? [];
  const lines = [`SEAT ${label} CHARACTERISTICS`];
  if (codes.length === 0) {
    lines.push('NO CHARACTERISTICS RECORDED');
  } else {
    for (const code of codes) {
      const label = SCC_LABELS[code as keyof typeof SCC_LABELS];
      lines.push(`${code.padEnd(3, ' ')} ${label ?? '(unlabelled)'}`);
    }
  }
  return lines.join('\n');
}

/**
 * Galileo hotel family (HOA / HOI / HOC) — Comparison Guide "Hotels"
 * 5-way table. Reuses the cross-dialect hotel seed + the WorkArea
 * lastHotelAvail cache the Amadeus HA family populates, so a follow-on
 * N<rooms>A<line>D<days> reference sell books from the same store.
 * Response wording reconstructed (the guide documents entries, not
 * screens).
 */
function handleGalileoHotel(
  entry: import('../../protocol/entry.js').HotelEntry,
  wa: WorkArea,
  ctx: HandlerContext,
): string {
  if (entry.action === 'availability' || entry.action === 'index') {
    const props = ctx.backend.inventory.hotelsIn(entry.city!, entry.chain);
    if (props.length === 0) return 'NO HOTELS';
    const checkIn = entry.checkIn ?? '15JUL';
    const checkOut = entry.checkOut ?? checkIn;
    const nights = entry.checkIn && entry.checkOut ? galileoNights(entry.checkIn, entry.checkOut) : 1;
    wa.lastHotelAvail = { city: entry.city!, checkIn, checkOut, nights, properties: props };
    wa.lastCarAvail = undefined; // hotel display replaces a car display
    const title = entry.action === 'index' ? 'HOTEL INDEX' : 'HOTEL AVAILABILITY';
    const lines = [`${title} ${entry.city}${entry.action === 'availability' ? ` ${checkIn}-${checkOut}` : ''}`];
    props.forEach((p, i) => {
      const lo = p.rates.reduce((min, r) => Math.min(min, r.amount), Infinity);
      const cur = p.rates[0]?.currency ?? '';
      lines.push(`${(i + 1).toString().padStart(2, ' ')} ${p.chain}${p.property} ${p.name.padEnd(38, ' ')} ${lo.toFixed(0)}${cur}`);
    });
    return lines.join('\n');
  }
  // HOC<line> — complete availability: all rates for one property.
  const cached = wa.lastHotelAvail;
  if (!cached) return 'NO HOTEL DISPLAY';
  const prop = cached.properties[(entry.line ?? 0) - 1];
  if (!prop) return 'INVALID LINE';
  const lines = [`${prop.chain}${prop.property} ${prop.name}`, `${prop.address} ${prop.city}`];
  prop.rates.forEach((r, i) => {
    lines.push(`${(i + 1).toString().padStart(2, ' ')} ${r.code}  ${r.amount.toFixed(2)} ${r.currency}  AVL ${r.available}`);
  });
  return lines.join('\n');
}

/**
 * Galileo car family (CAL / CAI) — Comparison Guide "Cars" table.
 * Same store + cache the Amadeus CA family uses.
 */
function handleGalileoCar(
  entry: import('../../protocol/entry.js').CarEntry,
  wa: WorkArea,
  ctx: HandlerContext,
): string {
  const rentals = ctx.backend.inventory.carsIn(entry.city!);
  if (rentals.length === 0) return 'NO CARS';
  if (entry.action === 'availability') {
    const pickup = entry.pickup ?? '15JUL';
    const dropoff = entry.dropoff ?? pickup;
    const days = entry.pickup && entry.dropoff ? galileoNights(entry.pickup, entry.dropoff) : 1;
    wa.lastCarAvail = { city: entry.city!, pickup, dropoff, days, rentals };
    wa.lastHotelAvail = undefined; // car display replaces a hotel display
    const lines = [`CAR AVAILABILITY ${entry.city} ${pickup}-${dropoff}`];
    rentals.forEach((r, i) => {
      lines.push(`${(i + 1).toString().padStart(2, ' ')} ${r.company} ${r.vehicleType}  ${r.category.padEnd(20, ' ')} ${r.amount.toFixed(0)}${r.currency}/DY`);
    });
    return lines.join('\n');
  }
  // CAI<city> — vendor index.
  const vendors = [...new Set(rentals.map((r) => r.company))];
  return [`CAR VENDORS ${entry.city}`, ...vendors.map((v, i) => `${i + 1} ${v}`)].join('\n');
}

/**
 * Hotel/car reference sell from the cached aux display — the
 * Comparison Guide's verbatim sell rows:
 *   hotel: N1A2D3  (rooms=1, availability line 2, 3 days)
 *   car:   N1A4    (1 car, availability line 4)
 * The air-sell parser already produces {seats, bookingClass:'A',
 * line} for these shapes; the D<days> tail (hotel) arrives via the
 * legs array as a second pair when present — we re-derive from raw
 * to keep the decomposition explicit. Decomposition interpreted from
 * the guide's examples (the guide shows entries, not field meanings)
 * — flagged as such.
 */
function handleGalileoAuxSell(
  entry: import('../../protocol/entry.js').SellEntry,
  wa: WorkArea,
  ctx: HandlerContext,
): string {
  const m = /^N(\d{1,2})A(\d{1,2})(?:D(\d{1,2}))?$/.exec(entry.raw.toUpperCase());
  if (!m) return GalileoResponse.FORMAT;
  const count = parseInt(m[1], 10);
  const line = parseInt(m[2], 10);
  const days = m[3] ? parseInt(m[3], 10) : undefined;

  if (wa.lastHotelAvail) {
    const cached = wa.lastHotelAvail;
    const prop = cached.properties[line - 1];
    if (!prop) return 'INVALID LINE';
    const rate = prop.rates[0];
    if (!rate || rate.available < 1) return 'NO ROOMS';
    const nights = days ?? cached.nights;
    const seg: import('../../models/hotel.js').HotelSegment = {
      segmentNumber: wa.pnr.segments.length + wa.pnr.hotelSegments.length +
        wa.pnr.carSegments.length + wa.pnr.railSegments.length + 1,
      chain: prop.chain, property: prop.property, name: prop.name,
      city: prop.city, checkIn: cached.checkIn, checkOut: cached.checkOut,
      nights, rateCode: rate.code, ratePerNight: rate.amount,
      currency: rate.currency, rooms: count, status: 'HK',
      confirmationNumber: `HC${galileoConfirmation(prop.chain, prop.property, wa.pnr.hotelSegments.length)}`,
    };
    wa.pnr.hotelSegments.push(seg);
    return `HOTEL SOLD ${seg.segmentNumber}. HHL ${prop.chain} HK${count} ${prop.city} ${cached.checkIn}-${cached.checkOut} ${rate.code} ${rate.amount.toFixed(2)}${rate.currency} ${seg.confirmationNumber}`;
  }

  const cached = wa.lastCarAvail!;
  const rental = cached.rentals[line - 1];
  if (!rental) return 'INVALID LINE';
  if (rental.available < 1) return 'NO CARS';
  const seg: import('../../models/car.js').CarSegment = {
    segmentNumber: wa.pnr.segments.length + wa.pnr.hotelSegments.length +
      wa.pnr.carSegments.length + wa.pnr.railSegments.length + 1,
    company: rental.company, companyName: rental.company,
    vehicleType: rental.vehicleType, category: rental.category,
    rateCode: rental.rateCode, city: rental.city,
    pickup: cached.pickup, dropoff: cached.dropoff, days: cached.days,
    amount: rental.amount, currency: rental.currency, status: 'HK',
    confirmationNumber: `CC${galileoConfirmation(rental.company, rental.vehicleType, wa.pnr.carSegments.length)}`,
  };
  wa.pnr.carSegments.push(seg);
  return `CAR SOLD ${seg.segmentNumber}. CCR ${rental.company} HK ${rental.city} ${cached.pickup}-${cached.dropoff} ${rental.vehicleType} ${rental.amount.toFixed(2)}${rental.currency}/DY ${seg.confirmationNumber}`;
}

/** DJB2-based deterministic 5-digit confirmation (same scheme the
 *  Amadeus aux sells use). */
function galileoConfirmation(a: string, b: string, idx: number): string {
  let hash = 5381;
  const str = `${a}|${b}|${idx}`;
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  return String(Math.abs(hash) % 90000 + 10000);
}

/** Crude DDMON ordinal difference (same scheme as the Amadeus
 *  computeNights — months treated as 31 days; emulator-fine). */
function galileoNights(a: string, b: string): number {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const parse = (s: string): number | null => {
    const m = /^(\d{1,2})([A-Z]{3})$/.exec(s);
    if (!m) return null;
    const mon = months.indexOf(m[2]);
    return mon < 0 ? null : mon * 31 + parseInt(m[1], 10);
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa == null || pb == null) return 1;
  return pb - pa > 0 ? pb - pa : 1;
}

/**
 * Resolve a row label (a numeric like 15) to its 0-based index within
 * the seat map's combined cabin row list. Returns 0 if the label
 * isn't found (so the render starts from the top — a sensible default
 * when the operator requests a row that's outside the cabin range).
 */
function rowOffsetForLabel(
  map: import('../../models/seat-map.js').SeatMap,
  fromRow: number,
): number {
  let offset = 0;
  for (const cabin of map.Cabin) {
    for (const row of cabin.Row) {
      if (parseInt(row.label, 10) === fromRow) return offset;
      offset++;
    }
  }
  return 0;
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

/**
 * `*TE<n>` / `*TE/<ticket>` — display one eticket from the list.
 *
 * Live path: fetch `/receipts` (same as `*HTE`), then index by
 * `opts.index` (1-based) or match by `opts.number`. Emulated reads
 * `wa.pnr.tickets`.
 *
 * Output: a single ticket line (same format as the list, just one
 * row). The Mini Guide documents the entry, not the detail screen;
 * the v1 render is the same `renderGalileoTicketList` filtered to one.
 * Empty match: `TICKET NOT FOUND` (reconstructed).
 */
async function ticketShowGalileo(
  wa: WorkArea,
  ctx: HandlerContext,
  opts: { index?: number; number?: string; pred?: (t: TicketRecord) => boolean }
): Promise<string> {
  if (ctx.backend instanceof LiveTravelportBackend && wa.pnr.locator) {
    try {
      const response = await ctx.backend.listReceipts(wa.pnr.locator);
      wa.pnr.tickets = mapReceipts(response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/HTTP 40[4]|HTTP 410/.test(msg)) return GalileoResponse.NO_PNR;
      return `LIVE BACKEND ERROR: ${msg}`; // reconstructed
    }
  }
  if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
  let ticket: typeof wa.pnr.tickets[number] | undefined;
  if (opts.index != null) ticket = wa.pnr.tickets[opts.index - 1];
  if (opts.number != null) ticket = wa.pnr.tickets.find((t) => t.number === opts.number);
  if (opts.pred != null) ticket = wa.pnr.tickets.find(opts.pred);
  if (!ticket) return 'TICKET NOT FOUND'; // reconstructed
  wa.lastTicketDocument = ticket.number; // *TEH follows up on this record
  return renderGalileoTicketList([ticket]);
}

/**
 * `*TEH` — e-ticket history, "use as a follow-up entry after
 * displaying the appropriate ticket record" (Formats Guide, in-tree).
 * Renders the lifecycle rows we track: issuance and void. Layout
 * reconstructed.
 */
function ticketHistoryGalileo(wa: WorkArea, ctx: HandlerContext): string {
  const num = wa.lastTicketDocument;
  if (!num) return 'NO ETICKET DISPLAYED'; // reconstructed — *TEH is a follow-up entry
  let ticket = wa.pnr.tickets.find((t) => t.number === num);
  if (!ticket) {
    for (const pnr of ctx.backend.pnrs.values()) {
      ticket = pnr.tickets.find((t) => t.number === num);
      if (ticket) break;
    }
  }
  if (!ticket) return 'TICKET NOT FOUND'; // reconstructed
  const fmt = (d: Date) =>
    `${String(d.getUTCDate()).padStart(2, '0')}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const rows = [`ETKT HISTORY ${ticket.number}`, `  ISSUED ${fmt(ticket.issuedAt)}  ${ticket.passenger}  ${ticket.validatingCarrier}`];
  if (ticket.status === 'VOIDED' && ticket.voidedAt) rows.push(`  VOIDED ${fmt(ticket.voidedAt)}`);
  return rows.join('\n');
}

/**
 * `*H` / `*HI` / `*HFF` / `*HNP` — display BF change-log history.
 *
 * LOCAL-ONLY BY DESIGN. Re-verified 2026-06-06 against the GDS
 * reference-payload devkit: v11 has ONLY `POST /documents/history`
 * which is TICKET-SCOPED (TKT/MCO/EMD/INV) and doesn't cover
 * itinerary / name / remark / filed-fare change history. Same
 * structural constraint as `@<n>HK` segment-status override —
 * Travelport's modern REST surface doesn't expose mainframe-style
 * mutation logs. We shadow mutations into `wa.pnr.history[]`
 * client-side at the dispatch wrappers (`modifyTransition`,
 * `sellTransition`, `addFieldTransition`); when populated, render
 * it as the change log; otherwise fall back to the composite of
 * current state (legacy v1 behaviour preserved for empty PNRs).
 *
 * `*HTE` / `*HTI` (ticket history specifically) are NOT this path —
 * they fetch live tickets via `listReceipts` + render through
 * `ticketListGalileo`. The cryptic family overlaps but the data
 * sources are different.
 */
function historyAllGalileo(wa: WorkArea): string {
  if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
  if (wa.pnr.history.length > 0) {
    return renderHistoryLog(wa);
  }
  // Fallback: composite of current state (no mutation log captured).
  const sections: string[] = [];
  if (wa.pnr.segments.length > 0) {
    sections.push('ITINERARY', renderGalileoItinerary(wa.pnr));
  }
  if (wa.pnr.priceQuotes.length > 0) {
    sections.push('FILED FARES', renderFiledFareList(wa));
  }
  const notepads = wa.pnr.remarks.filter((r) => r.type === 'general' || r.type === 'historical');
  if (notepads.length > 0) {
    sections.push('NOTEPADS', notepads.map((r, i) => `  ${i + 1}.NP.${r.text}`).join('\n'));
  }
  if (wa.pnr.tickets.length > 0) {
    sections.push('TICKETS', renderGalileoTicketList(wa.pnr.tickets));
  }
  if (sections.length === 0) return 'NO HISTORY'; // reconstructed
  return sections.join('\n');
}

/**
 * Render `pnr.history[]` as a Galileo `*H` change-log screen.
 * Reconstructed format `<n>.<HH:MM> <text>` — Mini Guide documents
 * the entry but not the display layout.
 */
function renderHistoryLog(wa: WorkArea, opts?: { pred?: (h: import('../../models/pnr.js').HistoryEntry) => boolean; title?: string }): string {
  const head = `HISTORY ${wa.pnr.locator ?? ''}${opts?.title ? ' - ' + opts.title : ''}`.trim();
  const entries = opts?.pred ? wa.pnr.history.filter(opts.pred) : wa.pnr.history;
  if (opts?.pred && entries.length === 0) return `NO ${opts.title ?? ''} HISTORY`.replace('  ', ' '); // reconstructed
  const rows = entries.map((h, i) => {
    const ts = h.timestamp;
    const hh = String(ts.getUTCHours()).padStart(2, '0');
    const mm = String(ts.getUTCMinutes()).padStart(2, '0');
    return `${String(i + 1).padStart(3)}. ${(h.code ?? '').padEnd(3)} ${hh}:${mm} ${h.text}`;
  });
  return [head, ...rows].join('\n');
}

/**
 * `*HI` / `*HIA` — Itinerary history. v11 has no change log; render
 * the current itinerary as the v1 stand-in. Mini Guide notes `*HI`
 * includes Hotel/Car but we only model Air.
 */
function historyItineraryGalileo(wa: WorkArea): string {
  if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
  if (wa.pnr.segments.length === 0) return 'NO ITINERARY'; // reconstructed
  return renderGalileoItinerary(wa.pnr);
}

/**
 * `*HFF` — Filed fares history. v11 has no change log; render the
 * current `pnr.priceQuotes[]` as the v1 stand-in.
 */
function historyFiledFaresGalileo(wa: WorkArea): string {
  if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
  if (wa.pnr.priceQuotes.length === 0) return 'NO FILED FARES'; // reconstructed
  return renderFiledFareList(wa);
}

/**
 * `*HNP` — Notepad history. v11 has no change log; render the
 * current `pnr.remarks` (general + historical) as the v1 stand-in.
 */
function historyNotepadsGalileo(wa: WorkArea): string {
  if (!wa.pnr.hasContent()) return GalileoResponse.NO_PNR;
  const notepads = wa.pnr.remarks.filter((r) => r.type === 'general' || r.type === 'historical');
  if (notepads.length === 0) return 'NO NOTEPADS'; // reconstructed
  return notepads
    .map((r, i) => `${i + 1}.NP.${r.type === 'historical' ? 'H**' : ''}${r.text}`)
    .join('\n');
}

/**
 * Render the filed-fare list — one row per FareQuote in the PNR.
 * Reconstructed format `<n>. FQ <carrier> <currency> <total>`.
 */
function renderFiledFareList(wa: WorkArea): string {
  return wa.pnr.priceQuotes
    .map((fq, i) => {
      const total = fq.passengers.reduce(
        (sum, p) => sum + (p.total ?? 0) * (p.count ?? 1),
        0
      );
      return `  ${i + 1}.FQ ${fq.validatingCarrier} ${fq.currency} ${total.toFixed(2)}`;
    })
    .join('\n');
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
  if (
    entry.op === 'exit' ||
    entry.op === 'exit_ignore' ||
    entry.op === 'exit_end_tx' ||
    entry.op === 'exit_ignore_redisplay' ||
    entry.op === 'exit_end_redisplay'
  ) {
    return handleGalileoQueueExit(entry, wa, ctx);
  }
  if (entry.op === 'remove') return handleGalileoQueueRemove(entry, wa, ctx);
  if (entry.op === 'remove_all_in_pcc') return handleGalileoQueueRemoveAll(entry, wa, ctx);
  if (entry.op === 'previous' || entry.op === 'previous_ignore') {
    return handleGalileoQueuePrevious(entry, wa, ctx);
  }
  if (entry.op === 'count_all') return handleGalileoQueueCountAll(entry, wa, ctx);
  if (entry.op === 'where') return handleGalileoQueueWhere(wa, ctx);
  if (entry.op === 'display_titles') return handleGalileoQueueTitles();
  if (!entry.queue) return GalileoResponse.FORMAT;
  if (entry.op === 'access') return handleGalileoQueueAccess(entry, wa, ctx);
  if (entry.op !== 'place') return GalileoResponse.FORMAT;
  const queue = entry.queue;

  // QEB embeds an end-transaction: commit first if no locator. When
  // a locator is already on screen (post-retrieve, post-commit), the
  // commit phase is skipped and QEB acts as a pure place. Per
  // multiple Galileo sources (Smartpoint Cloud Help, agency training
  // PDFs), QEB is the universal queue-place verb for both states —
  // there is no separate "place without end-tx" cryptic.
  const committedNow = !wa.pnr.locator;
  if (!wa.pnr.locator) {
    const commitResp = await commitForQueueEnd(wa, ctx);
    if (commitResp.error) return commitResp.error;
  }
  const locator = wa.pnr.locator!;

  // Multi-queue chain (`QEB/35+40+45`), branch-PCC (`QEB/<PCC>/<n>`),
  // and category/date-range qualifiers (`QEB/42*CAB*D4`). v11 place
  // endpoint accepts a `Queue[]` array — one POST covers every target.
  // Each entry carries its own pccOverride / category / dateOffset.
  // Per Galileo cryptic, qualifiers apply uniformly across the chain.
  const branchPcc = entry.pic;
  const queueExtras: {
    pccOverride?: string;
    category?: string;
    dateOffset?: number;
  } = {};
  if (branchPcc) queueExtras.pccOverride = branchPcc;
  if (entry.category) queueExtras.category = entry.category;
  if (entry.dateRange != null) queueExtras.dateOffset = entry.dateRange;
  const queues: Array<{
    value: string;
    pccOverride?: string;
    category?: string;
    dateOffset?: number;
  }> = [
    { value: queue, ...queueExtras },
    ...(entry.additionalTargets ?? []).map((t) => ({
      value: t.queue,
      ...queueExtras,
    })),
  ];
  if (ctx.backend instanceof LiveTravelportBackend) {
    try {
      await ctx.backend.placeOnQueue(locator, queues);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  }

  // Emulated mirror: append the locator to every target queue. Branch-
  // PCC isn't modelled locally (the mirror is a flat Map<queueId,
  // locator[]> regardless of PCC), so multi-PCC bookings see all
  // placements coalesce by queue id. Pragmatic for v1.
  for (const q of queues) {
    const list = ctx.backend.queues.get(q.value) ?? [];
    if (!list.includes(locator)) list.push(locator);
    ctx.backend.queues.set(q.value, list);
  }

  const label = branchPcc
    ? `${branchPcc}/${queues.map((q) => q.value).join('+')}`
    : queues.map((q) => q.value).join('+');
  // Queue-trail history (H/HIST code AQ "Added to queue trail") —
  // stamped on the stored PNR so *HQT shows it on a later retrieve.
  const stored = ctx.backend.pnrs.get(locator);
  if (stored) {
    for (const q of queues) {
      stored.history.push({ timestamp: new Date(), text: `QUEUE PLACE ${q.value}`, code: 'AQ' });
    }
  }
  // When QEB performed the implicit end-transaction, surface the
  // newly-assigned locator — otherwise the operator's only record
  // of their BF's identity is never shown (a live session placed a
  // BF, accessed the queue, found a STRANGER'S BF first, and had no
  // locator to retrieve their own). Reconstructed wording.
  return committedNow ? `OK-QUEUE ${label} - ${locator}` : `OK-QUEUE ${label}`;
}

/**
 * `QR` / `QR/<n>[+<n>...]` — Remove the on-screen committed BF from
 * queues. Source: Galileo Pocket Guide p.13 + Mini Format Guide v2 p.45.
 *
 * Forms:
 *  - `QR`           — remove from the active queue (wa.currentQueue).
 *                     Requires `wa.currentQueue` AND `wa.pnr.locator`.
 *  - `QR/23`        — remove from queue 23 (active queue not required
 *                     when an explicit target is given). Requires
 *                     `wa.pnr.locator`.
 *  - `QR/23+77`     — multi-queue: active queue + 23 + 77 if active is
 *                     set; else just 23 + 77. Mini Guide says "Remove
 *                     booking file from active queue plus queue 23 and
 *                     77" — so the active queue is implicit when
 *                     present alongside explicit targets.
 *
 * Live path uses `removeFromQueues(locator, queues[])` for the
 * single-call multi-queue body when more than one queue is targeted;
 * single-queue calls fall back to `removeFromQueue` to keep the body
 * simple. Local mirror in `backend.queues` is updated to match.
 */
async function handleGalileoQueueRemove(
  entry: QueueEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  const locator = wa.pnr.locator;
  if (!locator) return GalileoResponse.FORMAT;
  const explicit: string[] = [];
  if (entry.queue) explicit.push(entry.queue);
  for (const t of entry.additionalTargets ?? []) explicit.push(t.queue);
  // Active queue is implicit only when present (Mini Guide: "active
  // queue plus 23 and 77"). Bare `QR` with no active queue → FORMAT.
  const active = wa.currentQueue;
  const queues = [...new Set(active ? [active, ...explicit] : explicit)];
  if (queues.length === 0) return GalileoResponse.FORMAT;
  if (ctx.backend instanceof LiveTravelportBackend) {
    try {
      if (queues.length === 1) {
        await ctx.backend.removeFromQueue(locator, queues[0]);
      } else {
        await ctx.backend.removeFromQueues(locator, queues);
      }
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
  // Queue-trail history (H/HIST code XQ "Removed from queue").
  {
    const stored = ctx.backend.pnrs.get(locator);
    if (stored) {
      for (const q of queues) {
        stored.history.push({ timestamp: new Date(), text: `QUEUE REMOVE ${q}`, code: 'XQ' });
      }
    }
  }

  // Queue-cursor advance: if we're working a queue context AND the
  // removed locator was the one at our cursor, drop it from the
  // working set and load the next BF. Real Galileo: QR removes the
  // current BF and advances to the next one on screen.
  if (
    active &&
    wa.queueWorkingSet &&
    wa.queueCursor != null &&
    wa.queueWorkingSet[wa.queueCursor] === locator
  ) {
    wa.queueWorkingSet.splice(wa.queueCursor, 1);
    if (wa.queueWorkingSet.length === 0) {
      wa.currentQueue = undefined;
      wa.queueCursor = undefined;
      wa.queueWorkingSet = undefined;
      return `QUEUE ${active} EMPTY`; // reconstructed
    }
    if (wa.queueCursor >= wa.queueWorkingSet.length) wa.queueCursor = 0;
    return loadQueueBfAtCursor(wa, ctx);
  }

  return `OK-QUEUE REMOVE ${queues.join('+')}`; // reconstructed
}

/**
 * `QCA` / `QCA*<n>` — Count / list all queues containing booking
 * files. Source: Smartpoint Cloud Help (verbatim 2026-05-29):
 *   QCA      "List all queues containing active booking files"
 *   QCA*30   "List all queues containing more than 30 booking files"
 *
 * v11 has no "list all queues" REST endpoint — querying each of the
 * 100 queues with `listQueue` would be wasteful. We read the local
 * `backend.queues` mirror, which is the authoritative count for any
 * activity that happened during this session. Server-side queue
 * activity that happened outside the session won't be reflected;
 * documented in the spec doc.
 *
 * Output: one line per non-empty queue (or per queue ≥ threshold),
 * `QUEUE <n>  <count> BFS`. Empty result: `NO QUEUES`. All response
 * strings reconstructed — Smartpoint Cloud documents the entry, not
 * the screen.
 */
function handleGalileoQueueCountAll(
  entry: QueueEntry,
  _wa: WorkArea,
  ctx: HandlerContext
): string {
  const threshold = entry.countThreshold ?? 0;
  const rows: Array<{ queue: string; count: number }> = [];
  for (const [queue, locators] of ctx.backend.queues.entries()) {
    if (locators.length > threshold) rows.push({ queue, count: locators.length });
  }
  if (rows.length === 0) return 'NO QUEUES'; // reconstructed
  rows.sort((a, b) => (a.queue < b.queue ? -1 : a.queue > b.queue ? 1 : 0));
  return rows.map((r) => `QUEUE ${r.queue.padEnd(4)} ${String(r.count).padStart(3)} BFS`).join('\n');
}

/**
 * `QW` — Queue Where: list all queues containing the on-screen BF.
 * Source: Smartpoint Cloud Help (verbatim 2026-05-29).
 *
 * v11 has no "where is this locator" REST endpoint. We scan the local
 * `backend.queues` mirror for membership. Same caveat as QCA — only
 * sees activity routed through this emulator. Empty result (BF on no
 * queues, or no BF on screen) → `NO QUEUES`.
 */
function handleGalileoQueueWhere(wa: WorkArea, ctx: HandlerContext): string {
  const locator = wa.pnr.locator;
  if (!locator) return GalileoResponse.NO_PNR;
  const queues: string[] = [];
  for (const [queue, locators] of ctx.backend.queues.entries()) {
    if (locators.includes(locator)) queues.push(queue);
  }
  if (queues.length === 0) return 'NO QUEUES'; // reconstructed
  queues.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `BF ${locator} ON QUEUES: ${queues.join(', ')}`; // reconstructed
}

/**
 * `QPB*` — Display queue titles. We don't model titles
 * (`backend.queues` is keyed by id only — no title field). Stub.
 */
function handleGalileoQueueTitles(): string {
  return 'NO TITLES SET'; // reconstructed
}

/**
 * `QP` / `QPI` — Move the queue cursor back 1 and load the BF at the
 * new position. Source: Smartpoint Cloud FreqFormats (verbatim
 * 2026-05-29).
 *
 *   QP   "Move back 1 in the queue (Queue Previous)"
 *   QPI  "Ignore current booking file and move back 1 in the queue"
 *
 * Preconditions:
 *  - Must be in a queue context (`wa.currentQueue` + working set).
 *  - Cursor must be > 0; at the top, returns `TOP OF QUEUE`
 *    (reconstructed — Smartpoint Cloud doesn't quote the boundary
 *    response wording).
 *
 * The "Ignore" in QPI is what distinguishes it from QP:
 *  - QP at a CLEAN BF (no modifications since cursor load): navigate
 *    back.
 *  - QP at a DIRTY BF (modifications since load): refuse with
 *    `USE QPI OR END` (reconstructed) — agent must either commit
 *    via end-transaction (E) or explicitly discard via QPI.
 *  - QPI always navigates back regardless of dirty state. The
 *    backward reload is what discards the in-memory modifications
 *    (real Galileo: every cursor movement re-pulls the BF from the
 *    server, so any local changes are abandoned).
 */
async function handleGalileoQueuePrevious(
  entry: QueueEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  const set = wa.queueWorkingSet;
  const cursor = wa.queueCursor;
  if (!wa.currentQueue || !set || cursor == null) {
    return 'NO QUEUE CONTEXT'; // reconstructed
  }
  if (cursor === 0) return 'TOP OF QUEUE'; // reconstructed
  if (entry.op === 'previous' && wa.queueCurrentDirty) {
    return 'USE QPI OR END'; // reconstructed — Smartpoint Cloud doesn't quote it
  }
  wa.queueCursor = cursor - 1;
  return loadQueueBfAtCursor(wa, ctx);
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
  // Queue-trail history (H/HIST code XQ "Removed from queue").
  {
    const stored = ctx.backend.pnrs.get(locator);
    if (stored) {
      for (const q of queues) {
        stored.history.push({ timestamp: new Date(), text: `QUEUE REMOVE ${q}`, code: 'XQ' });
      }
    }
  }
  return 'OK-QUEUE REMOVE ALL'; // reconstructed
}

/**
 * `QX` / `QXI` / `QXE` / `QXIR` / `QXER` — Sign out of the queue cursor.
 *
 *  - QX:   pure exit. Clear `wa.currentQueue` and `wa.queueCursor`,
 *          return `OK-QUEUE EXIT`. Work area is untouched.
 *  - QXI:  exit + ignore. Routes through the same path as `I` (live
 *          workbench DELETE + reset WA). Returns `IGNORED`.
 *  - QXE:  exit + end-tx. Routes through the same path as `E`
 *          (mandatory-field check + commit). Returns the locator.
 *  - QXIR: exit + ignore + REDISPLAY the on-screen BF. Composes QXI
 *          with a re-retrieve via the same path `*<locator>` uses.
 *          Source: Zenon course p.54.
 *  - QXER: exit + end-tx + REDISPLAY the resulting BF. Composes QXE
 *          with the existing `EndTransactionEntry.redisplay` flag.
 *
 * No REST equivalent for the exit itself — pure cursor op. The
 * composed forms reuse the I/E/retrieve handlers so behaviour stays
 * in sync.
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
  if (entry.op === 'exit_ignore_redisplay') {
    // QXIR — same as QXI, but then re-retrieve the prior locator so
    // the agent sees the pristine BF. Delegate to `handleGalileoIgnore`
    // with `retrieve: true` — that's exactly the IR semantics.
    return handleGalileoIgnore(
      { kind: 'ignore', raw: entry.raw, timestamp: entry.timestamp, retrieve: true },
      wa,
      ctx
    );
  }
  if (entry.op === 'exit_end_redisplay') {
    // QXER — commit AND redisplay the BF. Reuse handleGalileoEndTransaction
    // with `redisplay: true`. If the commit fails (missing field, names
    // mismatch), the handler returns the rejection string and leaves the
    // WA intact for correction.
    return handleGalileoEndTransaction(
      { kind: 'end_transaction', raw: entry.raw, timestamp: entry.timestamp, redisplay: true },
      wa,
      ctx
    );
  }
  return 'OK-QUEUE EXIT'; // reconstructed
}

/**
 * `Q/<n>` — Access a queue and load the first booking file on screen.
 * Source: Travelport Smartpoint Cloud Help (verified 2026-05-29):
 * *"Select the queue number to display the first booking file in the
 * selected queue."*
 *
 * Captures the queue's locator list as `wa.queueWorkingSet`, sets
 * `wa.queueCursor = 0`, and retrieves the BF at cursor onto
 * `wa.pnr`. The agent then navigates with QP / QPI / I / QR / QX.
 *
 * Live path: POST `/queue/queue/list` for the working set, then GET
 * `/reservations/{loc}` for the first BF.
 * Emulated path: read `ctx.backend.queues` for the working set,
 * `ctx.backend.pnrs` for the first BF.
 *
 * Empty queue: returns `QUEUE <n> EMPTY` and does NOT set the
 * cursor / working set (no BF on screen).
 */
async function handleGalileoQueueAccess(
  entry: QueueEntry,
  wa: WorkArea,
  ctx: HandlerContext
): Promise<string> {
  const queue = entry.queue!;
  // Dogfooding find (2026-06-12 log, 03:23:11): re-entering Q/<n>
  // from a dirty queue BF silently reloaded it and wiped the
  // operator's uncommitted R. — the exact hazard QP guards against.
  // Same guard: commit (E/ER) or explicitly discard (I) first.
  if (wa.queueCurrentDirty) {
    return 'USE I OR END'; // reconstructed — parallels QP's USE QPI OR END
  }
  let locators: string[];
  if (ctx.backend instanceof LiveTravelportBackend) {
    try {
      const opts: { dateOffset?: number; pccOverride?: string; category?: string } = {};
      if (entry.pic) opts.pccOverride = entry.pic;
      if (entry.category) opts.category = entry.category;
      if (entry.dateRange != null) opts.dateOffset = entry.dateRange;
      const response = await ctx.backend.listQueue(queue, opts);
      const result = mapQueueList(response, queue);
      locators = result.items.map((it) => it.locator);
    } catch (err) {
      return `LIVE BACKEND ERROR: ${err instanceof Error ? err.message : String(err)}`; // reconstructed
    }
  } else {
    locators = [...(ctx.backend.queues.get(queue) ?? [])];
  }

  if (locators.length === 0) {
    // Don't enter queue context if the queue is empty — agent has
    // nothing to navigate.
    return `QUEUE ${queue} EMPTY`; // reconstructed
  }

  wa.currentQueue = queue;
  wa.queueWorkingSet = locators;
  wa.queueCursor = 0;
  return loadQueueBfAtCursor(wa, ctx);
}

/**
 * Pull the BF at `wa.queueCursor` from `wa.queueWorkingSet` onto
 * screen. Live path GETs the reservation; emulated reads pnrStore.
 * Returns the rendered BF. Missing-locator (404) and end-of-queue
 * conditions surface as reconstructed strings.
 */
async function loadQueueBfAtCursor(wa: WorkArea, ctx: HandlerContext): Promise<string> {
  const set = wa.queueWorkingSet;
  const cursor = wa.queueCursor;
  if (!set || cursor == null) return 'NO QUEUE CONTEXT'; // reconstructed
  if (cursor >= set.length) return `QUEUE ${wa.currentQueue} EMPTY`; // reconstructed
  if (cursor < 0) return 'TOP OF QUEUE'; // reconstructed
  // Loading a BF at the cursor implicitly discards any modifications
  // made to whatever was on screen before. Real Galileo: every cursor
  // movement re-pulls the BF from server.
  wa.queueCurrentDirty = false;
  const locator = set[cursor];
  const sig = { pcc: ctx.pcc, agent: wa.agent };
  if (ctx.backend instanceof LiveTravelportBackend) {
    return retrieveGalileoLive(locator, wa, ctx, ctx.backend, sig);
  }
  const pnr = retrieveStoredBf(ctx, locator);
  if (!pnr) return GalileoResponse.NO_PNR;
  wa.pnr = pnr;
  wa.machine.transition(SessionEvent.RETRIEVE);
  return renderGalileoPnr(pnr, sig);
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
  modifyTransition(wa);
  return `OK-DIVIDE P${passenger}`; // reconstructed
}
