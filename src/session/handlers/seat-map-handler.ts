/**
 * Sabre seat-map display + scroll handler (4G family — Basic Course
 * "Display Seat Maps" + ¤MD/¤MU scroll verbs).
 *
 * Uses the cross-dialect helpers from chunk 1:
 *   Inventory.seatMapFor(carrier, flightNumber, equipment?)
 *   synthesizeAvailability(seatMap, locatorKey, date)
 *   renderSeatMap(seatMap, availability, header, orientation, opts)
 *
 * Sabre's response format (per the Basic Course PDF):
 *   864Y 25OCT DFWSLC
 *   SEATS INVENTORY DETAIL
 *   <seat grid>
 *   ROWS X-Y OF Z   (when paginated)
 *
 * Built by `sabreSeatMapHeader` from `src/render/seat-map-render.ts`.
 * Paginates with PAGE_SIZE rows per screen so ¤MD/¤MU scroll-down /
 * scroll-up are useful — same shape as Amadeus chunk 7.
 */

import type { SeatMapEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import type { HandlerContext } from './context.js';
import { StatusCode } from '../../protocol/constants.js';
import type { AirSegment } from '../../models/segment.js';
import { synthesizeAvailability } from '../../models/seat-map.js';
import { renderSeatMap, sabreSeatMapHeader } from '../../render/seat-map-render.js';

const PAGE_SIZE = 20;

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
  // ¤MD / ¤MU scroll the cached seat map. Operates on wa.lastSeatMap
  // populated by a prior 4G<n>* / 4G*<...> display.
  if (entry.source === 'scroll') {
    const cached = wa.lastSeatMap;
    if (!cached?.cachedSegment) return 'NO SEAT MAP DISPLAYED';
    const cachedSegment = cached.cachedSegment;
    const totalRows = cached.map.Cabin.reduce((sum, c) => sum + c.Row.length, 0);
    const maxOffset = Math.max(0, totalRows - PAGE_SIZE);
    let newOffset = cached.scrollRow ?? 0;
    if (entry.direction === 'down') newOffset = Math.min(newOffset + PAGE_SIZE, maxOffset);
    else newOffset = Math.max(newOffset - PAGE_SIZE, 0); // up
    cached.scrollRow = newOffset;
    const locatorKey = wa.pnr.locator ?? 'PENDING';
    const availability = synthesizeAvailability(cached.map, locatorKey, cachedSegment.date);
    const header = sabreSeatMapHeader(cached.map, cachedSegment);
    return renderSeatMap(cached.map, availability, header, 'V', {
      rowOffset: newOffset,
      rowsPerPage: PAGE_SIZE,
    });
  }

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
  // Cache cachedSegment + scrollRow=0 so a follow-on ¤MD/¤MU can
  // re-render without re-resolving.
  wa.lastSeatMap = { segment: segmentNumber, map, cachedSegment: segment, scrollRow: 0 };

  const header = sabreSeatMapHeader(map, segment);
  return renderSeatMap(map, availability, header, 'V', { rowsPerPage: PAGE_SIZE });
}
