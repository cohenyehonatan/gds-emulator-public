/**
 * Fare quote — the result of pricing an itinerary (WP). Modeled on the Basic
 * Pricing QR response: one block per passenger type (each with a base fare, tax
 * breakdown, and total), plus the shared fare-basis codes and validating carrier.
 */

export interface TaxItem {
  code: string; // e.g. US, XF, AY
  amount: number;
}

/** One passenger-type block (ADT, C05, INF, …). Amounts are per passenger. */
export interface PassengerFare {
  passengerType: string;
  count: number;
  base: number;
  taxes: TaxItem[];
  taxTotal: number;
  total: number; // base + taxTotal, per passenger
}

export interface FareQuote {
  departureDate: string; // first priced segment's date token
  validatingCarrier: string;
  currency: string; // USD
  fareBasis: string[]; // one per priced segment
  passengers: PassengerFare[];
}
