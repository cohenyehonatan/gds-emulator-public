/**
 * E-ticket issuance (Sabre Issue-Tickets QR).
 *
 *   W¥ / TTP   issue one e-ticket per seat-occupying passenger, pricing the
 *              itinerary as booked (or using the last WP quote if present)
 *   W¥PQ<n>    issue from stored Enhanced PQ record <n>
 *   W¥N<item>  issue only for name field <item>
 *
 * Each ticket gets a 13-digit number (3-digit airline code + serial from
 * ctx.backend.nextTicketSerial()), is appended to pnr.tickets, and surfaces
 * in the ticketing
 * field (*T). Issuance does not change session state; the agent still ends the
 * transaction afterwards (the QR's "you must end the PNR after issuing").
 *
 * NOTE: the no-PQ / already-issued responses are reconstructed.
 */

import type { TicketEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import type { Pnr } from '../../models/pnr.js';
import type { FareQuote } from '../../models/fare.js';
import type { TicketRecord } from '../../models/ticket.js';
import { ticketNumber } from '../../models/ticket.js';
import { Response } from '../../dialects/sabre/responses.js';
import { renderTicketing } from '../../protocol/serializer.js';
import { priceItinerary } from './pricing-handler.js';
import type { HandlerContext } from './context.js';

/** Airports that make the journey international (drives the tariff basis). */
const INTL_AIRPORTS = new Set(['LHR', 'CDG', 'FRA', 'NRT', 'HND', 'SYD', 'YYZ', 'MEX']);

/** Per-passenger fares, expanded so block counts become one entry per traveler. */
function expandFares(fq: FareQuote): { base: number; taxTotal: number; total: number }[] {
  const out: { base: number; taxTotal: number; total: number }[] = [];
  for (const b of fq.passengers) {
    for (let i = 0; i < b.count; i++) out.push({ base: b.base, taxTotal: b.taxTotal, total: b.total });
  }
  return out;
}

/** Seat-occupying passengers as "SURNAME/INITIAL" (optionally one name item). */
function ticketablePassengers(pnr: Pnr, nameItem?: number): string[] {
  const items = nameItem ? [pnr.names[nameItem - 1]].filter(Boolean) : pnr.names;
  const out: string[] = [];
  for (const item of items) {
    if (item.infant) continue; // infants are not issued here
    for (const p of item.passengers) out.push(`${item.surname}/${p.firstName.charAt(0)}`);
  }
  return out;
}

export function handleTicket(entry: TicketEntry, wa: WorkArea, ctx: HandlerContext): string {
  const pnr = wa.pnr;
  if (pnr.segments.length === 0) return Response.NO_ITINERARY;
  if (pnr.names.length === 0) return Response.NEED_NAME;
  if (pnr.tickets.length > 0) return 'TICKETS ALREADY ISSUED'; // reconstructed

  // Per-PQ named selection (W¥PQ2N1.2¥PQ5N1.3-1.5) — one ticket per named
  // passenger, drawn from that passenger's source PQ. Validate all PQs and
  // refs up front, then issue atomically (no partial state on failure).
  if (entry.pqNamedSelections) {
    const tariff: 'D' | 'I' = pnr.segments.some(
      (s) => INTL_AIRPORTS.has(s.origin) || INTL_AIRPORTS.has(s.destination)
    )
      ? 'I'
      : 'D';
    type Plan = { fq: FareQuote; passenger: string; base: number; taxTotal: number; total: number };
    const plan: Plan[] = [];
    for (const sel of entry.pqNamedSelections) {
      const q = pnr.priceQuotes[sel.record - 1];
      if (!q) return 'NO PQ RECORD'; // reconstructed
      const fares = expandFares(q);
      let i = 0;
      for (const ref of sel.names) {
        const item = pnr.names[ref.item - 1];
        const pax = item?.passengers[ref.passenger - 1];
        if (!item || !pax) return Response.FORMAT;
        const fare = fares[i] ?? fares[fares.length - 1] ?? { base: 0, taxTotal: 0, total: 0 };
        plan.push({
          fq: q,
          passenger: `${item.surname}/${pax.firstName.charAt(0)}`,
          base: fare.base,
          taxTotal: fare.taxTotal,
          total: fare.total,
        });
        i++;
      }
    }
    const type: 'TE' | 'TK' = entry.paperTicket ? 'TK' : 'TE';
    for (const p of plan) {
      const validating = entry.validatingCarrier ?? p.fq.validatingCarrier;
      let commission: number | undefined;
      if (entry.commissionAmount != null) commission = entry.commissionAmount;
      else if (entry.commissionPercent != null) commission = (p.base * entry.commissionPercent) / 100;
      pnr.tickets.push({
        number: ticketNumber(validating, ctx.backend.nextTicketSerial()),
        type,
        stock: 'AT',
        passenger: p.passenger,
        pcc: ctx.pcc,
        agent: wa.agent,
        issuedAt: new Date(),
        tariff,
        validatingCarrier: validating,
        base: p.base,
        taxTotal: p.taxTotal,
        total: p.total,
        commission,
        formOfPayment: entry.formOfPayment,
      });
    }
    return renderTicketing(pnr);
  }

  // Resolve to one or more FareQuotes. Multi-PQ (W¥PQ2-4/7) expands into
  // a list; ticketing draws fares from each PQ in ascending order per the
  // Issue Tickets QR p.1 "ticketing fulfills the Enhanced PQ records in
  // sequential order" rule.
  let fqs: FareQuote[];
  if (entry.pqRecords) {
    fqs = [];
    for (const n of entry.pqRecords) {
      const q = pnr.priceQuotes[n - 1];
      if (!q) return 'NO PQ RECORD'; // reconstructed
      fqs.push(q);
    }
  } else if (entry.source === 'pq') {
    const q = pnr.priceQuotes[(entry.pqRecord ?? 0) - 1];
    if (!q) return 'NO PQ RECORD'; // reconstructed
    fqs = [q];
  } else {
    const q = wa.lastPricing ?? priceItinerary(pnr);
    if (!q) return Response.NO_ITINERARY;
    fqs = [q];
  }

  const pax = ticketablePassengers(pnr, entry.nameItem);
  if (pax.length === 0) return Response.NEED_NAME;

  // The first PQ drives the "default" validating carrier (overridden below
  // by W¥A<carrier> if present). For multi-PQ, each ticket then takes its
  // own PQ's carrier — see the loop body.
  const fq = fqs[0];
  // Concatenate fare blocks across all selected PQs in order — the
  // sequential-fulfillment rule means tickets pull from PQ1's blocks first,
  // then PQ2's, etc. Build a parallel carriers array so multi-PQ tickets
  // can use their own PQ's validating carrier.
  const fares: { base: number; taxTotal: number; total: number }[] = [];
  const fareCarriers: string[] = [];
  for (const q of fqs) {
    const block = expandFares(q);
    fares.push(...block);
    for (let i = 0; i < block.length; i++) fareCarriers.push(q.validatingCarrier);
  }
  const zero = { base: 0, taxTotal: 0, total: 0 };
  const tariff: 'D' | 'I' = pnr.segments.some(
    (s) => INTL_AIRPORTS.has(s.origin) || INTL_AIRPORTS.has(s.destination)
  )
    ? 'I'
    : 'D';

  // W¥A<carrier> overrides the validating carrier on every ticket; otherwise
  // each ticket uses its source PQ's carrier (single-PQ → fq.validatingCarrier).
  const overrideCarrier = entry.validatingCarrier;

  // W¥S<n> selects a specific segment for ticketing. Validate against the
  // itinerary; the *T render doesn't show segment-number directly, so this
  // is for now a recorded selection only — the fare is the existing quote,
  // which the agent is expected to have built per-segment via WPS if they
  // wanted per-segment fares.
  if (entry.segment != null && (entry.segment < 1 || entry.segment > pnr.segments.length)) {
    return Response.SEGMENT_NOT_FOUND;
  }

  // W¥XETR forces paper-ticket issuance (ARC only per the QR). Changes the
  // *T `TE` (electronic) to `TK` (paper) and records the override on each
  // ticket.
  const ticketType: 'TE' | 'TK' = entry.paperTicket ? 'TK' : 'TE';

  // W¥F<fop> records the form of payment on each ticket. CVV (a separate
  // ¥CVV<n> qualifier) only attaches to a credit-card FOP; if it appears
  // without one, we ignore it rather than reject — real Sabre would format-
  // reject but the cost of a stricter check exceeds the value for now.
  const fop = entry.formOfPayment;

  pax.forEach((passenger, i) => {
    const fare = fares[i] ?? fares[fares.length - 1] ?? zero;
    const validating = overrideCarrier ?? fareCarriers[i] ?? fq.validatingCarrier;
    // Commission: KP<n> = percent of base; K<amt> = flat amount. Both forms
    // are mutually exclusive in the source's combined example (W¥PQ1¥KP0¥ALH);
    // if both somehow appear we let the flat-amount form win deterministically.
    let commission: number | undefined;
    if (entry.commissionAmount != null) commission = entry.commissionAmount;
    else if (entry.commissionPercent != null) commission = (fare.base * entry.commissionPercent) / 100;

    const record: TicketRecord = {
      number: ticketNumber(validating, ctx.backend.nextTicketSerial()),
      type: ticketType,
      stock: 'AT',
      passenger,
      pcc: ctx.pcc,
      agent: wa.agent,
      issuedAt: new Date(),
      tariff,
      validatingCarrier: validating,
      base: fare.base,
      taxTotal: fare.taxTotal,
      total: fare.total,
      commission,
      formOfPayment: fop,
    };
    pnr.tickets.push(record);
  });

  return renderTicketing(pnr);
}
