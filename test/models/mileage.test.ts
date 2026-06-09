/**
 * Chunk 30 commit 1 — IATA mileage system (steps 4-7).
 *
 * EMS bracket table verbatim from references/fares/Colbourne-College-
 * Airfares-Ticketing-Unit33.pdf:
 *   ratio ≤1.05 → 5M ×1.05 ... ≤1.25 → 25M ×1.25, over → break fare.
 *
 * TPM seed approximates published great-circle miles; MPM is the
 * documented ≈1.20 × direct-TPM rule of thumb (real table licensed).
 */

import { describe, it, expect } from 'vitest';
import { tpmFor, mpmFor, emsFor, mileageCheck } from '../../src/models/mileage.js';

describe('tpmFor / mpmFor', () => {
  it('looks up sector TPMs in either direction', () => {
    expect(tpmFor('JFK', 'LAX')).toBe(2475);
    expect(tpmFor('LAX', 'JFK')).toBe(2475);
    expect(tpmFor('SFO', 'ORD')).toBe(1846);
  });

  it('MPM is 1.20 × the direct TPM, rounded', () => {
    expect(mpmFor('JFK', 'SFO')).toBe(Math.round(2586 * 1.2)); // 3103
    expect(mpmFor('DEN', 'FRA')).toBe(Math.round(5015 * 1.2)); // 6018
  });

  it('unseeded pairs return undefined', () => {
    expect(tpmFor('JFK', 'XYZ')).toBeUndefined();
    expect(mpmFor('JFK', 'XYZ')).toBeUndefined();
  });
});

describe('emsFor — the verbatim bracket table', () => {
  const mpm = 1000;
  it('at or under MPM → no surcharge', () => {
    expect(emsFor(1000, mpm)).toEqual({ multiplier: 1.0, tag: '' });
    expect(emsFor(900, mpm)).toEqual({ multiplier: 1.0, tag: '' });
  });

  it('each bracket boundary maps to its surcharge (inclusive upper bound)', () => {
    expect(emsFor(1050, mpm)).toEqual({ multiplier: 1.05, tag: '5M' });
    expect(emsFor(1051, mpm)).toEqual({ multiplier: 1.1, tag: '10M' });
    expect(emsFor(1100, mpm)).toEqual({ multiplier: 1.1, tag: '10M' });
    expect(emsFor(1150, mpm)).toEqual({ multiplier: 1.15, tag: '15M' });
    expect(emsFor(1200, mpm)).toEqual({ multiplier: 1.2, tag: '20M' });
    expect(emsFor(1250, mpm)).toEqual({ multiplier: 1.25, tag: '25M' });
  });

  it('over 1.25 → null (break the fare)', () => {
    expect(emsFor(1251, mpm)).toBeNull();
  });

  it('ratio truncates at 5 decimals per the source ("up to 5 decimals")', () => {
    // 1050.009/1000 = 1.050009 → truncated 1.05000 → still 5M bracket.
    expect(emsFor(1050.009, mpm)).toEqual({ multiplier: 1.05, tag: '5M' });
  });
});

describe('mileageCheck — full routing check', () => {
  it('JFK→ORD→SFO: TPM sum 2586 vs MPM 3103 → no surcharge', () => {
    const r = mileageCheck([
      { origin: 'JFK', destination: 'ORD' },
      { origin: 'ORD', destination: 'SFO' },
    ]);
    expect(r).toEqual({
      applies: true, broken: false,
      tpmSum: 740 + 1846, mpm: 3103,
      multiplier: 1.0, tag: '',
    });
  });

  it('DEN→KEF→FRA: 5196 vs MPM 6018 → no surcharge (within MPM)', () => {
    const r = mileageCheck([
      { origin: 'DEN', destination: 'KEF' },
      { origin: 'KEF', destination: 'FRA' },
    ]);
    expect(r).toMatchObject({ applies: true, broken: false, multiplier: 1.0 });
  });

  it('JFK→MIA→LHR: 5515 vs JFK-LHR MPM 4141 → ratio 1.33 → broken', () => {
    const r = mileageCheck([
      { origin: 'JFK', destination: 'MIA' },
      { origin: 'MIA', destination: 'LHR' },
    ]);
    expect(r).toMatchObject({ applies: true, broken: true, tpmSum: 1090 + 4425 });
  });

  it('unseeded sector → applies: false (caller falls back to leg-sum)', () => {
    const r = mileageCheck([
      { origin: 'JFK', destination: 'XYZ' },
      { origin: 'XYZ', destination: 'SFO' },
    ]);
    expect(r).toEqual({ applies: false });
  });
});
