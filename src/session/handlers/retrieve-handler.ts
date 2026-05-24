/**
 * Handle '*' display / retrieve.
 *
 *   *ABCDEF   → retrieve by locator into the work area (EMPTY → DISPLAYED)
 *   *-SMITH   → retrieve by surname
 *   *A        → redisplay the current work-area PNR (no state change)
 *
 * TODO (later): section redisplays (*I/*N/*P/*T), similar-name lists,
 * and retrieving while a PNR is already displayed.
 */

import type { DisplayEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { SessionEvent } from '../session-state.js';
import { Response } from '../../protocol/constants.js';
import { isRecordLocator } from '../../models/record-locator.js';
import { renderPnr } from '../../protocol/serializer.js';
import type { HandlerContext } from './context.js';

export function handleRetrieve(entry: DisplayEntry, wa: WorkArea, ctx: HandlerContext): string {
  const arg = entry.argument;

  // Redisplay current work area: '*A' (all) — only the section letter, no locator.
  if (arg === 'A' || arg === '') {
    if (!wa.pnr.hasContent()) return Response.NO_PNR;
    return renderPnr(wa.pnr);
  }

  // Retrieve by surname: '*-SMITH'
  if (arg.startsWith('-')) {
    const matches = ctx.pnrStore.findBySurname(arg.slice(1));
    if (matches.length === 0) return Response.RECORD_LOCATOR_NOT_FOUND;
    wa.pnr = matches[0]; // TODO: present a similar-name list when >1
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
