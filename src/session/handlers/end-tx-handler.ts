/**
 * Handle End Transaction (E / ER / ET).
 *
 * Enforces the PRINT mandatory-field rule: if any of Phone, Received-from,
 * Itinerary, Name, Ticketing is missing, the host rejects with the matching
 * canned response and the work area is left intact (no FSM transition) — the
 * direct analog of the printer's "PECTAB not available" refusal.
 *
 * On success: commit to the PNR store (assigning a record locator), advance
 * the FSM (END_TX → EMPTY), clear the work area, and return the locator
 * (ER additionally redisplays the committed PNR).
 */

import type { EndTransactionEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { SessionEvent } from '../session-state.js';
import { MandatoryField, Response, type MandatoryFieldKey } from '../../protocol/constants.js';
import { renderPnr } from '../../protocol/serializer.js';
import type { HandlerContext } from './context.js';

const MISSING_RESPONSE: Record<MandatoryFieldKey, string> = {
  [MandatoryField.PHONE]: Response.NEED_PHONE,
  [MandatoryField.RECEIVED_FROM]: Response.NEED_RECEIVED_FROM,
  [MandatoryField.ITINERARY]: Response.NEED_ITINERARY,
  [MandatoryField.NAME]: Response.NEED_NAME,
  [MandatoryField.TICKETING]: Response.NEED_TICKETING,
};

export function handleEndTransaction(
  entry: EndTransactionEntry,
  wa: WorkArea,
  ctx: HandlerContext
): string {
  const missing = wa.pnr.missingMandatory();
  if (missing.length > 0) {
    // Reject on the first missing field; work area stays intact for correction.
    return MISSING_RESPONSE[missing[0]];
  }

  // Verified Sabre check (Basic Course p.53): names must match seats sold.
  const pax = wa.pnr.passengerCount();
  if (wa.pnr.segments.some((s) => s.seats !== pax)) {
    return Response.NAMES_NOT_EQUAL;
  }

  const locator = ctx.pnrStore.commit(wa.pnr);
  const committed = wa.pnr;
  const agent = wa.agent;
  wa.machine.transition(SessionEvent.END_TX);
  wa.reset();

  return entry.redisplay ? renderPnr(committed, { pcc: ctx.pcc, agent }) : locator;
}
