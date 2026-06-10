/**
 * EMD (Electronic Miscellaneous Document) domain — chunk 31.
 *
 * Sources:
 * - Amadeus Service Hub solution 848456 ("How to search for
 *   information in the EMD guide"), extracted verbatim 2026-06-10:
 *   the EGSD guide screens (LIST OF EMD SERVICES layout + per-service
 *   detail attributes) using Amadeus's 6X test airline and LH.
 * - In-tree QRG: EGSD guide verbs, TTM issuance (p.172), EWD record
 *   displays (p.214).
 *
 * EmdService — one row of a carrier's EMD guide. RFIC is the IATA
 * Reason For Issuance Code (A air transportation, C baggage, D
 * financial impact, E airport services, G in-flight services…);
 * RFISC is the sub-code. Booking method SSR vs SVC determines what
 * PNR element the EMD issues against.
 *
 * EmdRecord — an issued document on the PNR (TTM). Numbers share the
 * 13-digit airline-prefixed shape tickets use.
 */

export interface EmdService {
  carrier: string;
  /** 4-char service code (FBAG, PETC, XBAG…). */
  code: string;
  /** Reason For Issuance Code (single letter). */
  rfic: string;
  /** Reason For Issuance Sub Code (3 char). */
  rfisc: string;
  /** Booking method — which PNR element carries the request. */
  bookingMethod: 'SSR' | 'SVC';
  /** Issuable by travel agents. */
  taIssuable: boolean;
  description: string;
  /**
   * Per-service fee. SYNTHETIC — no public source publishes carrier
   * service-fee tables; flagged per the emulator's tariff convention.
   */
  amount: number;
  currency: string;
  /** Detail-screen attributes (verbatim field set from the FBAG/LH
   *  sample). Defaults applied when unset. */
  detail?: Partial<EmdServiceDetail>;
}

export interface EmdServiceDetail {
  emdType: 'A' | 'S';
  monocoupon: boolean;
  consumedAtIssuance: boolean;
  additionalDocInExchange: boolean;
  residualValue: boolean;
  routingMandatory: boolean;
  issuedInConnectionMandatory: boolean;
  excessBaggageMandatory: boolean;
  refundable: boolean;
  exchangeable: boolean;
  interlineable: boolean;
  endorsable: boolean;
  displayableByTaIfAirlineIssued: boolean;
  refundExchangeByTaIfAirlineIssued: boolean;
  taAssociateDisassociate: boolean;
}

export const EMD_DETAIL_DEFAULTS: EmdServiceDetail = {
  emdType: 'A',
  monocoupon: false,
  consumedAtIssuance: false,
  additionalDocInExchange: false,
  residualValue: false,
  routingMandatory: true,
  issuedInConnectionMandatory: true,
  excessBaggageMandatory: false,
  refundable: false,
  exchangeable: true,
  interlineable: true,
  endorsable: true,
  displayableByTaIfAirlineIssued: true,
  refundExchangeByTaIfAirlineIssued: true,
  taAssociateDisassociate: false,
};

export interface EmdRecord {
  /** 13-digit document number (airline numeric prefix + serial). */
  number: string;
  carrier: string;
  serviceCode: string;
  rfic: string;
  rfisc: string;
  /** A = associated to a flight coupon; S = standalone. */
  emdType: 'A' | 'S';
  passenger: string; // SURNAME/INITIAL
  /** The PNR element line the EMD was issued against. */
  elementRef?: number;
  amount: number;
  currency: string;
  status: 'OPEN' | 'USED' | 'REFUNDED' | 'VOIDED' | 'EXCHANGED';
  issuedAt: Date;
  pcc: string;
}
