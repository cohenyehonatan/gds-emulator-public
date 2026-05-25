/**
 * Pricing handler + fare engine (WP).
 *
 * priceItinerary sums the per-segment base fare from the tariff, adds a simple
 * tax model (US transportation 7.5%, XF passenger-facility 4.50/segment, AY
 * security 5.60), and totals it for the seat-occupying passengers. Pricing is a
 * query — it does not change session state. The quote is cached for WP*.
 */

import type { PricingEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import type { Pnr } from '../../models/pnr.js';
import type { FareQuote } from '../../models/fare.js';
import { fareFor, round2 } from '../../store/tariff.js';
import { renderFareQuote } from '../../protocol/serializer.js';

export function priceItinerary(pnr: Pnr): FareQuote | null {
  if (pnr.segments.length === 0) return null;

  let base = 0;
  const fareBasis: string[] = [];
  for (const s of pnr.segments) {
    const f = fareFor(s.origin, s.destination, s.bookingClass);
    base += f.base;
    fareBasis.push(f.fareBasis);
  }
  base = round2(base);

  const taxes = [
    { code: 'US', amount: round2(base * 0.075) },
    { code: 'XF', amount: round2(4.5 * pnr.segments.length) },
    { code: 'AY', amount: 5.6 },
  ];
  const taxTotal = round2(taxes.reduce((sum, t) => sum + t.amount, 0));

  return {
    departureDate: pnr.segments[0].date,
    validatingCarrier: pnr.segments[0].carrier,
    currency: 'USD',
    passengerType: 'ADT',
    passengerCount: Math.max(1, pnr.passengerCount()),
    base,
    taxes,
    taxTotal,
    total: round2(base + taxTotal),
    fareBasis,
  };
}

export function handlePricing(entry: PricingEntry, wa: WorkArea): string {
  if (entry.mode === 'redisplay') {
    return wa.lastPricing ? renderFareQuote(wa.lastPricing) : 'NO PRICING TO DISPLAY'; // TODO: confirm
  }
  const fq = priceItinerary(wa.pnr);
  if (!fq) return 'UNABLE TO PRICE - NO ITINERARY'; // TODO: confirm wording
  wa.lastPricing = fq;
  return renderFareQuote(fq);
}
