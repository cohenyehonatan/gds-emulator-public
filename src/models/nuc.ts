/**
 * NUC (Neutral Unit of Construction) arithmetic — Amadeus v4 chunk 27.
 *
 * Rules sourced from Travelport's public "NUCs & Currency Rounding"
 * fares-and-pricing doc (support.travelport.com/webhelp/FaresAndPricing,
 * extracted verbatim 2026-06-09 — see
 * `docs/behavior-layer-research-2026-06-09.md`):
 *
 *   - "NUC are not rounded off; NUC is express in two decimal places
 *     ignoring any further decimal."  → TRUNCATE to 2 decimals.
 *   - Local-currency rounding is per-currency, one of two methods:
 *       HX (full adjustment): "rounding up to the next higher unit"
 *           — doc example: 1234.30 EUR → 1235.00
 *       NX (half adjustment): "round off to the nearest unit"
 *           — doc example: 120.80 USD → 121.00
 *   - Default rule: "ALWAYS ROUND UP the local currency fare unless
 *     there is an accompanying note that tells you to round off to
 *     the nearest unit."
 *
 * The IROE (IATA Rate of Exchange) converts NUC ↔ local currency:
 *   local = NUC × IROE(currency);  NUC = local ÷ IROE(currency)
 * The real IROE table is licensed (IATA, updated monthly on a 5-day
 * banking average ending the 15th). The table below is SYNTHETIC —
 * stable plausible values for the emulator's seed currencies, flagged
 * as such. The one verbatim-real entry is USD = 1.0: NUC is pegged
 * to the US dollar by construction (publicly documented).
 */

/** Per-currency rounding spec. */
export interface CurrencyRounding {
  /** HX = round up to next unit; NX = round to nearest unit. */
  method: 'HX' | 'NX';
  /** Rounding unit (1.00 for all our seed currencies). */
  unit: number;
}

/**
 * Synthetic IROE + rounding table for the emulator's seed currencies.
 * IROE = units of local currency per 1 NUC.
 *
 * Rounding methods for EUR (HX) and USD (NX) are verbatim the worked
 * examples in the Travelport doc; GBP/CHF default to HX per the
 * "always round up unless noted" rule. IROE values other than USD
 * are synthetic.
 */
export const IROE: Record<string, { rate: number; rounding: CurrencyRounding }> = {
  USD: { rate: 1.0,  rounding: { method: 'NX', unit: 1.0 } }, // NUC is USD-pegged
  EUR: { rate: 0.92, rounding: { method: 'HX', unit: 1.0 } },
  GBP: { rate: 0.79, rounding: { method: 'HX', unit: 1.0 } },
  CHF: { rate: 0.89, rounding: { method: 'HX', unit: 1.0 } },
};

/** Truncate to 2 decimals — NUC never rounds (Travelport doc, verbatim rule). */
export function truncateNuc(amount: number): number {
  return Math.trunc(amount * 100) / 100;
}

/**
 * Round a local-currency amount per that currency's rounding spec.
 * Unknown currencies default to HX/1.00 per the "always round up"
 * default rule.
 */
export function roundLocal(amount: number, currency: string): number {
  const spec = IROE[currency]?.rounding ?? { method: 'HX' as const, unit: 1.0 };
  const units = amount / spec.unit;
  // Guard float dust (e.g. 245.00000000003 must not round up to 246).
  const eps = 1e-9;
  if (spec.method === 'HX') return Math.ceil(units - eps) * spec.unit;
  return Math.round(units) * spec.unit;
}

/** Convert a local-currency amount to NUC (truncated per the NUC rule). */
export function localToNuc(amount: number, currency: string): number {
  const rate = IROE[currency]?.rate ?? 1.0;
  return truncateNuc(amount / rate);
}

/**
 * Convert a NUC total to local currency at the IROE of the country of
 * commencement, rounded per that currency's rule. This is the final
 * step of fare construction ("the total sum will be converted into
 * local currency at the NUC conversion factor of the country of
 * commencement of travel").
 */
export function nucToLocal(nuc: number, currency: string): number {
  const rate = IROE[currency]?.rate ?? 1.0;
  return roundLocal(nuc * rate, currency);
}

/**
 * Currency of the country of commencement, by origin airport. Drives
 * which IROE the final conversion uses. Covers the airports in our
 * seed; unknown airports default to USD.
 */
const AIRPORT_CURRENCY: Record<string, string> = {
  // United States
  JFK: 'USD', LAX: 'USD', ORD: 'USD', SFO: 'USD', DEN: 'USD',
  DFW: 'USD', MIA: 'USD', ATL: 'USD', BOS: 'USD', SEA: 'USD',
  // United Kingdom
  LHR: 'GBP', LGW: 'GBP', LCY: 'GBP', MAN: 'GBP',
  // Eurozone
  CDG: 'EUR', FRA: 'EUR', AMS: 'EUR', MAD: 'EUR', FCO: 'EUR', DUB: 'EUR',
  // Switzerland
  ZRH: 'CHF', GVA: 'CHF',
};

export function currencyOfCommencement(originAirport: string): string {
  return AIRPORT_CURRENCY[originAirport] ?? 'USD';
}

/** ROE display string for the fare-calc trailer (`ROE1.00` line
 *  format) — 2 decimals for whole-cent rates, 6 otherwise. */
export function formatRoe(currency: string): string {
  const rate = IROE[currency]?.rate ?? 1.0;
  return rate === Math.trunc(rate * 100) / 100
    ? rate.toFixed(2)
    : rate.toFixed(6);
}
