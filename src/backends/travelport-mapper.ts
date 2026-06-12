/**
 * Travelport CatalogProductOfferings → AvailabilityLine[] mapper.
 *
 * Translates the live-1G search response into the dialect-shared
 * AvailabilityLine model that EmulatedBackend's Inventory also produces,
 * so the same Galileo serializer (`renderGalileoAvailability`) renders
 * either side identically.
 *
 * **Source schema**: JSON Air v11 CatalogProductOfferingsResponse —
 * documented at support.travelport.com. The shape (defensively)
 * is roughly:
 *
 *   CatalogProductOfferingsResponse
 *     CatalogProductOfferings
 *       CatalogProductOffering: [
 *         {
 *           Departure: "DEN", Arrival: "FRA", DepartureDate: "YYYY-MM-DD",
 *           ProductBrandOptions: [
 *             {
 *               Flight: [{
 *                 carrier, number,
 *                 Departure: { location, time },
 *                 Arrival:   { location, time },
 *                 equipment
 *               }],
 *               ProductBrandOffering: [{
 *                 Brand, Price,
 *                 FareDetail: [{ FareBasis, BookingCode: { code, count } }]
 *               }]
 *             }
 *           ]
 *         }
 *       ]
 *
 * **Fidelity caveat**: the live response carries far more than
 * AvailabilityLine models (price, brand, baggage, cabin codes, etc.).
 * This mapper picks the minimum needed for a Galileo-style `A` display
 * — carrier, flight, origin/dest, depart/arrive times, equipment, and
 * aggregated booking-class seat counts. Richer mappings (price quote,
 * brand) come with the FQ live-pricing commit.
 *
 * Schema-version safety: every level is defensively destructured with
 * `??` fallbacks, so a Travelport server-side schema bump doesn't crash
 * the mapper — it just returns fewer lines.
 */

import type { AvailabilityLine, VendorRef } from '../models/availability-result.js';
import { Pnr } from '../models/pnr.js';
import type { AirSegment } from '../models/segment.js';
import type { NameItem } from '../models/name-element.js';
import type { PhoneElement } from '../models/phone-element.js';
import type { FareQuote, PassengerFare, TaxItem } from '../models/fare.js';
import { StatusCode } from '../protocol/constants.js';

export interface MapOptions {
  /** Sabre-style day-of-week letter ("S","M","T","W","Q","F","J"); falls back to "?". */
  dayOfWeekLetter?: string;
  /** ISO day-of-week (1=Mon … 7=Sun); falls back to 0. */
  dayOfWeekNum?: number;
  /** Date token to stamp on each AvailabilityLine ("15JUN"); falls back to "". */
  date?: string;
}

/** Top-level entry point. Walks a CatalogProductOfferings response. */
export function mapCatalogProductOfferings(
  response: unknown,
  opts: MapOptions = {}
): AvailabilityLine[] {
  const offerings = extractOfferings(response);
  // VERIFIED PRE-PROD 2026-06-06: actual responses put each
  // FlightDetail in the response-level ReferenceList[].Flight[]
  // table, with each ProductBrandOption referencing them via
  // `flightRefs: ['s17', 's18', ...]`. Same pattern for class
  // availability — Product details (with PassengerFlight.FlightProduct.
  // classOfService + Quantity) live in ReferenceList[where
  // @type=ReferenceListProduct].Product[], keyed by `id`. Mocked
  // fixtures embed Flight + FareDetail.BookingCode directly on the
  // brand option — we still tolerate that shape as a fallback.
  const flightTable = buildFlightTable(response);
  const productTable = buildProductTable(response);
  const lines: AvailabilityLine[] = [];
  let lineIndex = 0;
  let connectionGroup = 0;
  for (const offering of offerings) {
    const offerId = extractIdentifier(offering);
    const brandOptions = arrayish(offering?.ProductBrandOptions);
    for (const brandOpt of brandOptions) {
      const flights = resolveFlights(brandOpt, flightTable);
      if (flights.length === 0) continue;
      const classes = aggregateClasses(brandOpt, productTable);
      const vendorRef = buildVendorRef(offerId, brandOpt);
      const group = flights.length > 1 ? ++connectionGroup : undefined;
      flights.forEach((flight, legIndex) => {
        const line = flightToLine(flight, ++lineIndex, classes, opts);
        if (line) {
          if (group !== undefined) {
            line.connectionGroup = group;
            line.legIndex = legIndex;
          }
          if (vendorRef !== undefined) line.vendorRef = vendorRef;
          lines.push(line);
        }
      });
    }
  }
  return lines;
}

/**
 * Build a `flight-id → FlightDetail` map from the response-level
 * `ReferenceList`. ReferenceList is an array of typed entries; the
 * one we want has `@type: ReferenceListFlight` (or just any entry
 * with `Flight[]`) carrying the actual FlightDetail records, each
 * with an `id` field like `s21`.
 */
function buildFlightTable(response: unknown): Map<string, unknown> {
  const r = response as any;
  const env = r?.CatalogProductOfferingsResponse ?? r;
  const refList = arrayish(env?.ReferenceList);
  const table = new Map<string, unknown>();
  for (const ref of refList) {
    const flights = arrayish((ref as any)?.Flight);
    for (const f of flights) {
      const id = (f as any)?.id ?? (f as any)?.Id;
      if (typeof id === 'string' && id.length > 0) table.set(id, f);
    }
  }
  return table;
}

/**
 * Build a `product-id → ProductAir` map from the response-level
 * `ReferenceList`. The Product records carry class availability +
 * Quantity. Mocked fixtures usually skip this entirely.
 */
function buildProductTable(response: unknown): Map<string, unknown> {
  const r = response as any;
  const env = r?.CatalogProductOfferingsResponse ?? r;
  const refList = arrayish(env?.ReferenceList);
  const table = new Map<string, unknown>();
  for (const ref of refList) {
    const products = arrayish((ref as any)?.Product);
    for (const p of products) {
      const id = (p as any)?.id ?? (p as any)?.Id;
      if (typeof id === 'string' && id.length > 0) table.set(id, p);
    }
  }
  return table;
}

