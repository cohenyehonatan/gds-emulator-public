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

import type { ParsedEntry, AvailabilityEntry, SellEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../../session/work-area.js';
import type { HandlerContext } from '../../session/handlers/context.js';
import type { AirSegment } from '../../models/segment.js';
import { StatusCode } from '../../protocol/constants.js';
import { SessionEvent } from '../../session/session-state.js';
import { InvalidTransitionError } from '../../session/session-machine.js';
import { dayOfWeekLetter, dayOfWeekNumber } from '../../session/handlers/context.js';
import { to24h } from '../../utils/validation.js';
import {
  renderGalileoSignInResponse,
  renderGalileoSignOffResponse,
  renderGalileoSwitchAreaResponse,
  renderGalileoAvailability,
  renderGalileoSoldSegment,
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
