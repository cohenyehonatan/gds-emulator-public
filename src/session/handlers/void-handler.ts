/**
 * Void-ticket handler (`WV` family). Source: Sabre Travel Network Middle
 * East QR (Sept 2007) p.13 — entries verbatim, host responses NOT
 * documented anywhere.
 *
 * Every response string in this file is **reconstructed** (no source),
 * flagged inline. The shapes (`RE-ENTER TO VOID TKT\n<n>`, `OK-VOID`,
 * `TKT NOT FOUND`) follow the QREX p.21 pattern that was source-verified
 * for WTRX — Sabre's voice is consistent across kindred two-step flows.
 *
 * Two-step confirmation for `WV<n>` (and `WV‡…`) per the QR's verbatim
 * "(Twice)" annotation: first entry stashes a pending request on the
 * work area, second identical entry commits.
 *
 * Implementation lands in a follow-up commit; this stub keeps the
 * dispatcher type-checked.
 */

import type { VoidEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import type { HandlerContext } from './context.js';

export function handleVoid(_entry: VoidEntry, _wa: WorkArea, _ctx: HandlerContext): string {
  // Reconstructed: no source documents void responses.
  return 'WV NOT IMPLEMENTED';
}
