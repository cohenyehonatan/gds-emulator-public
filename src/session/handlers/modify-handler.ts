/**
 * Modify handlers: cancel segments ('X') and change segment status ('.').
 *
 * Both require a PNR with an itinerary and use the MODIFY event, which is legal
 * only from BUILDING/DISPLAYED — so attempting them with an empty work area is
 * rejected (NO ITINERARY) rather than starting a new PNR.
 */

import type { CancelEntry, SegmentStatusEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { SessionEvent } from '../session-state.js';
import { Response, MANUAL_STATUS_CODES } from '../../protocol/constants.js';
import { renderItinerary } from '../../protocol/serializer.js';

export function handleCancel(entry: CancelEntry, wa: WorkArea): string {
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
