/**
 * Pricing handler + fare engine (WP family).
 *
 * The engine prices a set of legs against the tariff and a simple tax model
 * (US 7.5% of base, XF 4.50/segment, AY 5.60), producing one block per
 * passenger type. Discounts: ADT full, child (C…) 75%, infant (INF) 10% and
 * exempt from the per-seat XF/AY fees.
 *
 * Modes: WP price-as-booked, WP* redisplay, WPP passenger-type, WPS segment
 * selection, and bargain finder (WPNC/WPNCS/WPNCB). Pricing is a query (no
 * state change) except WPNCB, which rebooks classes via the MODIFY event.
 */

import type { PricingEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import type { Pnr } from '../../models/pnr.js';
import type { AirSegment } from '../../models/segment.js';
import type { FareQuote, PassengerFare } from '../../models/fare.js';
import type { Inventory } from '../../store/inventory.js';
import { fareFor, round2, BOOKING_CLASSES, classMultiplier } from '../../store/tariff.js';
import { Response } from '../../protocol/constants.js';
import { renderFareQuote, renderBargain, renderFareCalc } from '../../protocol/serializer.js';
import { SessionEvent } from '../session-state.js';
import type { HandlerContext } from './context.js';

interface Leg {
  carrier: string;
  origin: string;
  destination: string;
  bookingClass: string;
}

export interface Rebook {
  segment: number;
  carrier: string;
  flight: string;
  from: string;
  to: string;
}

export interface BargainResult {
  quote: FareQuote;
  rebooks: Rebook[];
}

/** Passenger-type fare discount relative to the adult fare. */
function discountFor(type: string): number {
  if (type === 'INF') return 0.1; // infant not occupying a seat
  if (/^C/.test(type)) return 0.75; // child (C, CNN, C05, …)
  return 1.0; // ADT and everything else
}

function legBase(legs: Leg[]): { base: number; fareBasis: string[] } {
  let base = 0;
  const fareBasis: string[] = [];
  for (const l of legs) {
    const f = fareFor(l.origin, l.destination, l.bookingClass);
    base += f.base;
    fareBasis.push(f.fareBasis);
  }
  return { base: round2(base), fareBasis };
}

/** Fare-construction line for a passenger type: "JFK AA LAX245.00Y14 … 490.00 END". */
function fareCalcFor(legs: Leg[], type: string): string {
  const disc = discountFor(type);
  let total = 0;
  let line = legs[0].origin;
  for (const l of legs) {
    const f = fareFor(l.origin, l.destination, l.bookingClass);
    const amt = round2(f.base * disc);
    total += amt;
    line += ` ${l.carrier} ${l.destination}${amt.toFixed(2)}${f.fareBasis}`;
  }
  return `${line} ${round2(total).toFixed(2)} END`;
}

function passengerFare(legs: Leg[], adultBase: number, type: string, count: number): PassengerFare {
  const base = round2(adultBase * discountFor(type));
  const taxes = [{ code: 'US', amount: round2(base * 0.075) }];
  if (type !== 'INF') {
    taxes.push({ code: 'XF', amount: round2(4.5 * legs.length) });
    taxes.push({ code: 'AY', amount: 5.6 });
  }
  const taxTotal = round2(taxes.reduce((sum, t) => sum + t.amount, 0));
  return {
    passengerType: type,
    count,
    base,
    taxes,
    taxTotal,
    total: round2(base + taxTotal),
    fareCalc: fareCalcFor(legs, type),
  };
}

function buildQuote(legs: Leg[], departureDate: string, validatingCarrier: string, blocks: { type: string; count: number }[]): FareQuote {
  const { base, fareBasis } = legBase(legs);
  return {
    departureDate,
    validatingCarrier,
    currency: 'USD',
    fareBasis,
    passengers: blocks.map((b) => passengerFare(legs, base, b.type, b.count)),
  };
}

const toLeg = (s: AirSegment): Leg => ({
  carrier: s.carrier,
  origin: s.origin,
  destination: s.destination,
  bookingClass: s.bookingClass,
});

export interface PriceOptions {
  passengerTypes?: string[];
  segments?: AirSegment[]; // subset to price (defaults to all)
}

export function priceItinerary(pnr: Pnr, opts: PriceOptions = {}): FareQuote | null {
  const segs = opts.segments ?? pnr.segments;
  if (segs.length === 0) return null;
  const blocks = opts.passengerTypes?.length
    ? opts.passengerTypes.map((type) => ({ type, count: 1 }))
    : [{ type: 'ADT', count: Math.max(1, pnr.passengerCount()) }];
  return buildQuote(segs.map(toLeg), segs[0].date, segs[0].carrier, blocks);
}

/** Cheapest class for a segment, cheaper than the current one (availability-aware). */
function recommendedClass(seg: AirSegment, inventory: Inventory, ignoreAvailability: boolean): string {
  let best = seg.bookingClass;
  let bestMult = classMultiplier(seg.bookingClass);
  for (const cls of BOOKING_CLASSES) {
    const mult = classMultiplier(cls);
    if (mult >= bestMult) continue;
    if (!ignoreAvailability) {
      const rem = inventory.remainingSeats(seg.date, seg.carrier, seg.flightNumber, cls);
      if (rem === undefined || rem < seg.seats) continue;
    }
    best = cls;
    bestMult = mult;
  }
  return best;
}

export function bargainFind(pnr: Pnr, inventory: Inventory, ignoreAvailability: boolean): BargainResult | null {
  if (pnr.segments.length === 0) return null;
  const rebooks: Rebook[] = [];
  const legs: Leg[] = pnr.segments.map((s, i) => {
    const to = recommendedClass(s, inventory, ignoreAvailability);
    if (to !== s.bookingClass) {
      rebooks.push({ segment: i + 1, carrier: s.carrier, flight: s.flightNumber, from: s.bookingClass, to });
    }
    return { carrier: s.carrier, origin: s.origin, destination: s.destination, bookingClass: to };
  });
  const quote = buildQuote(legs, pnr.segments[0].date, pnr.segments[0].carrier, [
    { type: 'ADT', count: Math.max(1, pnr.passengerCount()) },
  ]);
  return { quote, rebooks };
}

/**
 * Store a quote as PQ record(s) — one per passenger-type block (Sabre creates a
 * separate PQ record per type). Returns the "retained" confirmation + records.
 */
function storeAndRender(pnr: Pnr, fq: FareQuote): string {
  const created = fq.passengers.map((block) => ({ ...fq, passengers: [block] }));
  pnr.priceQuotes.push(...created);
  const out = ['PRICE QUOTE RECORD RETAINED', 'FARE NOT GUARANTEED UNTIL TICKETED'];
  for (const q of created) {
    out.push('', `PQ ${pnr.priceQuotes.indexOf(q) + 1}`, renderFareQuote(q));
  }
  return out.join('\n');
}

export function handlePricing(entry: PricingEntry, wa: WorkArea, ctx: HandlerContext): string {
  if (entry.mode === 'redisplay') {
    return wa.lastPricing ? renderFareQuote(wa.lastPricing) : 'NO PRICING TO DISPLAY'; // TODO: confirm
  }

  if (entry.mode === 'store') {
    // PQ: store the last pricing response.
    if (!wa.lastPricing) return 'NO PRICING TO STORE'; // TODO: confirm wording
    return storeAndRender(wa.pnr, wa.lastPricing);
  }

  if (entry.mode === 'farecalc') {
    // WPDF: display the fare-calculation description of the last pricing.
    if (!wa.lastPricing) return 'NO PRICING TO DISPLAY'; // TODO: confirm wording
    return renderFareCalc(wa.lastPricing, entry.fareCalcLine);
  }

  if (entry.mode === 'bargain') {
    const result = bargainFind(wa.pnr, ctx.inventory, entry.ignoreAvailability ?? false);
    if (!result) return 'UNABLE TO PRICE - NO ITINERARY'; // TODO: confirm wording

    if (entry.rebook && result.rebooks.length > 0) {
      wa.machine.transition(SessionEvent.MODIFY);
      for (const r of result.rebooks) {
        const seg = wa.pnr.segments[r.segment - 1];
        ctx.inventory.release(seg.date, seg.carrier, seg.flightNumber, r.from, seg.seats);
        ctx.inventory.sell(seg.date, seg.carrier, seg.flightNumber, r.to, seg.seats);
        seg.bookingClass = r.to;
      }
    }
    wa.lastPricing = result.quote;
    return renderBargain(result.quote, result.rebooks, entry.rebook ?? false);
  }

  // mode 'price', optionally with passenger types and/or a segment selection.
  let segments: AirSegment[] | undefined;
  if (entry.segments) {
    if (entry.segments.some((n) => n < 1 || n > wa.pnr.segments.length)) return Response.SEGMENT_NOT_FOUND;
    segments = entry.segments.map((n) => wa.pnr.segments[n - 1]);
  }
  const fq = priceItinerary(wa.pnr, { passengerTypes: entry.passengerTypes, segments });
  if (!fq) return 'UNABLE TO PRICE - NO ITINERARY'; // TODO: confirm wording
  wa.lastPricing = fq;
  return entry.store ? storeAndRender(wa.pnr, fq) : renderFareQuote(fq);
}
