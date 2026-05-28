/**
 * Audit Trail Report handler (DQB*…). Source: Sabre Ticket Display Tools
 * QR p.2 — "Displays a record of all Sabre system-generated tickets issued
 * each day. It lists the type of coupon, the ticket amount, commission
 * amount, and the number of auditor's coupons issued."
 *
 * This is a system-wide report — it iterates the PCC's PnrStore, not just
 * the on-screen PNR's tickets. Branch-PCC filtering is parsed but the
 * emulator only models a single PCC, so a branch argument that doesn't
 * match the host PCC returns a "BRANCH NOT AUTHORIZED" reconstructed
 * string rather than silently returning empty data.
 *
 * Delete: `DQB*DELETE` followed by `DQB*YES` confirms in real Sabre, gated
 * by EPR keyword ATBRPT + duty code 9. The emulator doesn't model EPR, so
 * the delete is a no-op stub — flagged inline.
 */

import type { AuditTrailEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { renderAuditTrail } from '../../protocol/serializer.js';
import type { HandlerContext } from './context.js';

export function handleAuditTrail(
  entry: AuditTrailEntry,
  _wa: WorkArea,
  ctx: HandlerContext
): string {
  if (entry.mode === 'delete_request') return 'OK TO DELETE - REENTER DQB*YES'; // reconstructed
  if (entry.mode === 'delete_confirm') return 'AUDIT TRAIL DELETED'; // reconstructed (no-op stub)

  // Display mode: branch-PCC argument must match the host PCC; cross-branch
  // requires authorization the emulator doesn't model.
  if (entry.branch && entry.branch.toUpperCase() !== ctx.pcc.toUpperCase()) {
    return 'BRANCH NOT AUTHORIZED'; // reconstructed
  }
  return renderAuditTrail(ctx.pnrStore.values(), { date: entry.date, branch: entry.branch ?? ctx.pcc });
}
