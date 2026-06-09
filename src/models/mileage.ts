/**
 * IATA mileage system — chunk 30, steps 4-7 of the documented one-way
 * fare construction sequence.
 *
 * Source: `references/fares/Colbourne-College-Airfares-Ticketing-
 * Unit33.pdf` (IATA-derived training material, verbatim-third-party
 * bar) — see `docs/behavior-layer-research-2026-06-09.md` for the
 * dig. The construction steps:
 *
 *   4. MPM — establish the Maximum Permitted Mileage between the
 *      fare construction points
 *   5. TPM — add up the Ticketed Point Mileage of each sector and
 *      compare the total to the MPM
 *   6. EMA — deduct the Extra Mileage Allowance, if any (we carry
 *      no EMA data — the PAT's EMA table is not public; documented
 *      skip, same as Specified Routings in step 3)
 *   7. EMS — if over, divide TPM by MPM (5 decimals) and surcharge
 *      per the bracket table (verbatim from the source):
 *
 *        over     | up to    | surcharge
 *        1.00000  | 1.05000  | 5%  (5M,  ×1.05)
 *        1.05000  | 1.10000  | 10% (10M, ×1.10)
 *        1.10000  | 1.15000  | 15% (15M, ×1.15)
 *        1.15000  | 1.20000  | 20% (20M, ×1.20)
 *        1.20000  | 1.25000  | 25% (25M, ×1.25)
 *                 | >1.25000 | use highest combination (break the fare)
 *
 * TPM seed values approximate published great-circle sector miles.
 * MPM follows the published convention of ≈1.20 × the direct-route
 * TPM (the real PAT MPM table is licensed; the 1.2 factor is the
 * widely-documented rule of thumb) — flagged synthetic.
 */

/** Sector TPMs (miles). Symmetric — lookup tries both directions. */
const TPM: Record<string, number> = {
  JFKLAX: 2475,
  JFKORD: 740,
  ORDSFO: 1846,
  JFKDEN: 1626,
  DENSFO: 967,
  JFKSFO: 2586,
  DFWLHR: 4736,
  DENKEF: 3702,
  KEFFRA: 1494,
  DENFRA: 5015,
  JFKMIA: 1090,
  MIALHR: 4425,
  JFKLHR: 3451,
};

/** Sector TPM, direction-agnostic. Undefined when unseeded. */
export function tpmFor(origin: string, destination: string): number | undefined {
  return TPM[origin + destination] ?? TPM[destination + origin];
}

/**
 * MPM between fare construction points: 1.20 × the direct TPM,
 * rounded to the nearest mile (the published rule-of-thumb; the
 * real per-pair MPM table is licensed). Undefined when the direct
 * TPM isn't seeded.
 */
export function mpmFor(origin: string, destination: string): number | undefined {
  const direct = tpmFor(origin, destination);
  return direct == null ? undefined : Math.round(direct * 1.2);
}

/**
 * EMS bracket lookup. Ratio = sum-of-TPMs ÷ MPM, taken to 5 decimals
 * per the source ("Take the result up to 5 decimals"). Returns the
 * fare multiplier with its `5M`-style tag, or null when the ratio
 * exceeds 1.25 (the fare must be broken — "use highest combination").
 */
export function emsFor(tpmSum: number, mpm: number): { multiplier: number; tag: string } | null {
  const ratio = Math.trunc((tpmSum / mpm) * 100000) / 100000;
  if (ratio <= 1.0) return { multiplier: 1.0, tag: '' };
  if (ratio <= 1.05) return { multiplier: 1.05, tag: '5M' };
  if (ratio <= 1.1) return { multiplier: 1.1, tag: '10M' };
  if (ratio <= 1.15) return { multiplier: 1.15, tag: '15M' };
  if (ratio <= 1.2) return { multiplier: 1.2, tag: '20M' };
  if (ratio <= 1.25) return { multiplier: 1.25, tag: '25M' };
  return null;
}

/**
 * Mileage check for a routing (steps 4-7). Legs are the ticketed
 * sectors of one fare component, in order. Returns:
 *  - applies: false when any sector TPM or the MPM is unseeded —
 *    callers fall back to leg-sum pricing (documented, honest gap)
 *  - broken: true when TPM/MPM > 1.25 — the fare must be broken
 *  - otherwise the EMS multiplier + tag + the numbers used
 */
export function mileageCheck(
  legs: { origin: string; destination: string }[],
): | { applies: false }
  | { applies: true; broken: true; tpmSum: number; mpm: number }
  | { applies: true; broken: false; tpmSum: number; mpm: number; multiplier: number; tag: string } {
  if (legs.length === 0) return { applies: false };
  const origin = legs[0].origin;
  const destination = legs[legs.length - 1].destination;
  const mpm = mpmFor(origin, destination);
  if (mpm == null) return { applies: false };
  let tpmSum = 0;
  for (const l of legs) {
    const tpm = tpmFor(l.origin, l.destination);
    if (tpm == null) return { applies: false };
    tpmSum += tpm;
  }
  const ems = emsFor(tpmSum, mpm);
  if (ems == null) return { applies: true, broken: true, tpmSum, mpm };
  return { applies: true, broken: false, tpmSum, mpm, ...ems };
}
