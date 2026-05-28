/**
 * Modify handlers: cancel segments ('X') and change segment status ('.').
 *
 * Both require a PNR with an itinerary and use the MODIFY event, which is legal
 * only from BUILDING/DISPLAYED — so attempting them with an empty work area is
 * rejected (NO ITINERARY) rather than starting a new PNR.
 */

import type {
  CancelEntry,
  SellEntry,
  SegmentStatusEntry,
  PassiveCancelEntry,
  ModifyEntry,
  MoveEntry,
} from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import type { Pnr } from '../../models/pnr.js';
import type { AirSegment } from '../../models/segment.js';
import { SessionEvent } from '../session-state.js';
import { MANUAL_STATUS_CODES, StatusCode } from '../../protocol/constants.js';
import { Response } from '../../dialects/sabre/responses.js';
import { renderItinerary, renderNames, renderPhones, renderTicketing, renderRemarks, renderSoldSegment } from '../../protocol/serializer.js';
import { parseNameText, parsePassenger } from '../../models/name-element.js';
import { parsePhoneText } from '../../models/phone-element.js';
import { parseRemarkText } from '../../models/remark.js';
import { parseSabreDate } from '../../utils/validation.js';
import { dayOfWeekLetter, dayOfWeekNumber, type HandlerContext } from './context.js';
import { handleSell, withArrival } from './pnr-build-handler.js';

export function handleCancel(entry: CancelEntry, wa: WorkArea, ctx: HandlerContext): string {
  if (wa.pnr.segments.length === 0) return Response.NO_ITINERARY;

  if (entry.mode === 'itinerary' || entry.mode === 'all_air') {
    wa.machine.transition(SessionEvent.MODIFY);
    wa.pnr.segments = [];
    return 'ITINERARY CANCELLED'; // TODO: confirm wording vs PDF
  }

  // Validate every referenced segment exists before touching anything.
  const max = wa.pnr.segments.length;
  for (const n of entry.segments) {
    if (n < 1 || n > max) return Response.SEGMENT_NOT_FOUND;
  }

  // Capture cancelled segments before removal — a same-flight/new-date rebook
  // needs the carrier/flight/class/origin/dest the cancellation just dropped.
  const targets = new Set(entry.segments);
  const cancelled = entry.rebook
    ? wa.pnr.segments.filter((s) => targets.has(s.segmentNumber))
    : [];

  wa.machine.transition(SessionEvent.MODIFY);
  wa.pnr.segments = wa.pnr.segments.filter((s) => !targets.has(s.segmentNumber));
  wa.pnr.renumberSegments();

  if (entry.rebook) {
    return rebookAfterCancel(entry.rebook, cancelled, wa, ctx);
  }
  return wa.pnr.segments.length > 0 ? renderItinerary(wa.pnr) : 'ITINERARY CANCELLED';
}

/**
 * Execute the rebook half of a cancel-and-rebook entry. On failure, the
 * cancellation already stands — agent recovers via `IR` per the Zenon course.
 */
function rebookAfterCancel(
  spec: NonNullable<CancelEntry['rebook']>,
  cancelled: AirSegment[],
  wa: WorkArea,
  ctx: HandlerContext
): string {
  if (spec.kind === 'cpa_line') {
    // Delegate to handleSell — same availability cache, class/seat validation,
    // inventory decrement, segment numbering, FSM transition.
    const sell: SellEntry = {
      kind: 'sell',
      raw: '',
      timestamp: new Date(),
      mode: 'availability',
      seats: spec.seats,
      bookingClass: spec.bookingClass,
      line: spec.line,
    };
    return handleSell(sell, wa, ctx);
  }

  // same_flight_new_date: re-sell each cancelled leg on the new date.
  const parsed = parseSabreDate(spec.newDate);
  if (!parsed) return Response.FORMAT;
  const { date } = parsed;

  wa.machine.transition(SessionEvent.SELL);
  const newSegs: AirSegment[] = [];
  for (const c of cancelled) {
    // Seed the new-date inventory if the agent hasn't browsed availability for
    // that date — otherwise sell() returns false against an unseeded slot.
    if (!ctx.inventory.seedSeats(date.raw, c.carrier, c.flightNumber)) return 'NO FLIGHTS';
    if (!ctx.inventory.sell(date.raw, c.carrier, c.flightNumber, c.bookingClass, c.seats)) {
      return 'CLASS NOT AVAILABLE';
    }
    newSegs.push(
      withArrival({
        segmentNumber: wa.pnr.segments.length + newSegs.length + 1,
        carrier: c.carrier,
        flightNumber: c.flightNumber,
        bookingClass: c.bookingClass,
        date: date.raw,
        dayOfWeek: dayOfWeekLetter(date.month, date.day),
        dayOfWeekNum: dayOfWeekNumber(date.month, date.day),
        origin: c.origin,
        destination: c.destination,
        status: StatusCode.SS,
        seats: c.seats,
        departTime: c.departTime,
        arriveTime: c.arriveTime,
      })
    );
  }
  for (const s of newSegs) wa.pnr.segments.push(s);
  return newSegs.map(renderSoldSegment).join('\n');
}

