/**
 * Frequent-flyer handler: add / change / delete (FF, FF1¤…, FF1¤).
 * Add uses ADD_FIELD; change/delete use MODIFY (need an existing record).
 * A name reference is validated against the current names.
 */

import type { FrequentFlyerEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import type { Pnr } from '../../models/pnr.js';
import { SessionEvent } from '../session-state.js';
import { Response } from '../../dialects/sabre/responses.js';
import { renderFrequentFlyers } from '../../protocol/serializer.js';

function nameRefValid(pnr: Pnr, ref?: { item: number; passenger?: number }): boolean {
  if (!ref) return true;
  const item = pnr.names[ref.item - 1];
  if (!item) return false;
  return ref.passenger == null || (ref.passenger >= 1 && ref.passenger <= item.passengers.length);
}

export function handleFrequentFlyer(entry: FrequentFlyerEntry, wa: WorkArea): string {
  const pnr = wa.pnr;

  if (entry.operation === 'add') {
    if (!nameRefValid(pnr, entry.nameRef)) return Response.FORMAT;
    wa.machine.transition(SessionEvent.ADD_FIELD);
    pnr.frequentFlyers.push({ carrier: entry.carrier!, number: entry.number!, nameRef: entry.nameRef });
    return renderFrequentFlyers(pnr);
  }

  // change / delete by line
  const idx = (entry.line ?? 0) - 1;
  if (idx < 0 || idx >= pnr.frequentFlyers.length) return Response.FORMAT;
  wa.machine.transition(SessionEvent.MODIFY);

  if (entry.operation === 'delete') {
    pnr.frequentFlyers.splice(idx, 1);
    return pnr.frequentFlyers.length > 0 ? renderFrequentFlyers(pnr) : 'NO FREQUENT FLYER';
  }

  if (!nameRefValid(pnr, entry.nameRef)) return Response.FORMAT;
  pnr.frequentFlyers[idx] = { carrier: entry.carrier!, number: entry.number!, nameRef: entry.nameRef };
  return renderFrequentFlyers(pnr);
}
