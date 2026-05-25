/**
 * Fare quote — the result of pricing an itinerary (WP). Modeled on the Basic
 * Pricing QR response: a per-passenger-type base fare, a tax breakdown, and a
 * total, plus the fare-basis codes and validating carrier.
 */

export interface TaxItem {
  code: string; // e.g. US, XF, AY
  amount: number;
}

export interface FareQuote {
  departureDate: string; // first segment's date token
  validatingCarrier: string;
  currency: string; // USD
  passengerType: string; // ADT
  passengerCount: number;
  base: number; // base fare per passenger
  taxes: TaxItem[];
  taxTotal: number;
  total: number; // base + taxTotal per passenger
  fareBasis: string[]; // one per priced segment
}
