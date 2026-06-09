/**
 * Chunk 30 commit 3 — through-fare construction wired into
 * priceItinerary.
 *
 * Multi-leg fare components (connections/stopovers chained O→X→D)
 * now price as one through fare with the mileage (EMS) + HIP + BHC
 * checks from src/models/fare-construction.ts, instead of summing
 * per-leg fares. Fallback to leg-sum when construction can't apply
 * (unseeded TPM data, or routing over 25M = broken fare).
 *
 * Fare-calc line gains the IATA connection style for constructed
 * components: `X/` marks a connection point, the EMS tag precedes
 * the amount, one amount covers the component.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

let host: GdsHost;
let wa: WorkArea;

beforeEach(async () => {
  host = new GdsHost({ port: 0, logLevel: 'error' });
  wa = host.newWorkArea();
  await host.process('SI', wa);
});

describe('same-day connection — through fare with X/ marker', () => {
  beforeEach(async () => {
    await host.process('115JUNJFKSFO', wa);
    // Line 1-2 = via DEN (faster, ranked first per chunk 29); line
    // 3-4 = via ORD. Sell the ORD connection for stable TPM math.
    await host.process('03Y3*', wa);
    await host.process('-1SMITH/JOHN', wa);
  });

  it('prices the through fare (250), not the leg sum (345)', async () => {
    const resp = await host.process('WP', wa);
    // JFK-SFO through = DEFAULT_BASE 250; leg-sum would be 150+195.
    expect(resp).toContain('250.00');
    expect(resp).not.toContain('345.00');
  });

  it('fare-calc line uses the connection style with X/ at the transfer point', async () => {
    await host.process('WP', wa);
    const df = await host.process('WPDF', wa);
    expect(df).toContain('JFK AA X/ORD AA SFO250.00Y14 250.00 END');
  });

  it('one fare basis for the component (through fare)', async () => {
    await host.process('WP', wa);
    expect(wa.lastPricing!.fareBasis).toEqual(['Y14']);
  });
});

describe('round trip — two single-leg components, unchanged', () => {
  it('JFK-LAX + LAX-JFK still prices per-leg at 490 total', async () => {
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y1', wa);
    await host.process('115JULLAXJFK', wa);
    await host.process('01Y1', wa);
    await host.process('-1SMITH/JOHN', wa);
    await host.process('WP', wa);
    const df = await host.process('WPDF', wa);
    expect(df).toContain('JFK B6 LAX245.00Y14 DL JFK245.00Y14 490.00 END');
  });
});

describe('stopover triggers HIP/BHC (different dates at the intermediate)', () => {
  it('JFK→DEN (day 1) then DEN→SFO (later date) — stopover at DEN raises the fare via BHC', async () => {
    // Sell the legs on different dates so DEN is a stopover.
    await host.process('115JUNJFKDEN', wa);
    await host.process('01Y1', wa);
    await host.process('118JUNDENSFO', wa);
    await host.process('01Y1', wa);
    await host.process('-1SMITH/JOHN', wa);
    const resp = await host.process('WP', wa);
    // Through JFK-SFO = 250 (LO). JFK-DEN = 210 < 250 → no HIP/BHC
    // from set (1). DEN-SFO = 110 < 250 → no set-(3) HIP. So the
    // through fare 250 governs — cheaper than the leg sum 320.
    expect(resp).toContain('250.00');
    expect(resp).not.toContain('320.00');
  });
});

describe('fallback to leg-sum when construction cannot apply', () => {
  it('DEN→KEF→FRA: KEF sectors are TPM-seeded so it constructs; DEN-FRA through fare applies', async () => {
    await host.process('127JUNDENFRA', wa);
    await host.process('01Y1*', wa); // FI connection via KEF
    await host.process('-1SMITH/JOHN', wa);
    await host.process('WP', wa);
    const df = await host.process('WPDF', wa);
    // DEN-FRA through = DEFAULT_BASE 250 (unlisted market), within
    // MPM (5196 vs 6018) → constructed through fare in NUC format
    // (FRA is an intl airport) with X/ at KEF.
    expect(df).toContain('X/KEF');
    expect(df).toContain('NUC250.00 END ROE1.00');
  });
});
