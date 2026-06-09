/**
 * Car-rental domain model — Amadeus v4 chunk 23.
 *
 * CarRental: an available vehicle plan at a location. Company is the
 * 2-letter Amadeus code (ZE = Hertz, ZD = Budget, ZA = Avis, ET =
 * Enterprise). Vehicle type codes follow the ACRISS SIPP standard
 * (4 chars: size, body, transmission, fuel — e.g. ECMN = Economy
 * Car 2/4-door Manual unspecified-fuel).
 *
 * CarSegment: a sold car booked into the PNR. Mirrors AirSegment's
 * segmentNumber + status so cross-dialect PNR displays reference air
 * + hotel + car uniformly.
 */

export interface CarRental {
  /** 2-letter Amadeus company code (ZE/ZD/ZA/ET/etc.). */
  company: string;
  /** ACRISS SIPP vehicle-type code (e.g. ECMN, CCAR, IDAR). */
  vehicleType: string;
  /** Human-readable vehicle category (e.g. "ECONOMY CAR"). */
  category: string;
  /** Rate code (e.g. WRY weekly rate, BST best, COR corporate). */
  rateCode: string;
  /** Per-day amount. */
  amount: number;
  currency: string;
  /** Number of available vehicles. */
  available: number;
  /** Pickup city (3-letter). */
  city: string;
}

export interface CarSegment {
  segmentNumber: number;
  company: string;
  companyName: string;
  vehicleType: string;
  category: string;
  rateCode: string;
  city: string;
  pickup: string;       // DDMON
  dropoff: string;      // DDMON
  days: number;
  amount: number;       // per-day
  currency: string;
  pickupTime?: string;  // HHMM (e.g. "0900")
  dropoffTime?: string;
  status: string;       // HK / NN / KK
  confirmationNumber?: string;
}

/** Default pickup / dropoff hours for our emulator. */
export const DEFAULT_PICKUP_HOUR = '0900';
export const DEFAULT_DROPOFF_HOUR = '1700';
