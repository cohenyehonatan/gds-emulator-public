/**
 * Handle '*' display / retrieve.
 *
 *   *ABCDEF   → retrieve PNR by record locator (EMPTY → DISPLAYED)
 *   *-SMITH   → retrieve by surname; a numbered list when >1 matches
 *   *A        → redisplay the whole work-area PNR
 *   *N *I/*IA *P *T → redisplay one section (no state change)
 *
 * TODO (ROADMAP): pick a line from the similar-name list; *H history.
 */

import type { DisplayEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { SessionEvent } from '../session-state.js';
import { Response } from '../../protocol/constants.js';
import { isRecordLocator } from '../../models/record-locator.js';
import {
  renderPnr,
  renderNames,
  renderItinerary,
  renderPhones,
  renderTicketing,
  renderSimilarNameList,
} from '../../protocol/serializer.js';
import type { Pnr } from '../../models/pnr.js';
import type { HandlerContext } from './context.js';

/** Section codes that redisplay part of the current work-area PNR. */
const SECTIONS: Record<string, (pnr: Pnr) => string> = {
  A: renderPnr,
  N: renderNames,
  I: renderItinerary,
  IA: renderItinerary,
  P: renderPhones,
  T: renderTicketing,
};

export function handleRetrieve(entry: DisplayEntry, wa: WorkArea, ctx: HandlerContext): string {
  const arg = entry.argument;

  // Redisplay current work area: '*A' (all), '*N/*I/*P/*T' (sections), or bare '*'.
  const sectionKey = arg === '' ? 'A' : arg;
  if (sectionKey in SECTIONS) {
    if (!wa.pnr.hasContent()) return Response.NO_PNR;
    return SECTIONS[sectionKey](wa.pnr);
  }

  // Retrieve by surname: '*-SMITH'
  if (arg.startsWith('-')) {
    const matches = ctx.pnrStore.findBySurname(arg.slice(1));
    if (matches.length === 0) return Response.RECORD_LOCATOR_NOT_FOUND;
    if (matches.length > 1) return renderSimilarNameList(matches); // list; selection deferred
    wa.pnr = matches[0];
    wa.machine.transition(SessionEvent.RETRIEVE);
    return renderPnr(wa.pnr);
  }

  // Retrieve by record locator: '*ABCDEF'
  if (isRecordLocator(arg)) {
    const pnr = ctx.pnrStore.get(arg);
    if (!pnr) return Response.RECORD_LOCATOR_NOT_FOUND;
    wa.pnr = pnr;
    wa.machine.transition(SessionEvent.RETRIEVE);
    return renderPnr(pnr);
  }

  return Response.FORMAT;
}