/**
 * Resolve a ProductBrandOption's flights. Pre-prod gives us
 * `flightRefs: string[]` that index into the table; mocked fixtures
 * embed `Flight: [...]` directly. Prefer the embedded shape (so test
 * fixtures stay self-contained), fall back to ref resolution.
 */
function resolveFlights(brandOpt: any, table: Map<string, unknown>): unknown[] {
  const embedded = arrayish(brandOpt?.Flight);
  if (embedded.length > 0) return embedded;
  const refs = arrayish(brandOpt?.flightRefs);
  const resolved: unknown[] = [];
  for (const ref of refs) {
    if (typeof ref !== 'string') continue;
    const f = table.get(ref);
    if (f) resolved.push(f);
  }
  return resolved;
}

/**
 * Pull the Travelport-side identifiers off an offering + brand option.
 * Returns undefined when nothing useful was found — better an absent
 * vendorRef than one with empty strings that a downstream live-sell
 * handler would post in an invalid payload.
 *
 * VERIFIED PRE-PROD 2026-06-05: the per-offer productRef Travelport
 * wants in `addOffer.ProductIdentifier[]` is NOT a vendor Identifier on
 * the ProductBrandOption — it's the short ref `p0`/`p1`/... at
 * `ProductBrandOffering[0].Product[0].productRef`. The mapper used to
 * fall back to `extractIdentifier(brandOpt)` which returned undefined
 * for real responses (mocked tests didn't catch this because they
 * inject Identifier nodes the live API doesn't emit).
 */
function buildVendorRef(offerId: string | undefined, brandOpt: any): VendorRef | undefined {
  const firstBrand = arrayish(brandOpt?.ProductBrandOffering)[0];
  const productId =
    arrayish(firstBrand?.Product)[0]?.productRef ??
    extractIdentifier(brandOpt); // legacy fallback for mocked test fixtures
  const brandId = extractIdentifier(firstBrand);
  if (!offerId && !productId && !brandId) return undefined;
  return { offerId, productId, brandId };
}

/**
 * Pull the search-transaction Identifier (`CatalogProductOfferingsResponse.
 * CatalogProductOfferings.Identifier.value`) off a search response.
 * Travelport's `addOffer` needs this as the
 * `CatalogProductOfferingsIdentifier.Identifier.value` — the per-offer
 * short refs (`o1`/`p0`) only make sense in the context of this
 * transaction. Returns undefined for mocked / non-live responses.
 */
export function extractSearchIdentifier(response: unknown): string | undefined {
  const r = response as any;
  const env = r?.CatalogProductOfferingsResponse ?? r;
  const ident = env?.CatalogProductOfferings?.Identifier?.value;
  return typeof ident === 'string' && ident.length > 0 ? ident : undefined;
}

/**
 * Pull `Identifier.value` (or just a plain `id` / `Id`) off any node.
 * Travelport TripServices is schema-inconsistent about which level
 * carries an Identifier; this catches the documented shapes.
 */
function extractIdentifier(node: any): string | undefined {
  if (node == null) return undefined;
  const fromIdentifier = node.Identifier?.value ?? node.identifier?.value;
  if (typeof fromIdentifier === 'string' && fromIdentifier.length > 0) return fromIdentifier;
  const direct = node.id ?? node.Id;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  return undefined;
}

/**
 * Unwrap the CatalogProductOffering array from the response. Tries the
 * documented shape first, falls back to a flatter `offerings: []`
 * landing zone some pre-prod tenants return.
 */
function extractOfferings(response: unknown): any[] {
  const r = response as any;
  const env = r?.CatalogProductOfferingsResponse ?? r;
  return (
    arrayish(env?.CatalogProductOfferings?.CatalogProductOffering) ??
    arrayish(env?.CatalogProductOfferings) ??
    arrayish(env?.offerings) ??
    []
  );
}

/**
 * Map a single Flight node to an AvailabilityLine. Returns null if the
 * minimum required fields (carrier + number + Departure/Arrival
 * locations) aren't present — we'd rather drop the line than emit
 * malformed Galileo output.
 */
function flightToLine(
  flight: any,
  line: number,
  classes: Record<string, number>,
  opts: MapOptions
): AvailabilityLine | null {
  const carrier = flight?.carrier ?? flight?.Carrier;
  const flightNumber = String(flight?.number ?? flight?.Number ?? '');
  const dep = flight?.Departure ?? {};
  const arr = flight?.Arrival ?? {};
  const origin = dep?.location ?? dep?.Location;
  const destination = arr?.location ?? arr?.Location;
  if (!carrier || !flightNumber || !origin || !destination) return null;
  return {
    line,
    carrier,
    flightNumber,
    classes,
    origin,
    destination,
    departTime: extractClock(dep?.time ?? dep?.Time),
    arriveTime: extractClock(arr?.time ?? arr?.Time),
    equipment: flight?.equipment ?? flight?.Equipment ?? '',
    date: opts.date ?? '',
    dayOfWeek: opts.dayOfWeekLetter ?? '?',
    dayOfWeekNum: opts.dayOfWeekNum ?? 0,
  };
}

/**
 * Aggregate booking-class seat counts across every ProductBrandOffering
 * in a brand-options block. FareDetail typically lists one entry per
 * priced segment per brand; BookingCode carries `{ code, count }`. We
 * sum the counts for each code, capped at 9 (Sabre-style display).
 */
