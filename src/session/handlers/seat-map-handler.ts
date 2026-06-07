/**
 * Sabre seat-map display handler (4G family — Basic Course "Display
 * Seat Maps").
 *
 * Uses the cross-dialect helpers from chunk 1:
 *   Inventory.seatMapFor(carrier, flightNumber, equipment?)
 *   synthesizeAvailability(seatMap, locatorKey, date)
 *   renderSeatMap(seatMap, availability, header, orientation)
 *
 * Sabre's response format (per the Basic Course PDF):
 *   864Y 25OCT DFWSLC
 *   SEATS INVENTORY DETAIL
 *   <seat grid>
 *
 * Built by `sabreSeatMapHeader` from `src/render/seat-map-render.ts`.
 */

import type { SeatMapEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import type { HandlerContext } from './context.js';
import { StatusCode } from '../../protocol/constants.js';
import type { AirSegment } from '../../models/segment.js';
import { synthesizeAvailability } from '../../models/seat-map.js';
import { renderSeatMap, sabreSeatMapHeader } from '../../render/seat-map-render.js';

/** Synthetic AirSegment for the direct form (no real PNR segment). */
function synthSegment(
  entry: SeatMapEntry,
): AirSegment {
  return {
    segmentNumber: 1,
    carrier: entry.carrier!,
    flightNumber: entry.flightNumber!,
    bookingClass: entry.bookingClass ?? 'Y',
    date: entry.date!,
    dayOfWeek: '?',
    dayOfWeekNum: 0,
    origin: entry.origin!,
    destination: entry.destination!,
    status: StatusCode.SS,
    seats: 1,
    departTime: '',
    arriveTime: '',
  };
}

export function handleSeatMap(entry: SeatMapEntry, wa: WorkArea, ctx: HandlerContext): string {
  let segment: AirSegment;
  let segmentNumber: number;

  if (entry.source === 'segment') {
    if (wa.pnr.segments.length === 0) return 'NO ITINERARY';
    const seg = wa.pnr.segments.find((s) => s.segmentNumber === entry.segment);
    if (!seg) return 'SEGMENT NOT IN ITINERARY';
    segment = seg;
    segmentNumber = entry.segment!;
  } else {
    // Direct form: schedule lookup to verify the flight exists.
    const sched = ctx.backend.inventory.scheduleFor(entry.carrier!, entry.flightNumber!);
    if (!sched) return 'NO SCHEDULE FOUND';
    segment = synthSegment(entry);
    segmentNumber = 1;
  }

  const map = ctx.backend.inventory.seatMapFor(segment.carrier, segment.flightNumber);
  if (!map) return 'NO SEAT MAP AVAILABLE';

  const locatorKey = wa.pnr.locator ?? 'PENDING';
  const availability = synthesizeAvailability(map, locatorKey, segment.date);
  wa.lastSeatMap = { segment: segmentNumber, map };

  const header = sabreSeatMapHeader(map, segment);
  return renderSeatMap(map, availability, header, 'V');
}