/** Change or delete a PNR field via the '¤' key. Requires a PNR present. */
export function handleModify(entry: ModifyEntry, wa: WorkArea): string {
  const pnr = wa.pnr;
  if (!pnr.hasContent()) return Response.NO_PNR;
  wa.machine.transition(SessionEvent.MODIFY); // legal only in BUILDING/DISPLAYED

  switch (entry.field) {
    case 'name':
      return modifyName(entry, pnr);
    case 'phone':
      return modifyPhone(entry, pnr);
    case 'remarks':
      return modifyRemarks(entry, pnr);
    case 'ticketing':
      pnr.ticketing = entry.operation === 'delete' ? undefined : entry.newData;
      return pnr.ticketing ? renderTicketing(pnr) : Response.OK;
    case 'received_from':
      pnr.receivedFrom = entry.operation === 'delete' ? undefined : entry.newData;
      return pnr.receivedFrom ? `RECEIVED FROM - ${pnr.receivedFrom}` : Response.OK;
  }
}

function modifyName(entry: ModifyEntry, pnr: Pnr): string {
  if (entry.reference) return modifyNameReference(entry, pnr);
  if (entry.passenger != null) return modifyPassenger(entry, pnr);

  if (entry.operation === 'delete') {
    let targets = entry.lines;
    if (targets.length === 0) {
      if (pnr.names.length !== 1) return Response.FORMAT; // must say which when >1
      targets = [1];
    }
    if (targets.some((l) => l < 1 || l > pnr.names.length)) return Response.FORMAT;
    const remove = new Set(targets);
    pnr.names = pnr.names.filter((_, i) => !remove.has(i + 1));
    return pnr.names.length > 0 ? renderNames(pnr) : 'NO NAMES';
  }
  const target = entry.lines[0] ?? (pnr.names.length === 1 ? 1 : undefined);
  if (target == null || target < 1 || target > pnr.names.length) return Response.FORMAT;
  pnr.names[target - 1] = parseNameText(entry.newData!);
  return renderNames(pnr);
}

/** Change or delete a name-reference number (¤*), at item or passenger level. */
function modifyNameReference(entry: ModifyEntry, pnr: Pnr): string {
  const item = pnr.names[(entry.lines[0] ?? 0) - 1];
  if (!item) return Response.FORMAT;
  const value = entry.operation === 'delete' ? undefined : entry.newData;

  if (entry.passenger != null) {
    const pax = item.passengers[entry.passenger - 1];
    if (!pax) return Response.FORMAT;
    pax.reference = value;
  } else {
    item.reference = value;
  }
  return renderNames(pnr);
}

/** Change or delete one passenger within a name item (e.g. -1.1¤JANE MISS). */
function modifyPassenger(entry: ModifyEntry, pnr: Pnr): string {
  const item = pnr.names[(entry.lines[0] ?? 0) - 1];
  if (!item) return Response.FORMAT;
  const p = entry.passenger! - 1;
  if (p < 0 || p >= item.passengers.length) return Response.FORMAT;

  if (entry.operation === 'delete') {
    item.passengers.splice(p, 1);
    if (item.passengers.length === 0) {
      pnr.names.splice((entry.lines[0] ?? 0) - 1, 1);
    } else {
      item.count = item.passengers.length;
    }
    return pnr.names.length > 0 ? renderNames(pnr) : 'NO NAMES';
  }

  // Change just this passenger's first name/title; surname stays.
  item.passengers[p] = parsePassenger(entry.newData!);
  return renderNames(pnr);
}

