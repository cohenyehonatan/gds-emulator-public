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
  const lines: AvailabilityLine[] = [];
  let lineIndex = 0;
  let connectionGroup = 0;
  for (const offering of offerings) {
    const offerId = extractIdentifier(offering);
    const brandOptions = arrayish(offering?.ProductBrandOptions);
    for (const brandOpt of brandOptions) {
      const flights = arrayish(brandOpt?.Flight);
      if (flights.length === 0) continue;
      const classes = aggregateClasses(brandOpt);
      // Capture vendor IDs from the offering itself + this brand-option's
      // first ProductBrandOffering (which carries the brandable, priceable
      // identity a future FQ live entry will need).
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
 * Pull the Travelport-side identifiers off an offering + brand option.
 * Returns undefined when nothing useful was found — better an absent
 * vendorRef than one with empty strings that a downstream live-sell
 * handler would post in an invalid payload.
 */
function buildVendorRef(offerId: string | undefined, brandOpt: any): VendorRef | undefined {
  const productId = extractIdentifier(brandOpt);
  const firstBrand = arrayish(brandOpt?.ProductBrandOffering)[0];
  const brandId = extractIdentifier(firstBrand);
  if (!offerId && !productId && !brandId) return undefined;
  return { offerId, productId, brandId };
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
function aggregateClasses(brandOpt: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const brandOffering of arrayish(brandOpt?.ProductBrandOffering)) {
    for (const fareDetail of arrayish(brandOffering?.FareDetail)) {
      const bc = fareDetail?.BookingCode;
      const codes = arrayish(bc);
      // BookingCode can be a single object or an array; arrayish handles
      // either.
      if (codes.length === 0 && bc?.code) codes.push(bc);
      for (const cell of codes) {
        const code = cell?.code ?? cell?.Code;
        const count = Number(cell?.count ?? cell?.Count ?? 0);
        if (typeof code === 'string' && code.length === 1 && Number.isFinite(count)) {
          out[code] = Math.min(9, Math.max(out[code] ?? 0, count));
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
  const root = r?.Reservation ?? r?.OrderReservationResponse?.Reservation ?? r;
  if (root == null) return pnr;

  pnr.names = mapReservationTravelers(root);
  pnr.segments = mapReservationSegments(root);
  pnr.phones = mapReservationPhones(root);
  return pnr;
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
 * Segments. The reservation response groups flights either under
 * `AirReservation.Flights` (older shape) or as flat `BookingSegment`
 * entries (newer shape with explicit booking class / status).
 */
function mapReservationSegments(root: any): AirSegment[] {
  // Try the documented `AirReservation.Flights[]` shape first; fall back
  // to the flat `BookingSegment[]` newer access groups return. `??`
  // would NOT trigger on an empty array, so we explicitly check length.
  let flights = arrayish(root?.AirReservation?.Flights ?? root?.AirReservation?.Flight);
  if (flights.length === 0) {
    flights = arrayish(root?.BookingSegment ?? root?.Segments ?? root?.segments);
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
  const travelers = arrayish(root?.Traveler ?? root?.Travelers ?? root?.travelers);
  for (const t of travelers) {
    for (const tel of arrayish(t?.Telephone ?? t?.telephone)) {
      const num = tel?.phoneNumber ?? tel?.PhoneNumber ?? tel?.number;
      if (typeof num === 'string' && num.length > 0) out.push({ number: num });
    }
  }
  for (const pc of arrayish(root?.PrimaryContact ?? root?.primaryContact)) {
    for (const tel of arrayish(pc?.Telephone ?? pc?.telephone)) {
      const num = tel?.phoneNumber ?? tel?.PhoneNumber ?? tel?.number;
      if (typeof num === 'string' && num.length > 0) out.push({ number: num });
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
