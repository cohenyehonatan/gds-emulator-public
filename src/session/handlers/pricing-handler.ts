/**
 * Pricing handler + fare engine (WP family).
 *
 * The engine prices a set of legs against the tariff and a simple tax model
 * (US 7.5%, XF 4.50/segment, AY 5.60). Bargain finder (WPNC/WPNCS/WPNCB)
 * searches cheaper booking classes per segment — constrained by availability
 * unless WPNCS — and either advises the rebook or applies it (WPNCB).
 *
 * Pricing is a query (no state change) except WPNCB, which rebooks classes and
 * so uses the MODIFY event.
 */

import type { PricingEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import type { Pnr } from '../../models/pnr.js';
import type { AirSegment } from '../../models/segment.js';
import type { FareQuote } from '../../models/fare.js';
import type { Inventory } from '../../store/inventory.js';
import { fareFor, round2, BOOKING_CLASSES, classMultiplier } from '../../store/tariff.js';
import { renderFareQuote, renderBargain } from '../../protocol/serializer.js';
import { SessionEvent } from '../session-state.js';
import type { HandlerContext } from './context.js';

interface Leg {
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

/** Price a list of legs into a FareQuote. */
function quoteLegs(legs: Leg[], departureDate: string, validatingCarrier: string, paxCount: number): FareQuote {
  let base = 0;
  const fareBasis: string[] = [];
  for (const l of legs) {
    const f = fareFor(l.origin, l.destination, l.bookingClass);
    base += f.base;
    fareBasis.push(f.fareBasis);
  }
  base = round2(base);
  const taxes = [
    { code: 'US', amount: round2(base * 0.075) },
    { code: 'XF', amount: round2(4.5 * legs.length) },
    { code: 'AY', amount: 5.6 },
  ];
  const taxTotal = round2(taxes.reduce((sum, t) => sum + t.amount, 0));
  return {
    departureDate,
    validatingCarrier,
    currency: 'USD',
    passengerType: 'ADT',
    passengerCount: paxCount,
    base,
    taxes,
    taxTotal,
    total: round2(base + taxTotal),
    fareBasis,
  };
}

export function priceItinerary(pnr: Pnr): FareQuote | null {
  if (pnr.segments.length === 0) return null;
  const legs = pnr.segments.map((s) => ({ origin: s.origin, destination: s.destination, bookingClass: s.bookingClass }));
  return quoteLegs(legs, pnr.segments[0].date, pnr.segments[0].carrier, Math.max(1, pnr.passengerCount()));
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
    return { origin: s.origin, destination: s.destination, bookingClass: to };
  });
  const quote = quoteLegs(legs, pnr.segments[0].date, pnr.segments[0].carrier, Math.max(1, pnr.passengerCount()));
  return { quote, rebooks };
}

export function handlePricing(entry: PricingEntry, wa: WorkArea, ctx: HandlerContext): string {
  if (entry.mode === 'redisplay') {
    return wa.lastPricing ? renderFareQuote(wa.lastPricing) : 'NO PRICING TO DISPLAY'; // TODO: confirm
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

  const fq = priceItinerary(wa.pnr);
  if (!fq) return 'UNABLE TO PRICE - NO ITINERARY'; // TODO: confirm wording
  wa.lastPricing = fq;
  return renderFareQuote(fq);
}
