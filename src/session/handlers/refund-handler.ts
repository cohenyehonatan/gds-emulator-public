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

import type { RefundEntry, CancelRefundEntry } from '../../protocol/entry.js';
import type { TicketRecord } from '../../models/ticket.js';
import type { WorkArea } from '../work-area.js';
import type { HandlerContext } from './context.js';

export function handleRefund(
  entry: RefundEntry,
  wa: WorkArea,
  ctx: HandlerContext
): string {
  // WFR* — redisplay the work area's last refund response.
  if (entry.mode === 'redisplay') {
    return wa.lastRefundResponse ?? 'NO PREVIOUS REFUND'; // reconstructed empty state
  }

  for (const pnr of ctx.pnrStore.values()) {
    const ticket = pnr.tickets.find((t) => t.number === entry.ticketNumber);
    if (!ticket) continue;
    if (ticket.status === 'REFUNDED') return 'TKT ALREADY REFUNDED'; // reconstructed
    if (entry.mode === 'full') ticket.status = 'REFUNDED';
    // Tax-only leaves status active for now; surfaces via *TA per the QR
    // partition. Future per-coupon extension will adjust totals.
    const label = entry.mode === 'tax_only' ? 'TAX REFUND' : 'REFUND';
    const resp = `OK-${label} TKT ${entry.ticketNumber}`;
    wa.lastRefundResponse = resp;
    return resp;
  }
  return 'TKT NOT FOUND'; // reconstructed
}

/**
 * WTRX — cancel a refund. Two-step flow per QREX p.21:
 *   First entry:    "RE-ENTER TO CANCEL REFUND FOR TKT\n<ticket>"   verbatim
 *   Re-entry same:  "OK-REFUND\nCANCELLED"                          verbatim
 *
 * The pending ticket sits on the work area; a different ticket number on
 * step 2 resets to step 1 (treats it as a fresh request).
 */
export function handleCancelRefund(
  entry: CancelRefundEntry,
  wa: WorkArea,
  ctx: HandlerContext
): string {
  const ticket = findTicket(ctx, entry.ticketNumber);
  if (!ticket) return 'TKT NOT FOUND'; // reconstructed
  if (ticket.status !== 'REFUNDED') return 'TKT NOT REFUNDED'; // reconstructed

  // Step 2: same ticket number → confirm and flip status back to OPEN.
  if (wa.pendingCancelRefundTicket === entry.ticketNumber) {
    ticket.status = 'OPEN';
    wa.pendingCancelRefundTicket = undefined;
    return 'OK-REFUND\nCANCELLED'; // verbatim from QREX p.21
  }

  // Step 1 (or a fresh start with a different ticket): record + ask to re-enter.
  wa.pendingCancelRefundTicket = entry.ticketNumber;
  return `RE-ENTER TO CANCEL REFUND FOR TKT\n${entry.ticketNumber}`; // verbatim from QREX p.21
}

/** Find a ticket by number across all stored PNRs. */
function findTicket(ctx: HandlerContext, number: string): TicketRecord | undefined {
  for (const pnr of ctx.pnrStore.values()) {
    const t = pnr.tickets.find((tk) => tk.number === number);
    if (t) return t;
  }
  return undefined;
}
