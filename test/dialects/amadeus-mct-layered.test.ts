/**
 * Amadeus v4 chunk 26 — layered MCT model (DM / DMI upgrade).
 *
 * Model shape per OAG's documented MCT hierarchy ("MCTs Explained"
 * guide, extracted 2026-06-09 — see
 * docs/behavior-layer-research-2026-06-09.md):
 *
 *   1. Airport standard (default for all carriers)
 *   2. Carrier exceptions (carrier to ALL)
 *   3. Carrier-pair re-overrides ("exceptions to exceptions")
 *
 * The seed includes OAG's worked MIA example verbatim:
 *   - DI status standard at MIA: 60 min
 *   - AA to ALL at MIA: 55 min
 *   - AA to BA at MIA: 9999 (= revert to standard)
 *
 * Real OAG data is licensed; the seed is fictional but the
 * resolution semantics follow the documented pattern.
 */

import { describe, it, expect } from 'vitest';
import { Inventory } from '../../src/store/inventory.js';
import { resolveMct, USE_STANDARD } from '../../src/models/mct.js';
import type { MctRecord } from '../../src/models/mct.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

describe('resolveMct — the OAG worked MIA example', () => {
  it('MIA DI with no carrier → airport standard (60)', () => {
    const inv = new Inventory();
    expect(inv.mctFor('MIA', 'DI')).toEqual({ minutes: 60, source: 'airport' });
  });

  it('MIA DI AA→DL → AA-to-ALL carrier exception (55)', () => {
    const inv = new Inventory();
    expect(inv.mctFor('MIA', 'DI', 'AA', 'DL')).toEqual({ minutes: 55, source: 'carrier' });
  });

  it('MIA DI AA→BA → 9999 pair record voids the exception, reverts to standard (60)', () => {
    const inv = new Inventory();
    expect(inv.mctFor('MIA', 'DI', 'AA', 'BA')).toEqual({ minutes: 60, source: 'airport' });
  });

  it('MIA DI DL (no exception filed) → airport standard (60)', () => {
    const inv = new Inventory();
    expect(inv.mctFor('MIA', 'DI', 'DL')).toEqual({ minutes: 60, source: 'airport' });
  });
});

describe('resolveMct — specificity ordering', () => {
  it('carrier-pair beats carrier exception beats airport default', () => {
    const inv = new Inventory();
    // LHR II: standard 90, BA-to-ALL 60, BA→AA pair 75
    expect(inv.mctFor('LHR', 'II').minutes).toBe(90);
    expect(inv.mctFor('LHR', 'II', 'BA', 'LH').minutes).toBe(60); // carrier tier
    expect(inv.mctFor('LHR', 'II', 'BA', 'AA').minutes).toBe(75); // pair tier
  });

  it('unseeded airport falls back to the global 45-minute default', () => {
    const inv = new Inventory();
    expect(inv.mctFor('XYZ', 'DD')).toEqual({ minutes: 45, source: 'fallback' });
  });

  it('USE_STANDARD at the carrier tier (not just pair tier) also reverts', () => {
    const records: MctRecord[] = [
      { airport: 'AAA', connectionType: 'DD', minutes: 50 },
      { airport: 'AAA', connectionType: 'DD', carrier: 'XX', minutes: USE_STANDARD },
    ];
    expect(resolveMct(records, 'AAA', 'DD', 'XX')).toEqual({ minutes: 50, source: 'airport' });
  });

  it('USE_STANDARD with no airport default falls through to the fallback', () => {
    const records: MctRecord[] = [
      { airport: 'BBB', connectionType: 'DD', carrier: 'XX', minutes: USE_STANDARD },
    ];
    expect(resolveMct(records, 'BBB', 'DD', 'XX', undefined, 45)).toEqual({ minutes: 45, source: 'fallback' });
  });

  it('connection types resolve independently', () => {
    const inv = new Inventory();
    expect(inv.mctFor('MIA', 'DD').minutes).toBe(40);
    expect(inv.mctFor('MIA', 'DI').minutes).toBe(60);
    expect(inv.mctFor('MIA', 'II').minutes).toBe(90);
    expect(inv.mctFor('MIA', 'ID').minutes).toBe(75);
  });
});

describe('DM display — layered output for seeded airports', () => {
  function makeHost() {
    return new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
  }

  it('DMMIA lists standards + carrier exceptions + pair re-overrides', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('DMMIA', wa);
    expect(resp).toContain('DI  STANDARD            60 MIN');
    expect(resp).toContain('AA TO ALL           55 MIN');
    expect(resp).toContain('AA TO BA            STANDARD APPLIES');
  });

  it('DMXYZ (unseeded) keeps the legacy 45-minute single-line wording', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('DMXYZ', wa);
    expect(resp).toBe('DM XYZ\n  MCT 45 MIN');
  });

  it('DM<airport>/<date> keeps the date in the header', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('DMMIA/15DEC', wa);
    expect(resp).toContain('DM MIA 15DEC');
  });
});

describe('DMI — continuity check resolves through the layered model', () => {
  it('connection at a seeded hub shows the resolved MCT + source tag', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    // Build a 2-segment connection JFK→LAX then LAX→JFK (LAX is seeded:
    // DD standard 35).
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('AN20JULLAXJFK', wa);
    await host.process('SS1Y1', wa);
    const resp = await host.process('DMI', wa);
    // Chunk 28: DMI now shows the inferred connection type (both
    // legs US-domestic → DD).
    expect(resp).toContain('1-2: LAX DD OK / MCT 35M (AIRPORT)');
  });

  it('connection at an unseeded airport shows the 45-minute fallback without a source tag', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    // DEN→KEF then KEF→FRA (KEF unseeded → fallback 45).
    await host.process('AN27JUNDENKEF', wa);
    await host.process('SS1Y1', wa);
    await host.process('AN28JUNKEFFRA', wa);
    await host.process('SS1Y1', wa);
    const resp = await host.process('DMI', wa);
    // DEN→KEF (US→IS) and KEF→FRA (IS→DE) are both international → II.
    expect(resp).toContain('KEF II OK / MCT 45M');
    expect(resp).not.toContain('45M (');
  });
});
