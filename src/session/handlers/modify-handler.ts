/**
 * Modify handlers: cancel segments ('X') and change segment status ('.').
 *
 * Both require a PNR with an itinerary and use the MODIFY event, which is legal
 * only from BUILDING/DISPLAYED — so attempting them with an empty work area is
 * rejected (NO ITINERARY) rather than starting a new PNR.
 */

import type { CancelEntry, SegmentStatusEntry, ModifyEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import type { Pnr } from '../../models/pnr.js';
import { SessionEvent } from '../session-state.js';
import { Response, MANUAL_STATUS_CODES } from '../../protocol/constants.js';
import { renderItinerary, renderNames, renderPhones, renderTicketing } from '../../protocol/serializer.js';
import { parseNameText, parsePassenger } from '../../models/name-element.js';
import { parsePhoneText } from '../../models/phone-element.js';

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
    case 'ticketing':
      pnr.ticketing = entry.operation === 'delete' ? undefined : entry.newData;
      return pnr.ticketing ? renderTicketing(pnr) : Response.OK;
    case 'received_from':
      pnr.receivedFrom = entry.operation === 'delete' ? undefined : entry.newData;
      return pnr.receivedFrom ? `RECEIVED FROM - ${pnr.receivedFrom}` : Response.OK;
  }
}

function modifyName(entry: ModifyEntry, pnr: Pnr): string {
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

export function handleSegmentStatus(entry: SegmentStatusEntry, wa: WorkArea): string {
  if (wa.pnr.segments.length === 0) return Response.NO_ITINERARY;
  if (!MANUAL_STATUS_CODES.has(entry.status)) return Response.INVALID_STATUS;

  const seg = wa.pnr.segments.find((s) => s.segmentNumber === entry.segment);
  if (!seg) return Response.SEGMENT_NOT_FOUND;

  wa.machine.transition(SessionEvent.MODIFY);
  seg.status = entry.status;
  return renderItinerary(wa.pnr);
}
