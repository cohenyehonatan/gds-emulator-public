/**
 * Seed fare tariff — the pricing analog of the flight inventory.
 *
 * A real GDS prices against millions of filed fares. We approximate: a base
 * fare per market, scaled by a booking-class multiplier, with a generated fare
 * basis code. Deterministic, so any booked segment can be priced without
 * gaps. Amounts are USD.
 */

export interface SegmentFare {
  base: number;
  fareBasis: string; // e.g. "Y14"
}

/** Round to 2 decimal places. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** One-way base fare per market (origin+destination). */
const MARKET_BASE: Record<string, number> = {
  JFKLAX: 245,
  LAXJFK: 245,
  DFWLHR: 870,
  JFKORD: 150,
  ORDSFO: 195,
  JFKDEN: 210,
  DENSFO: 110,
};
const DEFAULT_BASE = 250;

/** Booking-class price multiplier (premium cabins cost more). */
const CLASS_MULT: Record<string, number> = {
  F: 3.2, A: 3.0, // first
  J: 2.6, C: 2.4, D: 2.2, // business
  Y: 1.0, B: 0.92, M: 0.82, H: 0.8, K: 0.78, // full/discount economy
  L: 0.74, V: 0.7, // deep discount
};
const DEFAULT_MULT = 1.0;

/** Look up the one-way fare for a market and booking class. */
export function fareFor(origin: string, destination: string, bookingClass: string): SegmentFare {
  const marketBase = MARKET_BASE[origin + destination] ?? DEFAULT_BASE;
  const mult = CLASS_MULT[bookingClass] ?? DEFAULT_MULT;
  return { base: round2(marketBase * mult), fareBasis: `${bookingClass}14` };
}
