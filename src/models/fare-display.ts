/**
 * Fare display — the result of an `FD<...>` query. Source: Galileo
 * Mini Format Guide v2 (cryptic) + Travelport `APIRef_FareDisplay.htm`
 * (REST response shape).
 *
 * One line per published fare for the requested O&D + carrier filter.
 * Rendered as a tabular cryptic screen by the Galileo serializer.
 */

export interface FareDisplayLine {
  /** 1-based row number — what the agent references for follow-on entries. */
  sequence: number;
  /** Validating carrier (2-letter IATA). */
  carrier: string;
  /** Fare amount in `currency` (per pax, one way / round trip per `journeyType`). */
  amount: number;
  /** Fare basis code (e.g. `YEE3M`, `YOWUS`). */
  fareBasisCode: string;
  /** Booking class (single letter — Y, J, F, B, ...). */
  bookingClass: string;
  /** `OW` (one way) or `RT` (round trip) per the REST `oneWayInd`/`roundTripInd`. */
  journeyType: 'OW' | 'RT';
}

export interface FareDisplayResult {
  /** 3-letter IATA origin. */
  origin: string;
  /** 3-letter IATA destination. */
  destination: string;
  /** Sabre-style date token (e.g. `14AUG`) — same format the cryptic uses. */
  departureDate: string;
  /** ISO 4217 currency code (e.g. `USD`, `GBP`). */
  currency: string;
  /** Carrier filter that was applied (empty array = no filter). */
  carriers: string[];
  lines: FareDisplayLine[];
  /**
   * Top-level `FareDisplayResponse.Identifier.value` — required to
   * look up fare rules via `GET /farerule/farerules/fromfaredisplay`
   * for follow-on `FN<...>` queries. Undefined when the response
   * didn't surface one (older / emulated paths).
   */
  identifier?: string;
}
