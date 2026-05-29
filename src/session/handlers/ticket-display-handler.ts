/**
 * Ticket-document display handler (WETR*… / WTDB*…). Source: Sabre
 * Ticket Display Tools QR p.1-2. The QR documents the entry but punts
 * the response layout to Format Finder; the rendering below is
 * reconstructed at the queue-prompt fidelity bar.
 *
 * Coupon (per-segment) lines are derived from the on-screen PNR's
 * segments — the TicketRecord doesn't carry a per-coupon model yet.
 * Flag the approximation if this ever becomes load-bearing.
 *
 * Implemented modes:
 *   - by_ticket: find ticket across pnrStore; render
 *   - by_item:   resolve *T item number against the on-screen PNR
 *   - redisplay: last ETR cached on the work area
 *   - history:   WETR*H — list all on-PNR tickets with type/date/agent
 *
 * `/E` (WETR enhanced) and `/OB` (WTDB OB fees) widen the rendered
 * detail; both are flag-only here — the underlying data is the same.
 */

import type { TicketDocumentDisplayEntry } from '../../protocol/entry.js';
import type { TicketRecord } from '../../models/ticket.js';
import type { Pnr } from '../../models/pnr.js';
import type { WorkArea } from '../work-area.js';
import { Response } from '../../dialects/sabre/responses.js';
import { renderTicketDocument, renderEtrHistory } from '../../protocol/serializer.js';
import type { HandlerContext } from './context.js';

export function handleTicketDocumentDisplay(
  entry: TicketDocumentDisplayEntry,
  wa: WorkArea,
  ctx: HandlerContext
): string {
  if (entry.mode === 'redisplay') {
    return wa.lastTicketDocument ?? 'NO PREVIOUS DOCUMENT'; // reconstructed
  }

  if (entry.mode === 'history') {
    if (!wa.pnr.hasContent()) return Response.NO_PNR;
    return renderEtrHistory(wa.pnr);
  }

  let pair: { pnr: Pnr; ticket: TicketRecord } | undefined;
  if (entry.mode === 'by_ticket') {
    pair = findByNumber(ctx, entry.ticketNumber!);
    if (!pair) return 'TKT NOT FOUND'; // reconstructed
  } else {
    // by_item: index into the on-screen PNR's tickets (1-indexed).
    if (!wa.pnr.hasContent()) return Response.NO_PNR;
    const t = wa.pnr.tickets[(entry.itemNumber ?? 0) - 1];
    if (!t) return 'TKT NOT FOUND';
    pair = { pnr: wa.pnr, ticket: t };
  }

  const rendered = renderTicketDocument(pair.pnr, pair.ticket, {
    family: entry.family,
    enhanced: !!entry.enhanced,
  });
  wa.lastTicketDocument = rendered;
  return rendered;
}

function findByNumber(
  ctx: HandlerContext,
  number: string
): { pnr: Pnr; ticket: TicketRecord } | undefined {
  for (const pnr of ctx.backend.pnrs.values()) {
    const ticket = pnr.tickets.find((t) => t.number === number);
    if (ticket) return { pnr, ticket };
  }
  return undefined;
}
