/**
 * Refund handler (WFR / WFRT). Source: Zenon QREX manual pp.7-9
 * (third-party verbatim transcription of Sabre's refund flow).
 *
 * Looks up the target ticket across all stored PNRs (the system-wide
 * ticket index is implicit in ctx.pnrStore — Sabre's "TKT NOT FOUND"
 * response is keyed by ticket number, not by which PNR carries it).
 * Marks the ticket status REFUNDED so it moves from `*TA` (active) to
 * `*TI` (inactive) per the Ticket Display Tools QR partition.
 *
 * The mode distinguishes full refund (status → REFUNDED) from tax-only
 * (the QREX manual leaves the ticket "active" with a reduced total —
 * for the emulator we record the mode but, until per-coupon modeling
 * lands, the tax-only refund is effectively a no-op flag on the same
 * record. Flagged inline so a future commit can extend.
 *
 * Response strings ("OK-REFUND", "TKT NOT FOUND") are paraphrased from
 * the QREX manual's response shape; the manual quotes "OK-REFUND" for
 * the cancel-refund WTRX flow (p.21), so this is a reconstruction.
 */

import type { RefundEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import type { HandlerContext } from './context.js';

export function handleRefund(
  entry: RefundEntry,
  _wa: WorkArea,
  ctx: HandlerContext
): string {
  for (const pnr of ctx.pnrStore.values()) {
    const ticket = pnr.tickets.find((t) => t.number === entry.ticketNumber);
    if (!ticket) continue;
    if (ticket.status === 'REFUNDED') return 'TKT ALREADY REFUNDED'; // reconstructed
    if (entry.mode === 'full') ticket.status = 'REFUNDED';
    // Tax-only leaves status active for now; surfaces via *TA per the QR
    // partition. Future per-coupon extension will adjust totals.
    const label = entry.mode === 'tax_only' ? 'TAX REFUND' : 'REFUND';
    return `OK-${label} TKT ${entry.ticketNumber}`;
  }
  return 'TKT NOT FOUND'; // reconstructed
}
