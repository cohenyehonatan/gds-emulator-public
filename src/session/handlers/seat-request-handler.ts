/**
 * Advance seat request handler — Galileo `S.` family (Pocket Guide
 * H/ASR), reached by Apollo unchanged and by Worldspan via the `4R`
 * sigil translation (W.2).
 *
 * Stores onto the cross-dialect `pnr.seatRequests` model that the
 * Amadeus ST family (chunk 10) already populates, so a future
 * cross-dialect *SD-style display reads one list regardless of which
 * dialect created the requests.
 *
 * Validation mirrors the Amadeus ST handler: when the code is a
 * specific seat label AND a segment is given, the seat must exist in
 * that segment's seat map and be currently Available per the
 * deterministic synthesizer. Preference codes (NW/NA/SA/SW/W/A/G)
 * skip both checks.
 */

import type { SeatRequestEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import type { HandlerContext } from './context.js';
import { synthesizeAvailability } from '../../models/seat-map.js';

export function handleSeatRequest(
  entry: SeatRequestEntry,
  wa: WorkArea,
  ctx: HandlerContext,
): string {
  if (entry.action === 'cancel') {
    if (entry.cancelAll) {
      if (wa.pnr.seatRequests.length === 0) return 'NO SEAT DATA';
      wa.pnr.seatRequests = [];
      return 'SEATS CANCELLED';
    }
    if (entry.segment != null) {
      const before = wa.pnr.seatRequests.length;
      wa.pnr.seatRequests = wa.pnr.seatRequests.filter((s) => s.segment !== entry.segment);
      return before === wa.pnr.seatRequests.length ? 'NO SEAT DATA' : 'SEATS CANCELLED';
    }
    return 'NO SEAT DATA';
  }

  // Add.
  const code = entry.code!;
  const seatLabel = /^(\d{1,3})([A-Z])$/.exec(code);
  if (seatLabel && entry.segment != null) {
    const seg = wa.pnr.segments.find((s) => s.segmentNumber === entry.segment);
    if (!seg) return 'SEGMENT NOT IN ITINERARY';
    const map = ctx.backend.inventory.seatMapFor(seg.carrier, seg.flightNumber);
    if (map) {
      const rowLabel = seatLabel[1];
      const col = seatLabel[2];
      const exists = map.Cabin.some((c) =>
        c.Row.some((r) => r.label === rowLabel && r.Space.some((s) => s.location === col)),
      );
      if (!exists) return 'INVALID SEAT';
      const locatorKey = wa.pnr.locator ?? 'PENDING';
      const availability = synthesizeAvailability(map, locatorKey, seg.date);
      for (const bucket of availability) {
        if (bucket.value.includes(code)) {
          if (bucket.seatAvailabilityStatus !== 'Available') return 'SEAT NOT AVAILABLE';
          break;
        }
      }
    }
  }
  wa.pnr.seatRequests.push({
    code,
    segment: entry.segment,
    nameRef: entry.nameRef,
  });
  return 'OK';
}
