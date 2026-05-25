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
import { parseClockToMinutes } from '../../utils/validation.js';
import { dayOfWeekLetter, dayOfWeekNumber, nextDay, type HandlerContext } from './context.js';

/** Mark an overnight (next-day) arrival when the arrival time precedes departure. */
function withArrival(seg: AirSegment): AirSegment {
  const dep = parseClockToMinutes(seg.departTime);
  const arr = parseClockToMinutes(seg.arriveTime);
  if (dep != null && arr != null && arr < dep) {
    const nd = nextDay(seg.date);
    if (nd) {
      seg.arriveDate = nd.raw;
      seg.arriveDayOfWeek = nd.letter;
      seg.arriveDayOfWeekNum = nd.num;
    }
  }
  return seg;
}

export function handleSell(entry: SellEntry, wa: WorkArea, ctx: HandlerContext): string {
  if (entry.mode === 'direct') {
    const seg = buildDirectSegment(entry, wa, ctx);
    wa.machine.transition(SessionEvent.SELL);
    wa.pnr.segments.push(seg);
    return renderSoldSegment(seg);
  }

  const segs = buildAvailabilitySegments(entry, wa, ctx);
  if (typeof segs === 'string') return segs; // error response
  wa.machine.transition(SessionEvent.SELL);
  segs.forEach((s) => wa.pnr.segments.push(s));
  return segs.map(renderSoldSegment).join('\n');
}

/** Sell (or waitlist) one or more legs from a cached availability display. */
function buildAvailabilitySegments(
  entry: SellEntry,
  wa: WorkArea,
  ctx: HandlerContext
): AirSegment[] | string {
  const avail = wa.lastAvailability;
  if (!avail) return 'NO AVAILABILITY DISPLAYED'; // TODO confirm wording
  const legs = entry.legs ?? [{ bookingClass: entry.bookingClass, line: entry.line! }];

  // Resolve which (class, line) pairs to sell.
  let targets: { bookingClass: string; line: number }[];
  if (entry.connectionStar) {
    const first = avail.lines.find((l) => l.line === legs[0].line);
    if (!first) return Response.FORMAT;
    if (first.connectionGroup == null) return 'NOT A CONNECTION'; // TODO confirm wording
    targets = avail.lines
      .filter((l) => l.connectionGroup === first.connectionGroup)
      .sort((a, b) => (a.legIndex ?? 0) - (b.legIndex ?? 0))
      .map((l) => ({ bookingClass: legs[0].bookingClass, line: l.line }));
  } else {
    targets = legs;
  }

  // Validate all legs up front (cached seat counts) so a connection sells atomically.
  for (const t of targets) {
    const line = avail.lines.find((l) => l.line === t.line);
    if (!line) return Response.FORMAT;
    if (!entry.waitlist && (line.classes[t.bookingClass] ?? 0) < entry.seats) {
      return 'CLASS NOT AVAILABLE'; // TODO confirm wording
    }
  }

  const segs: AirSegment[] = [];
  for (const t of targets) {
    const line = avail.lines.find((l) => l.line === t.line)!;
    if (!entry.waitlist) {
      ctx.inventory.sell(avail.date, line.carrier, line.flightNumber, t.bookingClass, entry.seats);
    }
    segs.push(
      withArrival({
        segmentNumber: wa.pnr.segments.length + segs.length + 1,
        carrier: line.carrier,
        flightNumber: line.flightNumber,
        bookingClass: t.bookingClass,
        date: avail.date,
        dayOfWeek: line.dayOfWeek,
        dayOfWeekNum: line.dayOfWeekNum,
        origin: line.origin,
        destination: line.destination,
        status: entry.waitlist ? StatusCode.LL : StatusCode.SS,
        seats: entry.seats,
        departTime: line.departTime,
        arriveTime: line.arriveTime,
      })
    );
  }
  return segs;
}

/** Long sell / passive / open: trust the typed data; don't draw inventory. */
function buildDirectSegment(entry: SellEntry, wa: WorkArea, ctx: HandlerContext): AirSegment {
  const sched = !entry.open && entry.flightNumber
    ? ctx.inventory.scheduleFor(entry.carrier!, entry.flightNumber)
    : undefined;
  return withArrival({
    segmentNumber: wa.pnr.segments.length + 1,
    carrier: entry.carrier!,
    flightNumber: entry.open ? 'OPEN' : entry.flightNumber!,
    bookingClass: entry.bookingClass,
    date: entry.date!.raw,
    dayOfWeek: dayOfWeekLetter(entry.date!.month, entry.date!.day),
    dayOfWeekNum: dayOfWeekNumber(entry.date!.month, entry.date!.day),
    origin: entry.origin!,
    destination: entry.destination!,
    status: entry.status ?? StatusCode.NN,
    seats: entry.seats,
    departTime: sched?.departTime ?? '',
    arriveTime: sched?.arriveTime ?? '',
    airlineLocator: entry.airlineLocator,
  });
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
