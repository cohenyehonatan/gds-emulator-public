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
} from '../../protocol/entry.js';
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
} from './serializer.js';
import { GalileoResponse } from './responses.js';

export const GALILEO_NOT_IMPLEMENTED = 'NOT IMPLEMENTED — galileo dialect';

export function dispatchGalileo(
  entry: ParsedEntry,
  wa: WorkArea,
  ctx: HandlerContext
): string {
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
function handleGalileoAvailability(
  entry: AvailabilityEntry,
  wa: WorkArea,
  ctx: HandlerContext
): string {
  if (entry.mode !== 'display') return GALILEO_NOT_IMPLEMENTED;
  const date = entry.date!;
  const dow = {
    letter: dayOfWeekLetter(date.month, date.day),
    num: dayOfWeekNumber(date.month, date.day),
  };
  const lines = ctx.backend.inventory.availability(date.raw, dow, entry.origin!, entry.destination!, {
    carriers: entry.carriers,
  });
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
  const line = avail.lines.find((l) => l.line === entry.line);
  if (!line) return GalileoResponse.FORMAT;
  if ((line.classes[entry.bookingClass] ?? 0) < entry.seats) return 'CLASS NOT AVAILABLE'; // reconstructed

  // ADD_FIELD-style state transition — the SessionMachine treats a sell on
  // an empty work area as "start building".
  wa.machine.transition(SessionEvent.SELL);
  ctx.backend.inventory.sell(avail.date, line.carrier, line.flightNumber, entry.bookingClass, entry.seats);
  const seg: AirSegment = {
    segmentNumber: wa.pnr.segments.length + 1,
    carrier: line.carrier,
    flightNumber: line.flightNumber,
    bookingClass: entry.bookingClass,
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
  wa.pnr.segments.push(seg);
  return renderGalileoSoldSegment(seg);
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
