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

import type { AvailabilityLine } from '../models/availability-result.js';

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
    const brandOptions = arrayish(offering?.ProductBrandOptions);
    for (const brandOpt of brandOptions) {
      const flights = arrayish(brandOpt?.Flight);
      if (flights.length === 0) continue;
      // Aggregate booking-class seat counts across every ProductBrandOffering
      // associated with this flight set. A single offering can list multiple
      // brands (Economy/Premium/Business) — each contributes its own class +
      // count. We sum them, capped at the GDS-style single-digit display.
      const classes = aggregateClasses(brandOpt);
      // A multi-flight brandOpt is a connection — group the legs so a future
      // `*` connection-sell entry can pull them as one.
      const group = flights.length > 1 ? ++connectionGroup : undefined;
      flights.forEach((flight, legIndex) => {
        const line = flightToLine(flight, ++lineIndex, classes, opts);
        if (line) {
          if (group !== undefined) {
            line.connectionGroup = group;
            line.legIndex = legIndex;
          }
          lines.push(line);
        }
      });
    }
  }
  return lines;
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
