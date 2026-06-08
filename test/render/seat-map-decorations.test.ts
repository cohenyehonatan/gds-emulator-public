/**
 * Tests for synthesizeDecorations + Amadeus rendering with
 * chargeable / preferred / legroom markers. Chunk 7 deferred #3.
 *
 * Per the Amadeus AA0505 sample (Service Hub solution 794907):
 *   L  LEGROOM       (bulkhead + exit rows)
 *   V  PREF.SEAT     (front of ECONOMY)
 *   Y  CHARGEABLE    (random per-seat)
 *
 * synthesizeDecorations is deterministic on (locator, date, seat) via
 * DJB2 hash; same query → same decorations.
 */

import { describe, it, expect } from 'vitest';
import { Inventory } from '../../src/store/inventory.js';
import { synthesizeDecorations } from '../../src/models/seat-map.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

describe('synthesizeDecorations', () => {
  it('marks every bulkhead row (cabin first row) as L (legroom)', () => {
    const inv = new Inventory();
    const sm = inv.seatMapFor('AA', '100')!; // 738: F rows 1-3 + Y rows 4-31
    const dec = synthesizeDecorations(sm, 'ABC123', '15JUL');
    // FIRST cabin starts at row 1 — every seat in row 1 should have L.
    for (const space of sm.Cabin[0].Row[0].Space) {
      expect(dec.get(`1${space.location}`)).toContain('L');
    }
    // ECONOMY cabin starts at row 4 — every seat in row 4 should have L.
    const econ = sm.Cabin.find((c) => c.name === 'ECONOMY')!;
    for (const space of econ.Row[0].Space) {
      expect(dec.get(`${econ.Row[0].label}${space.location}`)).toContain('L');
    }
  });

  it('marks exit-row seats as L (legroom)', () => {
    const inv = new Inventory();
    const sm = inv.seatMapFor('AA', '100')!;
    const dec = synthesizeDecorations(sm, 'ABC123', '15JUL');
    // 738 has exit rows at 12 and 14 (per seed-map-seed.ts).
    const econ = sm.Cabin.find((c) => c.name === 'ECONOMY')!;
    const exitRow = econ.Row.find((r) => r.label === '12')!;
    for (const space of exitRow.Space) {
      expect(dec.get(`12${space.location}`)).toContain('L');
    }
  });

  it('is deterministic — same inputs produce same decorations', () => {
    const inv = new Inventory();
    const sm = inv.seatMapFor('AA', '100')!;
    const a = synthesizeDecorations(sm, 'ABC123', '15JUL');
    const b = synthesizeDecorations(sm, 'ABC123', '15JUL');
    expect(a.size).toBe(b.size);
    for (const [key, val] of a) expect(b.get(key)).toEqual(val);
  });

  it('different locators produce different decoration distributions', () => {
    const inv = new Inventory();
    const sm = inv.seatMapFor('AA', '100')!;
    const a = synthesizeDecorations(sm, 'AAA000', '15JUL');
    const b = synthesizeDecorations(sm, 'BBB999', '15JUL');
    // L decorations on bulkhead/exit rows are structural (locator-
    // independent), but Y/V on interior seats vary by locator hash.
    // So the maps should not be identical.
    let hasDifference = false;
    for (const [key, val] of a) {
      const other = b.get(key);
      if (!other || other.join(',') !== val.join(',')) { hasDifference = true; break; }
    }
    expect(hasDifference).toBe(true);
  });

  it('produces some V (preferred) seats in the front 3 rows of ECONOMY', () => {
    const inv = new Inventory();
    const sm = inv.seatMapFor('AA', '100')!;
    const dec = synthesizeDecorations(sm, 'XYZ999', '15JUL');
    const econ = sm.Cabin.find((c) => c.name === 'ECONOMY')!;
    const firstThreeRows = econ.Row.slice(0, 3).map((r) => r.label);
    let vCount = 0;
    for (const [label, codes] of dec) {
      const rowLabel = label.match(/^(\d+)/)?.[1];
      if (rowLabel && firstThreeRows.includes(rowLabel) && codes.includes('V')) {
        vCount++;
      }
    }
    // ~30% of front-econ seats get V — should be at least some.
    expect(vCount).toBeGreaterThan(0);
  });

  it('produces some Y (chargeable) seats in interior rows', () => {
    const inv = new Inventory();
    const sm = inv.seatMapFor('AA', '100')!;
    const dec = synthesizeDecorations(sm, 'XYZ999', '15JUL');
    let yCount = 0;
    for (const [, codes] of dec) if (codes.includes('Y')) yCount++;
    expect(yCount).toBeGreaterThan(0);
  });
});

describe('Amadeus SM 1 renders decorations per-cell', () => {
  it('shows L on bulkhead row + exit row', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULDFWLHR', wa);
    await host.process('SS1F1', wa); // BA192 777
    const resp = await host.process('SM 1', wa);
    // Bulkhead row (FIRST cabin row 1) should have L cells
    expect(resp).toMatch(/1\s+L\s+L/);
    // Exit row should have E cells (already from chunk 2)
    expect(resp).toContain('--- EXIT ROW ---');
  });

  it('legend includes L LEGROOM + V PREF.SEAT + Y CHARGEABLE', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    const resp = await host.process('SM 1', wa);
    expect(resp).toContain('L LEGROOM');
    expect(resp).toContain('V PREF.SEAT');
    expect(resp).toContain('Y CHARGEABLE');
  });

  it('Sabre + Galileo unaffected (no decorations passed)', async () => {
    const { SabreDialect } = await import('../../src/dialects/sabre/index.js');
    const { GalileoDialect } = await import('../../src/dialects/galileo/index.js');
    const sabre = new GdsHost({ port: 0, logLevel: 'error', dialect: new SabreDialect(), pcc: 'XYZ' });
    const wa1 = sabre.newWorkArea();
    await sabre.process('SI', wa1);
    await sabre.process('115JULJFKLAX', wa1);
    await sabre.process('01Y1', wa1);
    const sabreOut = await sabre.process('4G1*', wa1);
    expect(sabreOut).not.toContain('L LEGROOM');
    expect(sabreOut).not.toContain('Y CHARGEABLE');

    const galileo = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
    const wa2 = galileo.newWorkArea();
    await galileo.process('SON/ZGS', wa2);
    await galileo.process('A15JULJFKLAX', wa2);
    await galileo.process('N1Y1', wa2);
    const galileoOut = await galileo.process('SA*S1', wa2);
    expect(galileoOut).not.toContain('L LEGROOM');
    expect(galileoOut).not.toContain('Y CHARGEABLE');
  });
});