function aggregateClasses(
  brandOpt: any,
  productTable?: Map<string, unknown>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const brandOffering of arrayish(brandOpt?.ProductBrandOffering)) {
    // Path A (mocked fixtures): FareDetail with BookingCode embedded
    // directly on the brand offering.
    for (const fareDetail of arrayish(brandOffering?.FareDetail)) {
      const bc = fareDetail?.BookingCode;
      const codes = arrayish(bc);
      if (codes.length === 0 && bc?.code) codes.push(bc);
      for (const cell of codes) {
        const code = cell?.code ?? cell?.Code;
        const count = Number(cell?.count ?? cell?.Count ?? 0);
        if (typeof code === 'string' && code.length === 1 && Number.isFinite(count)) {
          out[code] = Math.min(9, Math.max(out[code] ?? 0, count));
        }
      }
    }
    // Path B (pre-prod): resolve each ProductBrandOffering's Product
    // refs against the ReferenceListProduct table. classOfService is
    // a single-char letter on each FlightProduct; the Product-level
    // `Quantity` is the seat count for that fare.
    if (productTable) {
      for (const productRef of arrayish(brandOffering?.Product)) {
        const id: string | undefined = (productRef as any)?.productRef;
        if (!id) continue;
        const product = productTable.get(id) as any;
        if (!product) continue;
        const count = Number(product?.Quantity ?? 0);
        if (!Number.isFinite(count) || count <= 0) continue;
        for (const pf of arrayish(product?.PassengerFlight)) {
          for (const fp of arrayish((pf as any)?.FlightProduct)) {
            const cls: string | undefined = (fp as any)?.classOfService;
            if (typeof cls === 'string' && cls.length === 1) {
              out[cls] = Math.min(9, Math.max(out[cls] ?? 0, count));
            }
          }
        }
      }
    }
  }
  return out;
}

/**
 * Convert an ISO 8601 timestamp ("2026-06-27T08:00:00.000-06:00") to
 * the Sabre-style 4-digit clock ("0800") the emulator's serializer
 * expects. Returns "" if the input isn't an ISO timestamp.
 */
