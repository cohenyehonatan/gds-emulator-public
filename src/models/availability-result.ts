/**
 * Cached availability display.
 *
 * After a '1' availability entry, the host returns numbered flight lines.
 * A subsequent '0' sell references those line numbers (e.g. 01Y1 = line 1),
 * so the work area must remember the last display. This is the GDS analog of
 * the printer emulator's mode/resource context that later commands depend on.
 */

/**
 * Opaque vendor-side identifiers that ride along an AvailabilityLine
 * when it came from a live backend. EmulatedBackend leaves this field
 * undefined. A live-sell handler reads it to reference the exact offer
 * the agent chose (you can't sell a Travelport offer without echoing
 * back its Identifier).
 *
 * The mapper populates whichever sub-IDs the response actually had —
 * tests should never assume a specific shape beyond `offerId`.
 */
export interface VendorRef {
  /** ProductOffering / CatalogProductOffering identifier. */
  offerId?: string;
  /** Optional ProductBrandOptions / per-brand identifier (for FQ). */
  productId?: string;
  /** Optional ProductBrandOffering / brand identifier (for FQ). */
  brandId?: string;
}

export interface AvailabilityLine {
  line: number; // 1-based, as shown to the agent
  carrier: string;
  flightNumber: string;
  /** Classes shown with seat counts, e.g. { Y: 9, B: 4, F: 2 }. */
  classes: Record<string, number>;
  origin: string;
  destination: string;
  departTime: string;
  arriveTime: string;
  equipment: string;
  date: string; // Sabre date token
  dayOfWeek: string;
  dayOfWeekNum: number; // 1-7 ISO
  /** Connection grouping: legs of one connection share an id; nonstops omit it. */
  connectionGroup?: number;
  legIndex?: number; // 0-based position within the connection
  /** Opaque vendor identifiers — populated only when the line came from a live backend. */
  vendorRef?: VendorRef;
}

export interface AvailabilityResult {
  date: string;
  origin: string;
  destination: string;
  lines: AvailabilityLine[];
  /**
   * Search-transaction identifier from the Travelport search response
   * (`CatalogProductOfferingsResponse.CatalogProductOfferings.Identifier.value`).
   * Required by `addOffer`'s canonical
   * `CatalogProductOfferingsIdentifier.Identifier.value` field — without
   * it the workbench has no context to look up the per-offer short refs
   * (`o1`, `p0`) we hand it. EmulatedBackend leaves this undefined.
   */
  searchIdentifier?: string;
}
