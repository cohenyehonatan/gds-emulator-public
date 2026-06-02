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
  fareCalc: string; // fare-construction line (WPDF), e.g. "JFK AA LAX245.00Y14 … 490.00 END"
}

/**
 * Form of payment attached to a filed fare via Galileo `TMU<n>F<form>`.
 * The variants mirror the v11 canonical bodies (`FormOfPaymentCash` /
 * `FormOfPaymentPaymentCard`).
 *
 * Government warrants (`TMU<n>FGR<code>`) are deferred — the cryptic
 * format is documented in Mini Format Guide v2 but the REST body
 * shape isn't in `APIRef_AddFOP.htm`.
 */
export type FormOfPayment =
  | { kind: 'cash'; nonRefundable?: boolean }
  | {
      kind: 'credit_card';
      /** 2-letter brand code (VI, AX, MC, CA, DC, JC, etc.). */
      brand: string;
      /** Card number (PAN); we store raw, mask at display. */
      pan: string;
      /** Expiration in MMYY. */
      expiry: string;
      /** Cardholder name (CVV deferred — needs SeriesCode + secure handling). */
      holderName?: string;
    };

export interface FareQuote {
  departureDate: string; // first priced segment's date token
  validatingCarrier: string;
  currency: string; // USD
  fareBasis: string[]; // one per priced segment
  passengers: PassengerFare[];
  /** Set by `TMU<n>F<form>`; falls back to cash when unset at TKP time. */
  fop?: FormOfPayment;
}
