/**
 * NUC arithmetic — Amadeus v4 chunk 27.
 *
 * Rules per Travelport's public "NUCs & Currency Rounding" doc
 * (extracted verbatim 2026-06-09; see
 * docs/behavior-layer-research-2026-06-09.md):
 *
 *   - NUC truncates to 2 decimals, never rounds
 *   - Local currency: HX (round up to next unit) / NX (nearest unit)
 *   - Default: always round up unless noted
 *
 * The two worked examples in the doc are tested verbatim:
 *   1234.30 EUR (HX) → 1235.00
 *   120.80 USD (NX)  → 121.00
 *
 * IROE values are synthetic except USD=1.0 (NUC is USD-pegged by
 * construction — publicly documented).
 */

import { describe, it, expect } from 'vitest';
import {
  truncateNuc,
  roundLocal,
  localToNuc,
  nucToLocal,
  currencyOfCommencement,
  formatRoe,
  IROE,
} from '../../src/models/nuc.js';
import { GdsHost } from '../../src/session/gds-host.js';

describe('truncateNuc — NUC never rounds (verbatim Travelport rule)', () => {
  it('truncates 870.129 to 870.12 (does NOT round to 870.13)', () => {
    expect(truncateNuc(870.129)).toBe(870.12);
  });

  it('truncates 870.999 to 870.99 (does NOT round to 871)', () => {
    expect(truncateNuc(870.999)).toBe(870.99);
  });

  it('leaves exact 2-decimal amounts unchanged', () => {
    expect(truncateNuc(245.0)).toBe(245.0);
    expect(truncateNuc(123.45)).toBe(123.45);
  });
});

describe('roundLocal — the two verbatim Travelport worked examples', () => {
  it('1234.30 EUR (HX full adjustment) → 1235.00', () => {
    expect(roundLocal(1234.3, 'EUR')).toBe(1235);
  });

  it('120.80 USD (NX half adjustment) → 121.00', () => {
    expect(roundLocal(120.8, 'USD')).toBe(121);
  });

  it('USD NX rounds 120.40 DOWN to 120 (nearest, not up)', () => {
    expect(roundLocal(120.4, 'USD')).toBe(120);
  });

  it('EUR HX rounds 1234.01 UP to 1235 (any fraction rounds up)', () => {
    expect(roundLocal(1234.01, 'EUR')).toBe(1235);
  });

  it('whole amounts do not round up under HX (float-dust guard)', () => {
    expect(roundLocal(245.0, 'EUR')).toBe(245);
    expect(roundLocal(245.00000000003, 'EUR')).toBe(245);
  });

  it('unknown currency defaults to HX per the "always round up" rule', () => {
    expect(roundLocal(100.1, 'XXX')).toBe(101);
  });
});

describe('IROE conversions', () => {
  it('USD IROE is exactly 1.0 (NUC is USD-pegged)', () => {
    expect(IROE.USD.rate).toBe(1.0);
  });

  it('localToNuc truncates the result', () => {
    expect(localToNuc(92, 'EUR')).toBe(100); // 92 / 0.92 = 100
    expect(localToNuc(100, 'GBP')).toBe(126.58); // 100/0.79 = 126.582... → truncate
  });

  it('nucToLocal converts then rounds per the currency rule', () => {
    expect(nucToLocal(100, 'EUR')).toBe(92);
    expect(nucToLocal(100.5, 'GBP')).toBe(80); // 79.395 → HX → 80
    expect(nucToLocal(120.8, 'USD')).toBe(121); // ×1.0 → NX nearest
  });
});

describe('currencyOfCommencement', () => {
  it('maps seed airports to their currencies', () => {
    expect(currencyOfCommencement('JFK')).toBe('USD');
    expect(currencyOfCommencement('LHR')).toBe('GBP');
    expect(currencyOfCommencement('FRA')).toBe('EUR');
    expect(currencyOfCommencement('ZRH')).toBe('CHF');
  });

  it('unknown airports default to USD', () => {
    expect(currencyOfCommencement('XYZ')).toBe('USD');
  });
});

describe('formatRoe', () => {
  it('whole-cent rates print 2 decimals', () => {
    expect(formatRoe('USD')).toBe('1.00');
    expect(formatRoe('EUR')).toBe('0.92');
  });
});

describe('Fare-calc line — NUC format for international itineraries', () => {
  it('domestic itinerary keeps the legacy local-currency format', async () => {
    const host = new GdsHost({ port: 0, logLevel: 'error' });
    const wa = host.newWorkArea();
    await host.process('SI', wa);
    await host.process('115JULJFKLAX', wa);
    await host.process('01Y1', wa);
    await host.process('-1SMITH/JOHN', wa);
    await host.process('WP', wa);
    const df = await host.process('WPDF', wa);
    expect(df).toContain('JFK B6 LAX245.00Y14 245.00 END');
    expect(df).not.toContain('NUC');
    expect(df).not.toContain('ROE');
  });

  it('international itinerary (DFW-LHR) emits NUC amounts + ROE trailer', async () => {
    const host = new GdsHost({ port: 0, logLevel: 'error' });
    const wa = host.newWorkArea();
    await host.process('SI', wa);
    await host.process('115JULDFWLHR', wa);
    await host.process('01Y1', wa);
    await host.process('-1SMITH/JOHN', wa);
    await host.process('WP', wa);
    const df = await host.process('WPDF', wa);
    // US commencement → USD → ROE 1.00; NUC amounts == USD amounts.
    expect(df).toContain('DFW BA LHR870.00Y14 NUC870.00 END ROE1.00');
  });
});
