/**
 * SSR / OSI handlers. Both add a service element to the work-area PNR
 * (ADD_FIELD, so they may also start a build). An SSR with a name reference is
 * validated against the current names before it is accepted.
 */

import type { SsrEntry, OsiEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { SessionEvent } from '../session-state.js';
import { Response } from '../../dialects/sabre/responses.js';
import { renderSsrs, renderOsis } from '../../protocol/serializer.js';

export function handleSsr(entry: SsrEntry, wa: WorkArea): string {
  if (entry.nameRef) {
    const item = wa.pnr.names[entry.nameRef.item - 1];
    if (!item) return Response.FORMAT;
    const p = entry.nameRef.passenger;
    if (p != null && (p < 1 || p > item.passengers.length)) return Response.FORMAT;
  }

  wa.machine.transition(SessionEvent.ADD_FIELD);
  wa.pnr.ssrs.push({
    code: entry.code,
    carrier: entry.carrier,
    text: entry.text,
    nameRef: entry.nameRef,
    status: 'NN', // requested; the carrier confirms HK/HN/KK asynchronously
  });
  return renderSsrs(wa.pnr);
}

export function handleOsi(entry: OsiEntry, wa: WorkArea): string {
  wa.machine.transition(SessionEvent.ADD_FIELD);
  wa.pnr.osis.push({ carrier: entry.carrier, text: entry.text });
  return renderOsis(wa.pnr);
}
