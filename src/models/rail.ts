/**
 * Rail domain model — v6 rail arc, per `docs/non-air-domain-pattern.md`.
 *
 * Cryptic surface per the Amadeus QRG Rail chapter (p.114-118):
 * Rail Mode entries take an `R/` prefix (`R/AD 20JULWASNYP5P`
 * availability by departure time, `R/AN …` neutral availability);
 * the sell is the standard `SS<seats><class><line>` from a rail
 * availability display; cancel is the standard `XE<n>` element
 * cancel. Providers are 2-char Amadeus codes found via DNA/DNP
 * (e.g. 2V Amtrak, 9F Eurostar, 9B AccesRail).
 *
 * RailService: one scheduled train. Station codes are the 3-letter
 * rail-station codes the QRG examples use (WAS, NYP, GOT, STO, XPG…).
 *
 * RailSegment: a sold rail journey on the PNR — segmentNumber-aligned
 * with air/hotel/car so displays interleave uniformly (TRN marker).
 */

export interface RailService {
  /** 2-char Amadeus provider code (2V, 9F, 9B, …). */
  provider: string;
  /** Train number. */
  trainNumber: string;
  origin: string;       // 3-letter station code
  destination: string;
  departTime: string;   // e.g. "500P" (same clock format as air)
  arriveTime: string;
  /** Seats remaining per class (F first, Y coach, etc.). */
  classSeats: Record<string, number>;
}

export interface RailSegment {
  segmentNumber: number;
  provider: string;
  providerName: string;
  trainNumber: string;
  bookingClass: string;
  date: string;         // DDMON
  origin: string;
  destination: string;
  departTime: string;
  arriveTime: string;
  seats: number;
  status: string;       // SS / HK
  confirmationNumber?: string;
}

/** Provider code → display name (DNA/DNP lookups + the TRN line). */
export const RAIL_PROVIDER_NAMES: Record<string, string> = {
  '2V': 'AMTRAK',
  '9F': 'EUROSTAR',
  '9B': 'ACCESRAIL',
  '9G': 'RAIL AIRPORT EXPRESS',
};
