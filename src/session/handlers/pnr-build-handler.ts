/**
 * Handle the PNR-building entries: sell ('0') and the field entries
 * (name, phone, ticketing, received-from). Each advances the session FSM
 * (SELL or ADD_FIELD) and mutates the work-area PNR.
 */

import type {
  SellEntry,
  NameEntry,
  PhoneEntry,
  TicketingEntry,
  ReceivedFromEntry,
} from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { SessionEvent } from '../session-state.js';
import { parseNameText } from '../../models/name-element.js';
import { parsePhoneText } from '../../models/phone-element.js';
import { renderSoldSegment } from '../../protocol/serializer.js';
import { StatusCode } from '../../protocol/constants.js';
import { Response } from '../../protocol/constants.js';
import type { AirSegment } from '../../models/segment.js';
import { dayOfWeekLetter, type HandlerContext } from './context.js';

export function handleSell(entry: SellEntry, wa: WorkArea, ctx: HandlerContext): string {
  const segment =
    entry.mode === 'direct'
      ? buildDirectSegment(entry, wa, ctx)
      : buildAvailabilitySegment(entry, wa, ctx);
  if (typeof segment === 'string') return segment; // error response

  wa.machine.transition(SessionEvent.SELL);
  wa.pnr.segments.push(segment);
  return renderSoldSegment(segment);
}

/** Sell (or waitlist) from a cached availability line. */
function buildAvailabilitySegment(
  entry: SellEntry,
  wa: WorkArea,
  ctx: HandlerContext
): AirSegment | string {
  const avail = wa.lastAvailability;
  if (!avail) return 'NO AVAILABILITY DISPLAYED'; // TODO confirm wording
  const line = avail.lines.find((l) => l.line === entry.line);
  if (!line) return Response.FORMAT;

  // Waitlist (LL) is allowed even with no seats; it does not draw down inventory.
  if (!entry.waitlist) {
    const ok = ctx.inventory.sell(avail.date, line.carrier, line.flightNumber, entry.bookingClass, entry.seats);
    if (!ok) return 'CLASS NOT AVAILABLE'; // TODO confirm wording
  }

  return {
    segmentNumber: wa.pnr.segments.length + 1,
    carrier: line.carrier,
    flightNumber: line.flightNumber,
    bookingClass: entry.bookingClass,
    date: avail.date,
    dayOfWeek: line.dayOfWeek,
    origin: line.origin,
    destination: line.destination,
    status: entry.waitlist ? StatusCode.LL : StatusCode.SS,
    seats: entry.seats,
    departTime: line.departTime,
    arriveTime: line.arriveTime,
  };
}

/** Long sell / passive / open: trust the typed data; don't draw inventory. */
function buildDirectSegment(entry: SellEntry, wa: WorkArea, ctx: HandlerContext): AirSegment {
  const sched = !entry.open && entry.flightNumber
    ? ctx.inventory.scheduleFor(entry.carrier!, entry.flightNumber)
    : undefined;
  return {
    segmentNumber: wa.pnr.segments.length + 1,
    carrier: entry.carrier!,
    flightNumber: entry.open ? 'OPEN' : entry.flightNumber!,
    bookingClass: entry.bookingClass,
    date: entry.date!.raw,
    dayOfWeek: dayOfWeekLetter(entry.date!.month, entry.date!.day),
    origin: entry.origin!,
    destination: entry.destination!,
    status: entry.status ?? StatusCode.NN,
    seats: entry.seats,
    departTime: sched?.departTime ?? '',
    arriveTime: sched?.arriveTime ?? '',
    airlineLocator: entry.airlineLocator,
  };
}

export function handleName(entry: NameEntry, wa: WorkArea): string {
  wa.machine.transition(SessionEvent.ADD_FIELD);
  wa.pnr.names.push(parseNameText(entry.text));
  return Response.OK;
}

export function handlePhone(entry: PhoneEntry, wa: WorkArea): string {
  wa.machine.transition(SessionEvent.ADD_FIELD);
  wa.pnr.phones.push(parsePhoneText(entry.text));
  return Response.OK;
}

export function handleTicketing(entry: TicketingEntry, wa: WorkArea): string {
  wa.machine.transition(SessionEvent.ADD_FIELD);
  wa.pnr.ticketing = entry.text;
  return Response.OK;
}

export function handleReceivedFrom(entry: ReceivedFromEntry, wa: WorkArea): string {
  wa.machine.transition(SessionEvent.ADD_FIELD);
  wa.pnr.receivedFrom = entry.text;
  return Response.OK;
}