function modifyRemarks(entry: ModifyEntry, pnr: Pnr): string {
  if (entry.operation === 'delete') {
    if (entry.lines.length === 0 || entry.lines.some((l) => l < 1 || l > pnr.remarks.length)) {
      return Response.FORMAT;
    }
    const remove = new Set(entry.lines);
    pnr.remarks = pnr.remarks.filter((_, i) => !remove.has(i + 1));
    return pnr.remarks.length > 0 ? renderRemarks(pnr) : 'NO REMARKS';
  }
  const target = entry.lines[0];
  if (target == null || target < 1 || target > pnr.remarks.length) return Response.FORMAT;
  pnr.remarks[target - 1] = parseRemarkText(entry.newData!);
  return renderRemarks(pnr);
}

function modifyPhone(entry: ModifyEntry, pnr: Pnr): string {
  if (entry.operation === 'delete') {
    let targets = entry.lines;
    if (targets.length === 0) {
      if (pnr.phones.length !== 1) return Response.FORMAT;
      targets = [1];
    }
    if (targets.some((l) => l < 1 || l > pnr.phones.length)) return Response.FORMAT;
    const remove = new Set(targets);
    pnr.phones = pnr.phones.filter((_, i) => !remove.has(i + 1));
    return pnr.phones.length > 0 ? renderPhones(pnr) : 'NO PHONE FIELD';
  }
  const target = entry.lines[0] ?? (pnr.phones.length === 1 ? 1 : undefined);
  if (target == null || target < 1 || target > pnr.phones.length) return Response.FORMAT;
  pnr.phones[target - 1] = parsePhoneText(entry.newData!);
  return renderPhones(pnr);
}

/** Move/insert segments: relocate segment(s) to a new itinerary position. */
export function handleMove(entry: MoveEntry, wa: WorkArea): string {
  const segs = wa.pnr.segments;
  if (segs.length === 0) return Response.NO_ITINERARY;

  const from = entry.from;
  const to = entry.to ?? entry.from;
  if (from < 1 || to > segs.length || entry.after < 0 || entry.after > segs.length) {
    return Response.SEGMENT_NOT_FOUND;
  }

  const moving = segs.slice(from - 1, to);
  const remaining = segs.filter((_, i) => i < from - 1 || i > to - 1);

  let insertAt: number;
  if (entry.after === 0) {
    insertAt = 0;
  } else {
    const anchor = segs[entry.after - 1];
    const ai = remaining.indexOf(anchor); // anchor must not be one of the moved segments
    if (ai === -1) return Response.SEGMENT_NOT_FOUND;
    insertAt = ai + 1;
  }

  wa.machine.transition(SessionEvent.MODIFY);
  remaining.splice(insertAt, 0, ...moving);
  wa.pnr.segments = remaining;
  wa.pnr.renumberSegments();
  return renderItinerary(wa.pnr);
}

/**
 * Passive cancel `.<sel>XK` — remove the selected segments from the agent's
 * itinerary. In a real Sabre, this leaves the airline-side booking in place
 * (no cancel message sent); this emulator doesn't model an airline party, so
 * the observable behavior is identical to an `X` cancel modulo the wire
 * format. The agent-side semantics that matter — segment removal + renumber
 * + state transition — are unified with handleCancel for that reason.
 */
export function handlePassiveCancel(entry: PassiveCancelEntry, wa: WorkArea): string {
  if (wa.pnr.segments.length === 0) return Response.NO_ITINERARY;

  const max = wa.pnr.segments.length;
  for (const n of entry.segments) {
    if (n < 1 || n > max) return Response.SEGMENT_NOT_FOUND;
  }

  wa.machine.transition(SessionEvent.MODIFY);
  const remove = new Set(entry.segments);
  wa.pnr.segments = wa.pnr.segments.filter((s) => !remove.has(s.segmentNumber));
  wa.pnr.renumberSegments();

  return wa.pnr.segments.length > 0 ? renderItinerary(wa.pnr) : 'ITINERARY CANCELLED';
}

export function handleSegmentStatus(entry: SegmentStatusEntry, wa: WorkArea): string {
  if (wa.pnr.segments.length === 0) return Response.NO_ITINERARY;
  if (!MANUAL_STATUS_CODES.has(entry.status)) return Response.INVALID_STATUS;

  const seg = wa.pnr.segments.find((s) => s.segmentNumber === entry.segment);
  if (!seg) return Response.SEGMENT_NOT_FOUND;

  wa.machine.transition(SessionEvent.MODIFY);
  seg.status = entry.status;
  return renderItinerary(wa.pnr);
}