function extractClock(iso: unknown): string {
  if (typeof iso !== 'string') return '';
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}${m[2]}` : '';
}

function arrayish<T>(x: T | T[] | null | undefined): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * Reservation → Pnr mapper. Translates a TripServices reservation
 * response (typically returned by `GET /11/air/book/reservation/
 * reservations/{LocatorCode}`) into the dialect-shared Pnr model so
 * the same Galileo serializer renders a live retrieve identically to
 * an emulated one.
 *
 * The exact response shape isn't precisely documented in the spec
 * fetch we have. This mapper walks defensively at every level — the
 * documented `Reservation` wrapper, a flat shape some pre-prod tenants
 * return, and a fallback shape some access groups use. A `locator`
 * input takes precedence over whatever the response carries (the
 * caller knows what it asked for).
 *
 * What's mapped today: locator, names, segments, phones. Ticketing
 * field / received-from / SSRs / OSIs / remarks / frequent flyers /
 * tickets / pricing all stay default — they have natural REST
 * equivalents (`/accountings`, `/specialservices`, `/receipts`) that
 * a follow-up commit can wire in.
 */
export function mapReservation(response: unknown, locator: string): Pnr {
  const pnr = new Pnr();
  pnr.locator = locator;
  const r = response as any;
  // VERIFIED PRE-PROD 2026-06-06: retrieve responses wrap the
  // Reservation in `ReservationResponse` (same envelope as commit).
  // The other paths cover mocked-fixture / OrderReservation variants.
  const root =
    r?.ReservationResponse?.Reservation ??
    r?.Reservation ??
    r?.OrderReservationResponse?.Reservation ??
    r;
  if (root == null) return pnr;

  pnr.names = mapReservationTravelers(root);
  pnr.segments = mapReservationSegments(root);
  pnr.phones = mapReservationPhones(root);
  return pnr;
}

/**
 * Build a `${carrier}-${flightNumber}` → `offerId` lookup from a
 * Reservation response (e.g. the body returned by
 * `buildfromlocator`). Used by partial-cancel of a committed BF to
 * map each cryptic segment number to its server-side offer ID
 * without needing a cached availability.
 *
 * The Reservation structure groups segments under each Offer; we
 * walk every Offer node, pull its `Identifier.value`, then map each
 * flight inside that offer to it. Defensive against three shapes
 * we've seen across v11 access groups: `Offer`/`Offers.Offer`/
 * `AirReservation.Offer`.
 */
export function extractSegmentOfferIds(response: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const r = response as any;
  const root = r?.Reservation ?? r?.OrderReservationResponse?.Reservation ?? r;
  if (root == null) return out;
  const offers = arrayish(
    root?.Offer ?? root?.Offers?.Offer ?? root?.Offers ?? root?.AirReservation?.Offer
  );
  for (const offer of offers) {
    const offerId =
      offer?.Identifier?.value ??
      offer?.OfferIdentifier?.value ??
      offer?.offerId ??
      offer?.offerID;
    if (typeof offerId !== 'string' || offerId.length === 0) continue;
    const flights = arrayish(
      offer?.Flight ??
        offer?.Flights ??
        offer?.AirSegment ??
        offer?.BookingSegment ??
        offer?.Product ??
        offer?.Products
    );
    for (const f of flights) {
      const carrier = f?.carrier ?? f?.Carrier;
      const number = f?.number ?? f?.Number;
      if (!carrier || number == null) continue;
      out.set(`${carrier}-${String(number)}`, offerId);
    }
  }
  return out;
}

/** Travelers — one NameItem per Traveler element. */
function mapReservationTravelers(root: any): NameItem[] {
  const travelers = arrayish(root?.Traveler ?? root?.Travelers ?? root?.travelers);
  const out: NameItem[] = [];
  for (const t of travelers) {
    const pn = t?.PersonName ?? t?.personName ?? t;
    const surname = pn?.Surname ?? pn?.surname ?? pn?.lastName;
    const given = pn?.Given ?? pn?.given ?? pn?.firstName;
    if (!surname || !given) continue;
    out.push({
      surname: String(surname).trim(),
      passengers: [{ firstName: String(given).trim() }],
      count: 1,
      infant: false,
    });
  }
  return out;
}

/**
 * Segments. The retrieve response groups flights several ways
 * depending on access group / tenant:
 *   1. `AirReservation.Flights[]` (older shape, mocked tests)
 *   2. `BookingSegment[]` (newer flat shape)
 *   3. `Offer[].Product[].FlightSegment[].Flight` — VERIFIED pre-prod
 *      retrieve shape 2026-06-06 — each Offer is one priced fare
 *      block; within a Product the FlightSegments carry an embedded
 *      `Flight` (not a ref), and `Flight` has carrier/number/Departure/
 *      Arrival/equipment directly on it.
 * Path 3 also captures per-segment status (the FlightSegment carries
 * what we used to read off `flight.status`).
 */
function mapReservationSegments(root: any): AirSegment[] {
  // Path 1: documented AirReservation.Flights[]
  let flights = arrayish(root?.AirReservation?.Flights ?? root?.AirReservation?.Flight);
  // Path 2: flat BookingSegment[]
  if (flights.length === 0) {
    flights = arrayish(root?.BookingSegment ?? root?.Segments ?? root?.segments);
  }
  // Path 3: Offer[].Product[].FlightSegment[].Flight (pre-prod live).
  // Walk all Offers (multi-offer retrieves like a round-trip BF have
  // multiple Offer entries) and collect every embedded Flight in
  // segment-sequence order.
  if (flights.length === 0) {
    const offers = arrayish(root?.Offer);
    const collected: any[] = [];
    for (const offer of offers) {
      for (const product of arrayish((offer as any)?.Product)) {
        const segs = arrayish((product as any)?.FlightSegment);
        // Sort by `sequence` when present so multi-leg offers stay in
        // departure order even if the server returned them shuffled.
        const sorted = [...segs].sort(
          (a: any, b: any) => Number(a?.sequence ?? 0) - Number(b?.sequence ?? 0)
        );
        for (const seg of sorted) {
          const f = (seg as any)?.Flight;
          if (f) collected.push(f);
        }
      }
    }
    flights = collected;
  }
  const out: AirSegment[] = [];
  flights.forEach((flight: any, idx: number) => {
    const seg = flightToSegment(flight, idx + 1);
    if (seg) out.push(seg);
  });
  return out;
}

function flightToSegment(flight: any, segmentNumber: number): AirSegment | null {
  const carrier = flight?.carrier ?? flight?.Carrier;
  const flightNumber = String(flight?.number ?? flight?.Number ?? '');
  const dep = flight?.Departure ?? {};
  const arr = flight?.Arrival ?? {};
  const origin = dep?.location ?? dep?.Location;
  const destination = arr?.location ?? arr?.Location;
  if (!carrier || !flightNumber || !origin || !destination) return null;
  const status = (flight?.status ?? flight?.Status ?? StatusCode.HK) as string;
  const seats = Number(flight?.seats ?? flight?.numberOfStops ?? flight?.seatCount ?? 1) || 1;
  return {
    segmentNumber,
    carrier,
    flightNumber,
    bookingClass: flight?.cabin ?? flight?.bookingClass ?? flight?.classOfService ?? 'Y',
    date: extractDateToken(dep?.time ?? dep?.Time),
    dayOfWeek: '?',
    dayOfWeekNum: 0,
    origin,
    destination,
    status,
    seats,
    departTime: extractClock(dep?.time ?? dep?.Time),
    arriveTime: extractClock(arr?.time ?? arr?.Time),
  };
}

/**
 * Phones — collected from every Traveler.Telephone in the reservation
 * AND any top-level PrimaryContact telephones. The Galileo phone field
 * carries the raw text, so we don't split city/number/type.
 */
function mapReservationPhones(root: any): PhoneElement[] {
  const out: PhoneElement[] = [];
  // Dedupe across the two sources: our own build flow posts the same
  // number through ensureLiveTravelersPosted (traveler Telephone) AND
  // addPrimaryContact (reservation contact), so committed BFs come
  // back with the number twice (dogfooding find 2026-06-12: P. shown
  // twice on every retrieved BF). Distinct numbers all survive —
  // only exact duplicates (digits-only comparison) collapse. Root
  // cause is the double-post; single-posting needs validation against
  // pre-prod (ROADMAP) before we touch the build flow.
  const seen = new Set<string>();
  const push = (num: unknown) => {
    if (typeof num !== 'string' || num.length === 0) return;
    const key = num.replace(/\D/g, '') || num;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ number: num });
  };
  const travelers = arrayish(root?.Traveler ?? root?.Travelers ?? root?.travelers);
  for (const t of travelers) {
    for (const tel of arrayish(t?.Telephone ?? t?.telephone)) {
      push(tel?.phoneNumber ?? tel?.PhoneNumber ?? tel?.number);
    }
  }
  for (const pc of arrayish(root?.PrimaryContact ?? root?.primaryContact)) {
    for (const tel of arrayish(pc?.Telephone ?? pc?.telephone)) {
      push(tel?.phoneNumber ?? tel?.PhoneNumber ?? tel?.number);
    }
  }
  return out;
}

/**
 * Convert a TripServices ISO timestamp into the Sabre date token
 * (`DDMMM`). Returns "" if input isn't ISO — leaves the segment
 * date blank rather than guessing.
 */
function extractDateToken(iso: unknown): string {
  if (typeof iso !== 'string') return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '';
  const day = parseInt(m[3], 10);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const month = months[parseInt(m[2], 10) - 1];
  return month ? `${day}${month}` : '';
}

/**
 * Priced-offer response → FareQuote. Used by Galileo's live `FQ` path.
 *
 * The response (from POST /11/air/price/offers/buildfromcatalogproduct
 * offerings) returns a priced product offering containing per-passenger
 * pricing blocks and per-segment fare basis codes. The exact JSON shape
 * isn't pinned in the spec list we fetched; this walks defensively
 * across the documented `CatalogProductOfferingsResponse.CatalogProduct
 * Offerings.CatalogProductOffering[].ProductBrandOptions[].Product
 * BrandOffering[].Price` shape with `.passengerType.Tax[]` and a flat
 * `Price` fallback.
 *
 * If extraction yields no passenger blocks, returns null — Galileo's
 * handler converts that to FARE QUOTE NOT AVAILABLE.
 */
export function mapPricedOffer(response: unknown, opts: { departureDate?: string } = {}): FareQuote | null {
  const r = response as any;
  const env = r?.CatalogProductOfferingsResponse ?? r;
  const offerings = arrayish(
    env?.CatalogProductOfferings?.CatalogProductOffering ?? env?.CatalogProductOfferings
  );
  if (offerings.length === 0) return null;
  const firstOffering = offerings[0];
  const brandOptions = arrayish(firstOffering?.ProductBrandOptions);
  if (brandOptions.length === 0) return null;
  const firstBrand = brandOptions[0];
  const brandOfferings = arrayish(firstBrand?.ProductBrandOffering);
  if (brandOfferings.length === 0) return null;
  const firstBrandOffering = brandOfferings[0];

  const passengers = extractPassengerFares(firstBrandOffering);
  if (passengers.length === 0) return null;

  // Pull fare basis codes from the FareDetail of each priced segment.
  const fareBasis: string[] = [];
  for (const fd of arrayish(firstBrandOffering?.FareDetail)) {
    const code = fd?.FareBasis ?? fd?.fareBasis;
    if (typeof code === 'string' && code.length > 0) fareBasis.push(code);
  }

  // Validating carrier: look on the brand offering, then on the offering.
  const validatingCarrier =
    firstBrandOffering?.validatingCarrier ??
    firstOffering?.validatingCarrier ??
    arrayish(firstBrand?.Flight)[0]?.carrier ??
    '';

  // Currency: usually on Price.currencyCode; fall back to first passenger block.
  const currency =
    firstBrandOffering?.Price?.currencyCode ??
    firstBrandOffering?.Price?.currency ??
    passengers[0]?.passengerType ? undefined : undefined;

  return {
    departureDate: opts.departureDate ?? '',
    validatingCarrier: String(validatingCarrier),
    currency: typeof currency === 'string' ? currency : 'USD',
    fareBasis,
    passengers,
  };
}

/**
 * Extract per-passenger pricing blocks from a ProductBrandOffering.
 * Travelport's response can present these as either an array of
 * `Price[].passengerType` entries or a flat `Price.passengerType[]`
 * collection; we try both shapes.
 */
function extractPassengerFares(brandOffering: any): PassengerFare[] {
  const out: PassengerFare[] = [];
  // Try the per-passenger-priced-offer shape:
  const priceItems = arrayish(brandOffering?.Price ?? brandOffering?.price);
  for (const p of priceItems) {
    const pt = p?.passengerType ?? p?.passengerTypeCode;
    if (pt) {
      const fare = mapOnePassengerFare(p, String(pt));
      if (fare) out.push(fare);
    }
  }
  if (out.length > 0) return out;

  // Fallback: single flat Price with passengerType[] inside.
  const flat = brandOffering?.Price ?? brandOffering?.price;
  if (flat?.passengerType) {
    for (const pt of arrayish(flat.passengerType)) {
      const fare = mapOnePassengerFare(flat, String(pt?.code ?? pt));
      if (fare) out.push(fare);
    }
  }
  return out;
}

function mapOnePassengerFare(priceNode: any, passengerType: string): PassengerFare | null {
  const base = Number(priceNode?.Base?.value ?? priceNode?.base ?? priceNode?.BasePrice ?? 0);
  const totalRaw = Number(priceNode?.TotalPrice?.value ?? priceNode?.total ?? priceNode?.Total ?? 0);
  if (!Number.isFinite(base) && !Number.isFinite(totalRaw)) return null;
  const taxes: TaxItem[] = [];
  for (const tx of arrayish(priceNode?.Tax ?? priceNode?.taxes ?? priceNode?.Taxes)) {
    const code = tx?.code ?? tx?.Code;
    const amount = Number(tx?.value ?? tx?.amount ?? tx?.Amount ?? 0);
    if (typeof code === 'string' && Number.isFinite(amount)) taxes.push({ code, amount });
  }
  const taxTotal = taxes.reduce((sum, t) => sum + t.amount, 0);
  const total = totalRaw || base + taxTotal;
  return {
    passengerType,
    count: Number(priceNode?.numberOfPassengers ?? priceNode?.number ?? 1) || 1,
    base,
    taxes,
    taxTotal,
    total,
    fareCalc: String(priceNode?.fareCalculation ?? priceNode?.FareCalculation ?? ''),
  };
}

/**
 * Receipts response → TicketRecord[]. Used by Galileo's live *HTI /
 * *HTE handler. The /receipts endpoint returns a Receipt[] with each
 * ticket's number, status, passenger, and totals.
 */
/**
 * `AgencyQueueResponse` → `QueueListResult`. Source: v11
 * `APIRef_QueueList.htm`. Defensive against shape drift across access
 * groups — tries the documented `AgencyQueue.QueueList[]` path plus
 * a few common alternatives.
 *
 * Each `QueueList[]` entry yields `{ locator, name, travelDate }`. We
 * pass-through whatever the source emits for the name and date — the
 * cryptic serializer is responsible for any further formatting.
 */
export function mapQueueList(
  response: unknown,
  queue: string
): import('../models/queue-list.js').QueueListResult {
  const r = response as any;
  const root =
    r?.AgencyQueueResponse?.AgencyQueue ??
    r?.AgencyQueue ??
    r?.agencyQueue ??
    r;
  const items: import('../models/queue-list.js').QueueListItem[] = [];
  const list = arrayish(root?.QueueList ?? root?.queueList ?? root?.Items ?? root?.items);
  for (const e of list) {
    const locator =
      e?.Locator?.value ?? e?.Locator ?? e?.locator ?? e?.LocatorCode ?? e?.locatorCode;
    if (typeof locator !== 'string' || locator.length === 0) continue;
    const rawName = e?.Name ?? e?.name ?? e?.PassengerName ?? e?.passengerName ?? '';
    let name: string;
    if (typeof rawName === 'string') {
      name = rawName;
    } else {
      // PersonName-style object: { Surname, Given }
      const surname = rawName?.Surname ?? rawName?.surname ?? rawName?.lastName ?? '';
      const given = rawName?.Given ?? rawName?.given ?? rawName?.firstName ?? '';
      name = surname && given ? `${surname}/${given.charAt(0)}` : String(surname || given || '');
    }
    const travelDate = String(
      e?.TravelDate ?? e?.travelDate ?? e?.DepartureDate ?? e?.departureDate ?? ''
    );
    items.push({ locator: String(locator), name: String(name), travelDate });
  }
  return { queue, items };
}

export function mapReceipts(response: unknown): import('../models/ticket.js').TicketRecord[] {
  const r = response as any;
  const receipts = arrayish(r?.Receipt ?? r?.Receipts ?? r?.receipts);
  const out: import('../models/ticket.js').TicketRecord[] = [];
  for (const receipt of receipts) {
    const number = String(receipt?.ticketNumber ?? receipt?.Number ?? receipt?.number ?? '');
    if (!number) continue;
    const passenger = receipt?.passengerName ?? receipt?.PassengerName ?? receipt?.passenger ?? '';
    const carrier = receipt?.validatingCarrier ?? receipt?.ValidatingCarrier ?? '';
    const status: import('../models/ticket.js').TicketRecord['status'] =
      ((receipt?.status ?? receipt?.Status) === 'VOIDED' ? 'VOIDED' : 'OPEN');
    out.push({
      number,
      type: receipt?.type === 'TK' ? 'TK' : 'TE',
      stock: receipt?.stock ?? 'AT',
      passenger: String(passenger),
      pcc: String(receipt?.pcc ?? ''),
      issuedAt: receipt?.issuedAt ? new Date(receipt.issuedAt) : new Date(0),
      tariff: 'D',
      validatingCarrier: String(carrier),
      base: Number(receipt?.base ?? 0),
      taxTotal: Number(receipt?.taxTotal ?? 0),
      total: Number(receipt?.total ?? 0),
      status,
    });
  }
  return out;
}

/**
 * `FareDisplayResponse` → `FareDisplayResult`. Source: `APIRef_
 * FareDisplay.htm` (verbatim 2026-06-03). The response groups fares
 * under `fareDisplay[].fare[]` — we flatten to a single
 * `FareDisplayResult.lines[]`.
 *
 * Defensive against shape drift: we try the documented paths first,
 * then a few common alternatives.
 */
export function mapFareDisplay(
  response: unknown,
  ctx: { origin: string; destination: string; departureDate: string; carriers: string[] }
): import('../models/fare-display.js').FareDisplayResult {
  const r = response as any;
  const root = r?.FareDisplayResponse ?? r;
  const identifier =
    typeof root?.Identifier?.value === 'string' ? (root.Identifier.value as string) : undefined;
  const groups = arrayish(root?.fareDisplay ?? root?.FareDisplay);
  const lines: import('../models/fare-display.js').FareDisplayLine[] = [];
  let currency = 'USD';
  let seq = 1;
  for (const g of groups) {
    if (g?.listCurrency) {
      currency = String(g.listCurrency?.value ?? g.listCurrency);
    }
    const fares = arrayish(g?.fare ?? g?.Fare);
    for (const f of fares) {
      const carrier = String(f?.carrier ?? f?.Carrier ?? '');
      if (!carrier) continue;
      const amount = Number(f?.amount?.value ?? f?.amount ?? f?.Amount ?? 0);
      const fareBasisCode = String(f?.fareBasisCode ?? f?.FareBasisCode ?? '');
      const bookingClass = String(f?.bookingClass ?? f?.BookingClass ?? '');
      const journeyType: 'OW' | 'RT' = f?.oneWayInd === true || f?.OneWayInd === true ? 'OW' : 'RT';
      lines.push({
        sequence: Number(f?.sequence ?? f?.Sequence ?? seq),
        carrier,
        amount,
        fareBasisCode,
        bookingClass,
        journeyType,
      });
      seq++;
    }
  }
  return {
    origin: ctx.origin,
    destination: ctx.destination,
    departureDate: ctx.departureDate,
    currency,
    carriers: ctx.carriers,
    lines,
    identifier,
  };
}

/**
 * Map a Travelport `CatalogOfferingsAncillaryListResponse` (the seat-
 * availability search response) to our cross-dialect SeatMap +
 * SeatAvailabilityList[] shape.
 *
 * Response structure (verbatim from the v11 devkit, captured in
 * docs/seatmap-design.md chunk 0):
 *   CatalogOfferingsAncillaryListResponse
 *   ├── CatalogOfferingsID[]                       (one per flight)
 *   │   ├── Flight[] (carrier, number, equipment, dep/arr)
 *   │   └── CatalogOffering[].ProductOptions[].Product[]
 *   │       ├── SeatAvailability[] grouped by status
 *   │       └── SeatingChartRef: "seatingChart_1"  (string-keyed link)
 *   └── ReferenceList[].SeatingChart[]            (per-equipment layout)
 *
 * Returns undefined if the response doesn't contain a parseable
 * seat-map block (defensive — pre-prod has been known to return
 * Result.Error[] envelopes with HTTP 200).
 */
export function mapSeatAvailabilities(response: unknown): {
  seatMap: import('../models/seat-map.js').SeatMap;
  availability: import('../models/seat-map.js').SeatAvailabilityList[];
} | undefined {
  const r = response as any;
  const env = r?.CatalogOfferingsAncillaryListResponse ?? r;
  const offerings = arrayish(env?.CatalogOfferingsID);
  if (offerings.length === 0) return undefined;

  // Build SeatingChartRef → SeatingChart table from ReferenceList.
  // String-keyed lookup — match by SeatingChart.id, NOT by array
  // index. ReferenceList may contain multiple typed entries; SeatingChart
  // entries live under @type='ReferenceListSeatingChart' but defensively
  // we accept any entry carrying SeatingChart[].
  const chartTable = new Map<string, any>();
  for (const ref of arrayish(env?.ReferenceList)) {
    for (const chart of arrayish((ref as any)?.SeatingChart)) {
      const id = (chart as any)?.id ?? (chart as any)?.Id;
      if (typeof id === 'string' && id.length > 0) chartTable.set(id, chart);
    }
  }

  // First offering = first flight (v1 only displays one flight per
  // query). Multi-flight + multi-passenger seat-selection flows are
  // deferred — see chunk 8 doc for the per-traveler seat-mapping
  // pattern the devkit's pre-script uses.
  const first = offerings[0] as any;
  const flight = arrayish(first?.Flight)[0] as any;
  if (!flight) return undefined;
  const carrier = String(flight?.carrier ?? '').toUpperCase();
  const flightNumber = String(flight?.number ?? '');
  const equipment = String(flight?.equipment ?? '');

  // Find the first Product carrying SeatAvailability + SeatingChartRef.
  let chartRef: string | undefined;
  const availability: import('../models/seat-map.js').SeatAvailabilityList[] = [];
  for (const offering of arrayish(first?.CatalogOffering)) {
    for (const opts of arrayish((offering as any)?.ProductOptions)) {
      for (const product of arrayish((opts as any)?.Product)) {
        const ref = (product as any)?.SeatingChartRef;
        if (typeof ref === 'string' && !chartRef) chartRef = ref;
        for (const bucket of arrayish((product as any)?.SeatAvailability)) {
          const status = (bucket as any)?.seatAvailabilityStatus;
          const value = arrayish((bucket as any)?.value).map((v: unknown) => String(v));
          if (status && value.length > 0) {
            availability.push({ seatAvailabilityStatus: String(status), value });
          }
        }
      }
    }
  }

  // Resolve the seating chart. If the ref is missing or doesn't
  // resolve, return an empty Cabin[] so the renderer prints "no
  // seats" gracefully — the availability still maps cleanly.
  const chart = chartRef ? chartTable.get(chartRef) : undefined;
  const Cabin: import('../models/seat-map.js').Cabin[] = [];
  for (const c of arrayish(chart?.Cabin)) {
    Cabin.push(mapCabin(c as any));
  }

  return {
    seatMap: { carrier, flightNumber, equipment, Cabin },
    availability,
  };
}

/**
 * Extract a Travelport seat-map error from a `Result.Error[]` envelope
 * (the HTTP-200-plus-semantic-error pattern that Travelport JSON Air
 * v11 uses; see `references/galileo/Travelport-JSON-Air-v11-API-
 * Spec.md`). Returns `undefined` if no errors are present, or the
 * mapped error info if at least one error appears.
 *
 * The numeric error code list is from the Travelport API Developer
 * Notes (`references/galileo/Travelport-API-Dev-Notes-Seat-Maps.pdf`
 * p.13 + the GWS task documentation). For the v11 JSON wire, codes
 * may use the same numerics or text-based codes — we accept both
 * by checking both `Code` and `Message` fields.
 */
export interface SeatMapError {
  /** Friendly response string suitable for surfacing to the operator. */
  message: string;
  /** Raw error code from the response (numeric string or text). */
  rawCode: string;
  /** Raw message from the response. */
  rawMessage: string;
}

/**
 * Map of GWS error codes / message fragments → friendly response
 * strings. Codes verbatim from the Dev Notes p.13 + the GWS task docs.
 * Lookup tries numeric Code first, then falls back to Message
 * substring matching for v11 JSON responses that may use text codes.
 */
const GWS_SEAT_MAP_ERRORS: Record<string, string> = {
  '11':  'INVALID BOARD/OFF POINT',
  '26':  'SEAT MAP UNAVAILABLE',
  '100': 'INVALID BOARD POINT',
  '101': 'INVALID OFF POINT',
  '102': 'INVALID DATE',
  '104': 'INVALID CLASS CODE',
  '107': 'INVALID AIRLINE CODE',
  '114': 'INVALID FLIGHT NUMBER',
  '118': 'SEAT MAP ERROR',
  '122': 'SEATING SUSPENDED - AIRPORT CHECK-IN',
  '197': 'NO SEATS AVAILABLE',
  '200': 'NO SEATING THIS FLIGHT',
  '201': 'NO SEATING THIS CLASS',
  '225': 'SEAT MAP UNAVAILABLE - CODE SHARE FLIGHT',
  '281': 'GENERIC SEATING ONLY',
};

/** Fragment-based fallback when the response carries a text Code or
 *  the numeric Code isn't in our lookup. Matches on Message substring. */
const SEAT_MAP_ERROR_FRAGMENTS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /CODE.?SHARE/i,            message: 'SEAT MAP UNAVAILABLE - CODE SHARE FLIGHT' },
  { pattern: /NO.{0,5}SEATING/i,        message: 'NO SEATING THIS FLIGHT' },
  { pattern: /NO.{0,5}SEATS?.?AVAILABLE/i, message: 'NO SEATS AVAILABLE' },
  { pattern: /SEAT.?MAP.?UNAVAILABLE/i, message: 'SEAT MAP UNAVAILABLE' },
  { pattern: /SEATING.?SUSPENDED/i,     message: 'SEATING SUSPENDED - AIRPORT CHECK-IN' },
  { pattern: /INVALID.{0,5}FLIGHT/i,    message: 'INVALID FLIGHT NUMBER' },
  { pattern: /INVALID.{0,5}CLASS/i,     message: 'INVALID CLASS CODE' },
  { pattern: /INVALID.{0,5}AIRLINE/i,   message: 'INVALID AIRLINE CODE' },
  { pattern: /INVALID.{0,5}DATE/i,      message: 'INVALID DATE' },
  { pattern: /INVALID.{0,5}(BOARD|OFF).?POINT/i, message: 'INVALID BOARD/OFF POINT' },
];

export function extractSeatMapError(response: unknown): SeatMapError | undefined {
  const r = response as any;
  const env = r?.CatalogOfferingsAncillaryListResponse ?? r;
  const errors = arrayish(env?.Result?.Error);
  if (errors.length === 0) return undefined;
  const first = errors[0] as any;
  const rawCode = String(first?.Code ?? first?.code ?? '').trim();
  const rawMessage = String(first?.Message ?? first?.message ?? '').trim();
  // Try numeric/code lookup first.
  const byCode = GWS_SEAT_MAP_ERRORS[rawCode];
  if (byCode) return { message: byCode, rawCode, rawMessage };
  // Fall back to message-substring matching.
  for (const { pattern, message } of SEAT_MAP_ERROR_FRAGMENTS) {
    if (pattern.test(rawMessage)) return { message, rawCode, rawMessage };
  }
  // Unknown — surface the raw message verbatim so the operator sees
  // something useful instead of an opaque code.
  return {
    message: rawMessage || `SEAT MAP ERROR (${rawCode || 'unknown'})`,
    rawCode,
    rawMessage,
  };
}

/** Convert a single Travelport `Cabin` block to our Cabin shape. */
function mapCabin(c: any): import('../models/seat-map.js').Cabin {
  const name = String(c?.name ?? '');
  const Layout: import('../models/seat-map.js').CabinLayoutEntry[] = [];
  // Layout is a mixed-shape array: row-range entries (startRow/endRow)
  // + column-position entries (position/value). Travelport's Y33
  // doesn't include explicit aisle markers; we infer aisleAfterColumn
  // from position-label pairs (consecutive 'A's around an inferred
  // aisle gap) for narrow-body; wide-body needs the structural data
  // in the layout block. v1: keep what's there, no inference.
  for (const e of arrayish(c?.Layout)) {
    const startRow = (e as any)?.startRow;
    const endRow = (e as any)?.endRow;
    const position = arrayish((e as any)?.position).map((p) => String(p));
    const value = (e as any)?.value;
    Layout.push({
      ...(typeof startRow === 'number' ? { startRow } : {}),
      ...(typeof endRow === 'number' ? { endRow } : {}),
      ...(position.length > 0 ? { position } : {}),
      ...(typeof value === 'string' ? { value } : {}),
    });
  }
  const Row: import('../models/seat-map.js').SeatRow[] = [];
  for (const r of arrayish(c?.Row)) {
    const label = String((r as any)?.label ?? '');
    const Space: import('../models/seat-map.js').SeatSpace[] = [];
    for (const s of arrayish((r as any)?.Space)) {
      const location = String((s as any)?.location ?? '');
      const Characteristic = arrayish((s as any)?.Characteristic).map((x) => String(x));
      Space.push({ location, ...(Characteristic.length > 0 ? { Characteristic } : {}) });
    }
    Row.push({ label, Space });
  }
  return { name, Layout, Row, aisleAfterColumn: inferAisleAfterColumn(Layout) };
}

/**
 * Infer `aisleAfterColumn` from a Travelport-shape `Layout[]` block.
 * Two-pass algorithm correctly handles narrow + wide bodies:
 *
 * **Pass 1 — "real" letter gaps**: a gap in the column-letter sequence
 * (e.g. B → D, skipping C) bordered by two position-`A` columns is
 * a definitive aisle marker. Wide-body layouts (2-4-2, 2-2-2, 3-3-3
 * intra-cabin) skip letters at aisle positions; Travelport uses this
 * convention consistently.
 *
 * **Pass 2 — fallback consecutive-A**: when no real letter gaps exist
 * (single-aisle narrow-body like 3-3, where ABCDEF has no skips),
 * the only signal is two adjacent A-positioned columns. Used ONLY
 * when Pass 1 found nothing — otherwise it triggers false positives
 * for 2-2-2 layouts (where the middle pair D-E is "both A" but
 * separated by seats, not an aisle).
 *
 * The chunk-0 design doc captures the test matrix:
 *   3-3      (ABCDEF, no skip)     → C-D from Pass 2 ✓
 *   2-4-2    (ABDEFGKL, skips C/HIJ) → B-D, G-K from Pass 1 ✓
 *   2-2-2    (ABDEGH, skips C/F)    → B-D, E-G from Pass 1 ✓
 *   3-3-3    (ABCDEFGHJ, skips I)   → C-D, F-G from Pass 2 ✓
 *                                       (H-J letter gap fails Pass 1
 *                                       because H/J aren't both A)
 */
function inferAisleAfterColumn(
  Layout: import('../models/seat-map.js').CabinLayoutEntry[],
): string[] {
  const columns = Layout.filter((e) => e.value);
  const result: string[] = [];
  // Pass 1: real letter gaps (sequence skip + both A-positioned).
  let foundRealGap = false;
  for (let i = 0; i < columns.length - 1; i++) {
    if (isLetterGap(columns[i].value!, columns[i + 1].value!) && bothPositionedA(columns[i], columns[i + 1])) {
      result.push(columns[i].value!);
      foundRealGap = true;
    }
  }
  if (foundRealGap) return result;
  // Pass 2: fall back to consecutive-A pairs.
  for (let i = 0; i < columns.length - 1; i++) {
    if (bothPositionedA(columns[i], columns[i + 1])) result.push(columns[i].value!);
  }
  return result;
}

function isLetterGap(a: string, b: string): boolean {
  if (a.length !== 1 || b.length !== 1) return false;
  return b.charCodeAt(0) > a.charCodeAt(0) + 1;
}

function bothPositionedA(
  a: import('../models/seat-map.js').CabinLayoutEntry,
  b: import('../models/seat-map.js').CabinLayoutEntry,
): boolean {
  return (a.position?.includes('A') ?? false) && (b.position?.includes('A') ?? false);
}
