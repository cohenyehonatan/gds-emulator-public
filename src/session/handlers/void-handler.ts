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
 * Two-step confirmation per the QR's verbatim "(Twice)" annotation:
 *   step 1 — stash a pending request on the work area, prompt to re-enter
 *   step 2 — identical entry commits the void
 * A different selector on step 2 resets to step 1, mirroring WTRX.
 *
 * Same-day cutoff (Sabre's real WV is "before midnight GMT of the issue
 * day") isn't enforced — the emulator doesn't model wall-clock cutoffs.
 *
 * List modes (`WV* `, `WV*DT…`) land in a follow-up commit.
 */

import type { VoidEntry } from '../../protocol/entry.js';
import type { TicketRecord } from '../../models/ticket.js';
import type { Pnr } from '../../models/pnr.js';
import type { WorkArea } from '../work-area.js';
import { Response } from '../../dialects/sabre/responses.js';
import { renderVoidList } from '../../protocol/serializer.js';
import { MONTHS } from '../../utils/validation.js';
import type { HandlerContext } from './context.js';

export function handleVoid(entry: VoidEntry, wa: WorkArea, ctx: HandlerContext): string {
  if (entry.mode === 'by_item') {
    if (!wa.pnr.hasContent()) return Response.NO_PNR;
    const item = entry.itemNumber!;
    const ticket = wa.pnr.tickets[item - 1];
    if (!ticket) return 'TKT NOT FOUND'; // reconstructed
    return voidByItem(item, ticket, wa);
  }

  if (entry.mode === 'manual') {
    const found = findByNumber(ctx, entry.ticketNumber!);
    if (!found) return 'TKT NOT FOUND'; // reconstructed
    return voidManual(entry.ticketNumber!, found.ticket, wa);
  }

  return handleList(entry, ctx);
}

/**
 * `WV* `, `WV*DT<date>`, `WV*DT<from>-<to>` — list voids across the
 * pnrStore. The QR documents the entries (p.13) but not the response
 * layout; rendering is reconstructed in `renderVoidList`.
 *
 * Year-of-tokens: the QR examples (`15SEP`, `15SEP-30SEP`) carry no
 * year, so the window is interpreted as "the current year". A range
 * with start > end is treated as no-match (the emulator doesn't model
 * Dec→Jan wraparound).
 */
function handleList(entry: VoidEntry, ctx: HandlerContext): string {
  const voids = collectVoids(ctx);

  if (entry.mode === 'list_month') {
    const now = new Date();
    const filtered = voids.filter(
      (v) =>
        v.ticket.voidedAt !== undefined &&
        v.ticket.voidedAt.getMonth() === now.getMonth() &&
        v.ticket.voidedAt.getFullYear() === now.getFullYear()
    );
    return renderVoidList(filtered, `${MONTHS[now.getMonth()]}${String(now.getFullYear()).slice(-2)}`);
  }

  if (entry.mode === 'list_day') {
    const target = parseDayMon(entry.fromDate!);
    if (!target) return 'INVALID DATE'; // reconstructed
    const now = new Date();
    const filtered = voids.filter((v) => {
      const d = v.ticket.voidedAt;
      if (!d) return false;
      return (
        d.getDate() === target.day &&
        d.getMonth() === target.month &&
        d.getFullYear() === now.getFullYear()
      );
    });
    return renderVoidList(filtered, entry.fromDate!);
  }

  // list_range
  const from = parseDayMon(entry.fromDate!);
  const to = parseDayMon(entry.toDate!);
  if (!from || !to) return 'INVALID DATE';
  const now = new Date();
  const year = now.getFullYear();
  const startMs = new Date(year, from.month, from.day, 0, 0, 0).getTime();
  const endMs = new Date(year, to.month, to.day, 23, 59, 59).getTime();
  if (endMs < startMs) return renderVoidList([], `${entry.fromDate}-${entry.toDate}`); // empty wraparound
  const filtered = voids.filter((v) => {
    const d = v.ticket.voidedAt?.getTime();
    return d !== undefined && d >= startMs && d <= endMs;
  });
  return renderVoidList(filtered, `${entry.fromDate}-${entry.toDate}`);
}

function collectVoids(ctx: HandlerContext): { pnr: Pnr; ticket: TicketRecord }[] {
  const out: { pnr: Pnr; ticket: TicketRecord }[] = [];
  for (const pnr of ctx.pnrStore.values()) {
    for (const t of pnr.tickets) {
      if (t.status === 'VOIDED') out.push({ pnr, ticket: t });
    }
  }
  return out;
}

function parseDayMon(tok: string): { day: number; month: number } | undefined {
  const m = /^(\d{1,2})([A-Z]{3})$/.exec(tok);
  if (!m) return undefined;
  const day = parseInt(m[1], 10);
  const month = MONTHS.indexOf(m[2]);
  if (month < 0 || day < 1 || day > 31) return undefined;
  return { day, month };
}

function voidByItem(item: number, ticket: TicketRecord, wa: WorkArea): string {
  if (ticket.status === 'VOIDED') return 'TKT ALREADY VOIDED'; // reconstructed
  if (ticket.status === 'REFUNDED') return 'TKT REFUNDED - NOT VOIDABLE'; // reconstructed

  // Step 2: same item number → commit.
  if (
    wa.pendingVoid?.kind === 'by_item' &&
    wa.pendingVoid.itemNumber === item
  ) {
    ticket.status = 'VOIDED';
    ticket.voidedAt = new Date();
    wa.pendingVoid = undefined;
    return `OK-VOID TKT ${ticket.number}`; // reconstructed
  }

  // Step 1 (or a different selector): record + ask to re-enter.
  wa.pendingVoid = { kind: 'by_item', itemNumber: item };
  return `RE-ENTER TO VOID TKT\n${ticket.number}`; // reconstructed
}

function voidManual(ticketNumber: string, ticket: TicketRecord, wa: WorkArea): string {
  if (ticket.status === 'VOIDED') return 'TKT ALREADY VOIDED'; // reconstructed
  if (ticket.status === 'REFUNDED') return 'TKT REFUNDED - NOT VOIDABLE'; // reconstructed

  if (
    wa.pendingVoid?.kind === 'manual' &&
    wa.pendingVoid.ticketNumber === ticketNumber
  ) {
    ticket.status = 'VOIDED';
    ticket.voidedAt = new Date();
    wa.pendingVoid = undefined;
    return `OK-VOID TKT ${ticketNumber}`; // reconstructed
  }

  wa.pendingVoid = { kind: 'manual', ticketNumber };
  return `RE-ENTER TO VOID TKT\n${ticketNumber}`; // reconstructed
}

function findByNumber(
  ctx: HandlerContext,
  number: string
): { pnr: Pnr; ticket: TicketRecord } | undefined {
  for (const pnr of ctx.pnrStore.values()) {
    const t = pnr.tickets.find((tk) => tk.number === number);
    if (t) return { pnr, ticket: t };
  }
  return undefined;
}
