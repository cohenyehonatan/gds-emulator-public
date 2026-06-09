/**
 * Minimum Connect Time model — Amadeus v4 chunk 26.
 *
 * Shape follows OAG's documented MCT data model (the "MCTs Explained"
 * guide + Carrier FAQs, extracted 2026-06-09 — see
 * `docs/behavior-layer-research-2026-06-09.md`). OAG documents a
 * 4-layer override hierarchy:
 *
 *   1. IATA-approved airport standard (default for all carriers)
 *   2. Airport-specific industrial standard (overrides #1)
 *   3. Airline-specific exceptions (filed by individual carriers)
 *   4. Exceptions to exceptions (carrier-pair re-overrides)
 *
 * OAG's worked example (verbatim from the guide):
 *   "The Domestic to International (DI) status standard at MIA is
 *    1 hour >> AA has an exception: AA to ALL carriers at MIA 55
 *    minutes >> AA advises that BA is an exception to this"
 *   AA – to All  D-to-I exception at MIA  55 minutes
 *   AA – to BA   D-to-I status standard at MIA  9999
 * ("9999" = use the default standard, i.e. the exception is voided
 * for that carrier pair.)
 *
 * Our model collapses layers 1+2 into "airport default" (we don't
 * model the IATA-vs-industrial distinction) and represents layers
 * 3+4 as records with increasing specificity. Resolution picks the
 * MOST SPECIFIC matching record:
 *
 *   carrier+toCarrier match  >  carrier match  >  airport default
 *
 * A record with `minutes: USE_STANDARD` (9999, per the OAG
 * convention) voids more-general exceptions and falls back to the
 * airport default — this is how "exceptions to exceptions" work.
 *
 * The seed data is FICTIONAL (OAG's real 157k records are licensed);
 * the model shape and resolution semantics follow the documented
 * pattern. Flag any output as emulator-seeded, not OAG live data.
 */

/** Connection type: Domestic/International × arrival/departure leg. */
export type MctConnectionType = 'DD' | 'DI' | 'ID' | 'II';

/**
 * Sentinel minutes value meaning "use the airport standard" — voids
 * more-general carrier exceptions for this carrier pair. Verbatim
 * the 9999 convention from the OAG guide.
 */
export const USE_STANDARD = 9999;

export interface MctRecord {
  /** IATA airport code. */
  airport: string;
  /** Connection type this record applies to. */
  connectionType: MctConnectionType;
  /**
   * Arriving carrier. Undefined = airport default (applies to all
   * carriers when no more specific record matches).
   */
  carrier?: string;
  /**
   * Departing carrier for carrier-pair records ("exceptions to
   * exceptions"). Only meaningful when `carrier` is also set.
   * Undefined = the carrier exception applies to ALL departing
   * carriers.
   */
  toCarrier?: string;
  /** MCT in minutes, or USE_STANDARD (9999) to void an exception. */
  minutes: number;
}

/**
 * Resolve the MCT for a connection at an airport. Most-specific
 * record wins:
 *   1. (airport, type, carrier, toCarrier) exact pair
 *   2. (airport, type, carrier) carrier exception
 *   3. (airport, type) airport default
 *   4. global fallback (caller supplies; we use the historical 45)
 *
 * A USE_STANDARD result at tier 1 or 2 skips remaining specific
 * tiers and falls through to the airport default (tier 3) — this is
 * the documented "exception to exception" semantics.
 */
export function resolveMct(
  records: MctRecord[],
  airport: string,
  connectionType: MctConnectionType,
  carrier?: string,
  toCarrier?: string,
  fallback = 45,
): { minutes: number; source: 'pair' | 'carrier' | 'airport' | 'fallback' } {
  const here = records.filter(
    (r) => r.airport === airport && r.connectionType === connectionType,
  );
  const airportDefault = here.find((r) => !r.carrier);

  if (carrier && toCarrier) {
    const pair = here.find((r) => r.carrier === carrier && r.toCarrier === toCarrier);
    if (pair) {
      if (pair.minutes === USE_STANDARD) {
        return airportDefault
          ? { minutes: airportDefault.minutes, source: 'airport' }
          : { minutes: fallback, source: 'fallback' };
      }
      return { minutes: pair.minutes, source: 'pair' };
    }
  }
  if (carrier) {
    const exc = here.find((r) => r.carrier === carrier && !r.toCarrier);
    if (exc) {
      if (exc.minutes === USE_STANDARD) {
        return airportDefault
          ? { minutes: airportDefault.minutes, source: 'airport' }
          : { minutes: fallback, source: 'fallback' };
      }
      return { minutes: exc.minutes, source: 'carrier' };
    }
  }
  if (airportDefault) return { minutes: airportDefault.minutes, source: 'airport' };
  return { minutes: fallback, source: 'fallback' };
}
