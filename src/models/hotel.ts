/**
 * Hotel domain model — Amadeus v4 chunk 22.
 *
 * Property: a single hotel in a city. Chain + property code are
 * Amadeus's identifiers; chain is the 2-letter chain code (HI, SI,
 * MC, UI, BW, etc.), property is the 3-letter sub-code.
 *
 * Rate: one rate plan offered by a property (e.g. RAC, RACK, COR
 * corporate, GOV government, AAA). Rate types per the QRG p.104.
 *
 * Segment: a sold hotel stay attached to a Pnr (`pnr.hotelSegments`).
 * Mirrors AirSegment's segmentNumber + status fields so it can be
 * referenced uniformly in PNR-display verbs.
 */

export interface HotelProperty {
  /** 2-letter chain code (HI, SI, MC, UI, BW, etc.). */
  chain: string;
  /** 3-letter property code within the chain (e.g. TIE, AMB). */
  property: string;
  /** Property name (display). */
  name: string;
  /** 3-letter city code (e.g. MAD, ZRH, LON). */
  city: string;
  /** Address (display). */
  address: string;
  /** Available rate plans. */
  rates: HotelRate[];
}

export interface HotelRate {
  /** Rate code (RAC = rack rate; COR = corporate; GOV; AAA; etc.). */
  code: string;
  /** Per-night amount. */
  amount: number;
  currency: string;
  /** Number of available rooms at this rate. */
  available: number;
}

export interface HotelSegment {
  segmentNumber: number;
  chain: string;
  property: string;
  name: string;
  city: string;
  checkIn: string;  // DDMON
  checkOut: string; // DDMON
  nights: number;
  rateCode: string;
  ratePerNight: number;
  currency: string;
  rooms: number;
  status: string; // HK / NN / KK etc. (mirrors AirSegment.status)
  confirmationNumber?: string;
}

/** Default check-in / check-out hours for our emulator. */
export const DEFAULT_CHECK_IN_HOUR = '1500';
export const DEFAULT_CHECK_OUT_HOUR = '1200';
