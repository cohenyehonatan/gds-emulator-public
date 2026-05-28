/**
 * Divide a PNR (D) and file the divided PNR (F).
 *
 * D splits the named passengers (and a copy of the itinerary) into a new
 * pending PNR, stashing the remainder of the original; the work area then shows
 * the new PNR. F commits ("files") it — assigning a record locator — adds a
 * cross-reference remark to the original, and restores the original to the work
 * area for the agent to end. Both use the MODIFY event.
 */

import type { DivideEntry, FileEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { Pnr } from '../../models/pnr.js';
import type { NameItem } from '../../models/name-element.js';
import { SessionEvent } from '../session-state.js';
import { Response } from '../../dialects/sabre/responses.js';
import { renderPnr } from '../../protocol/serializer.js';
import type { HandlerContext } from './context.js';

export function handleDivide(entry: DivideEntry, wa: WorkArea): string {
  if (wa.dividedOriginal) return 'DIVIDE IN PROGRESS - FILE OR IGNORE'; // TODO: confirm wording
  const names = wa.pnr.names;
  if (names.length === 0) return Response.NO_PNR;

  // Resolve refs into whole-item divides and passenger-within-item divides.
  const wholeItems = new Set<number>();
  const paxByItem = new Map<number, Set<number>>();
  for (const r of entry.refs) {
    const ii = r.item - 1;
    if (ii < 0 || ii >= names.length) return Response.FORMAT;
    if (r.passenger == null) {
      wholeItems.add(ii);
    } else {
      const pi = r.passenger - 1;
      if (pi < 0 || pi >= names[ii].passengers.length) return Response.FORMAT;
      if (!paxByItem.has(ii)) paxByItem.set(ii, new Set());
      paxByItem.get(ii)!.add(pi);
    }
  }

  const divided: NameItem[] = [];
  const remaining: NameItem[] = [];
  names.forEach((item, ii) => {
    if (wholeItems.has(ii)) {
      divided.push({ ...item, passengers: item.passengers.map((p) => ({ ...p })) });
      return;
    }
    const paxSet = paxByItem.get(ii);
    if (!paxSet) {
      remaining.push(item);
      return;
    }
    const divPax = item.passengers.filter((_, pi) => paxSet.has(pi)).map((p) => ({ ...p }));
    const keepPax = item.passengers.filter((_, pi) => !paxSet.has(pi)).map((p) => ({ ...p }));
    if (divPax.length) divided.push({ ...item, passengers: divPax, count: divPax.length });
    if (keepPax.length) remaining.push({ ...item, passengers: keepPax, count: keepPax.length });
  });

  if (divided.length === 0) return Response.FORMAT;
  if (remaining.length === 0) return 'UNABLE - CANNOT DIVIDE ALL NAMES'; // TODO: confirm wording

  wa.machine.transition(SessionEvent.MODIFY);

  // New (divided) PNR: divided names + a copy of the itinerary/phones + cross-ref.
  const newPnr = new Pnr();
  newPnr.names = divided;
  newPnr.segments = wa.pnr.segments.map((s) => ({ ...s }));
  newPnr.phones = wa.pnr.phones.map((p) => ({ ...p }));
  newPnr.remarks = [{ type: 'general', text: `DIVIDED FROM ${wa.pnr.locator ?? 'PNR'}` }];

  // Stash the remainder of the original; switch the work area to the new PNR.
  const original = wa.pnr.clone();
  original.names = remaining;
  wa.dividedOriginal = original;
  wa.pnr = newPnr;

  return renderPnr(newPnr);
}

export function handleFile(_entry: FileEntry, wa: WorkArea, ctx: HandlerContext): string {
  if (!wa.dividedOriginal) return 'NO DIVIDED PNR TO FILE'; // TODO: confirm wording

  const newLocator = ctx.pnrStore.commit(wa.pnr); // "file" = persist the new PNR
  wa.dividedOriginal.remarks.push({ type: 'general', text: `DIVIDED TO ${newLocator}` });

  wa.pnr = wa.dividedOriginal;
  wa.dividedOriginal = undefined;
  return `PNR FILED ${newLocator}\n${renderPnr(wa.pnr)}`;
}
