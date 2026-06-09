/**
 * Through-fare construction — chunk 30, steps 8-9 of the documented
 * one-way fare construction sequence (HIP + BHC), composing with the
 * mileage module (steps 4-7).
 *
 * Sources (see docs/behavior-layer-research-2026-06-09.md):
 * - `references/fares/Colbourne-College-Airfares-Ticketing-Unit33.pdf`
 *   — step 8 HIP comparison sets + step 9 BHC formula, verbatim:
 *     8. HIP — look for the Higher Intermediate Point fare from:
 *        (1) unit origin to intermediate stopover point
 *        (2) intermediate stopover point to another
 *        (3) intermediate stopover point to the unit destination
 *     9. BHC — when fare(origin→intermediate stopover) > fare(origin→
 *        destination): OWM = HI + (HI − LO)
 * - Travelport CAT17 webhelp — production semantics:
 *     "THE HIGHER INTERMEDIATE POINT RULE DOES NOT APPLY FOR
 *      CONNECTIONS" → only STOPOVER points are HIP candidates;
 *     "When comparing the HIP candidates to the through fare, any
 *      Stopover Charges, Q surcharges or Mileage Increases must be
 *      excluded" → comparisons happen in base-fare space;
 *     "Once the HIP has been determined, any applicable mileage
 *      increases applicable to the through fare will be applied to
 *      the HIP fare" → the EMS multiplier applies to the result.
 */

import { mileageCheck } from './mileage.js';

/** One ticketed sector of the fare component, with its stopover flag.
 *  `stopoverAfter` marks the point AFTER this leg (the leg's
 *  destination) as a stopover (>24h) vs a connection. The final
 *  leg's flag is ignored — the component destination is a fare
 *  break, not an intermediate point. */
export interface ComponentLeg {
  origin: string;
  destination: string;
  stopoverAfter?: boolean;
}

/** Base-fare lookup the construction runs against — tariff-agnostic
 *  so the module is unit-testable without the seed tariff. */
export type FareLookup = (origin: string, destination: string) => number;

export interface ThroughFareConstruction {
  /** Final component base fare (all checks + EMS applied). */
  base: number;
  /** The plain origin→destination through fare before any checks. */
  throughFare: number;
  /** EMS multiplier applied (1.0 when within MPM). */
  emsMultiplier: number;
  /** `5M`-style EMS tag for the fare-calc line ('' when none). */
  emsTag: string;
  /** Set when a HIP raised the fare: the governing city pair + fare. */
  hip?: { from: string; to: string; fare: number };
  /** Set when the backhaul minimum governed: HI, LO, OWM = HI+(HI−LO). */
  bhc?: { hi: number; lo: number; owm: number };
}

/**
 * Construct the through fare for one fare component (steps 4-9).
 *
 * Returns null when the construction can't apply:
 * - the mileage check is unseeded for any sector (no TPM/MPM data)
 * - the routing exceeds 25M ("use highest combination" — the fare
 *   must be broken; our caller falls back to leg-sum pricing, which
 *   IS the broken-fare combination for our per-leg tariff)
 *
 * All comparisons happen in base-fare space per CAT17 (mileage
 * increases excluded), then the EMS multiplier applies to the
 * governing fare.
 */
export function constructThroughFare(
  legs: ComponentLeg[],
  fareLookup: FareLookup,
): ThroughFareConstruction | null {
  if (legs.length === 0) return null;
  const origin = legs[0].origin;
  const destination = legs[legs.length - 1].destination;

  // Steps 4-7: mileage check.
  const mileage = mileageCheck(legs);
  if (!mileage.applies || mileage.broken) return null;

  // Step 2 equivalent: the plain through fare.
  const throughFare = fareLookup(origin, destination);

  // Intermediate stopover points only (CAT17: connections exempt).
  const stopovers: string[] = [];
  for (let i = 0; i < legs.length - 1; i++) {
    if (legs[i].stopoverAfter) stopovers.push(legs[i].destination);
  }

  // Step 8: HIP — three comparison sets, all in base-fare space.
  let hip: ThroughFareConstruction['hip'];
  let governing = throughFare;
  const consider = (from: string, to: string) => {
    const fare = fareLookup(from, to);
    if (fare > governing) {
      governing = fare;
      hip = { from, to, fare };
    }
  };
  for (const s of stopovers) consider(origin, s);                 // (1)
  for (let i = 0; i < stopovers.length; i++) {
    for (let j = i + 1; j < stopovers.length; j++) {
      consider(stopovers[i], stopovers[j]);                       // (2)
    }
  }
  for (const s of stopovers) consider(s, destination);            // (3)

  // Step 9: BHC — the backhaul minimum when an origin→stopover fare
  // exceeds the origin→destination fare. OWM = HI + (HI − LO).
  let bhc: ThroughFareConstruction['bhc'];
  for (const s of stopovers) {
    const hi = fareLookup(origin, s);
    if (hi > throughFare) {
      const owm = hi + (hi - throughFare);
      if (!bhc || owm > bhc.owm) bhc = { hi, lo: throughFare, owm };
    }
  }
  if (bhc && bhc.owm > governing) governing = bhc.owm;
  else bhc = bhc && bhc.owm <= governing ? undefined : bhc;

  // EMS applies to the governing fare (CAT17: mileage increases
  // applied after HIP determination).
  const base = Math.round(governing * mileage.multiplier * 100) / 100;

  return {
    base,
    throughFare,
    emsMultiplier: mileage.multiplier,
    emsTag: mileage.tag,
    hip,
    bhc,
  };
}
