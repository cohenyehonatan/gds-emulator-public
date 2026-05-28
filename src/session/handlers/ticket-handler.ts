/**
 * E-ticket issuance (Sabre Issue-Tickets QR).
 *
 *   W¥ / TTP   issue one e-ticket per seat-occupying passenger, pricing the
 *              itinerary as booked (or using the last WP quote if present)
 *   W¥PQ<n>    issue from stored Enhanced PQ record <n>
 *   W¥N<item>  issue only for name field <item>
 *
 * Each ticket gets a 13-digit number (3-digit airline code + serial from
 * ctx.ticketSerial), is appended to pnr.tickets, and surfaces in the ticketing
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

  let fq: FareQuote | null;
  if (entry.source === 'pq') {
    fq = pnr.priceQuotes[(entry.pqRecord ?? 0) - 1] ?? null;
    if (!fq) return 'NO PQ RECORD'; // reconstructed
  } else {
    fq = wa.lastPricing ?? priceItinerary(pnr);
    if (!fq) return Response.NO_ITINERARY;
  }

  const pax = ticketablePassengers(pnr, entry.nameItem);
  if (pax.length === 0) return Response.NEED_NAME;

  const fares = expandFares(fq);
  const zero = { base: 0, taxTotal: 0, total: 0 };
  const tariff: 'D' | 'I' = pnr.segments.some(
    (s) => INTL_AIRPORTS.has(s.origin) || INTL_AIRPORTS.has(s.destination)
  )
    ? 'I'
    : 'D';

  pax.forEach((passenger, i) => {
    const fare = fares[i] ?? fares[fares.length - 1] ?? zero;
    const record: TicketRecord = {
      number: ticketNumber(fq.validatingCarrier, ctx.ticketSerial++),
      type: 'TE',
      stock: 'AT',
      passenger,
      pcc: ctx.pcc,
      agent: wa.agent,
      issuedAt: new Date(),
      tariff,
      validatingCarrier: fq.validatingCarrier,
      base: fare.base,
      taxTotal: fare.taxTotal,
      total: fare.total,
    };
    pnr.tickets.push(record);
  });

  return renderTicketing(pnr);
}
