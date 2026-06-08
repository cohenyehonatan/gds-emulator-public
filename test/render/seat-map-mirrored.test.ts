/**
 * Tests for the Amadeus mirrored row format — chunk 7 deferred #4.
 *
 * Per the AA0505 Amadeus Service Hub sample (solution 794907 vertical
 * display), seat-map rows show:
 *   - Cabin code on FIRST row of each cabin (left + right mirrored)
 *   - Top + bottom column headers per cabin
 *   - Bulkhead marker `B` on first row of cabin (left + right)
 *   - Wing markers `< >` on middle 60% of rows
 *   - Combined `<E E>` when row is BOTH wing AND exit
 *
 * Sample (verbatim from solution 794907):
 *           A  B  C     D  E  F
 *   Y  8 B  L  L  L     +  +  L  B 8  Y
 *      9    L  L  L     L  L  L    9
 *     13 <  .  V  V     V  V  .  > 13
 *     16 <E L  L  L     L  L  L E> 16
 *
 * The format toggles via AMADEUS_GLYPHS.mirroredRows; Sabre + Galileo
 * leave it false, so their renders stay simple.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';
import { SabreDialect } from '../../src/dialects/sabre/index.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import {
  AMADEUS_GLYPHS,
  SABRE_GLYPHS,
  GALILEO_GLYPHS,
} from '../../src/render/seat-map-render.js';

describe('AMADEUS_GLYPHS.mirroredRows is true; Sabre + Galileo leave it false', () => {
  it('AMADEUS_GLYPHS sets mirroredRows true', () => {
    expect(AMADEUS_GLYPHS.mirroredRows).toBe(true);
  });
  it('SABRE_GLYPHS leaves mirroredRows undefined/false', () => {
    expect(SABRE_GLYPHS.mirroredRows).toBeFalsy();
  });
  it('GALILEO_GLYPHS leaves mirroredRows undefined/false', () => {
    expect(GALILEO_GLYPHS.mirroredRows).toBeFalsy();
  });
});

describe('Amadeus SM 1 — mirrored cabin codes + bulkhead/wing markers + top+bottom column headers', () => {
  it('cabin code prints on left AND right of first row of each cabin', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULDFWLHR', wa);
    await host.process('SS1F1', wa); // BA192 777 — has F + J + Y cabins
    const resp = await host.process('SM 1', wa);
    // FIRST cabin row 1: F on left AND F on right
    expect(resp).toMatch(/F\s+1.*F\s*$/m);
    // BUSINESS cabin (row 5 or wherever the second cabin starts): J on both sides
    expect(resp).toMatch(/J\s+\d+.*J\s*$/m);
    // ECONOMY cabin (third cabin): Y on both sides
    expect(resp).toMatch(/Y\s+\d+.*Y\s*$/m);
  });

  it('first row of each cabin shows B (bulkhead) marker on left AND right', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULDFWLHR', wa);
    await host.process('SS1F1', wa);
    const resp = await host.process('SM 1', wa);
    // FIRST cabin row 1: B both before and after seat cells
    expect(resp).toMatch(/F\s+1\s+B\b.*\bB\s+1\s+F/m);
  });

  it('wing rows (middle 60% of cabin) show < and > markers', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa); // B6615 32A — has econ rows
    const resp = await host.process('SM 1', wa);
    // Should have at least one row line with < ... > markers
    expect(resp).toMatch(/^\s*\d+\s+<.*>\s+\d+/m);
  });

  it('column header appears at top AND bottom of each cabin', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    const resp = await host.process('SM 1', wa);
    // For a 3-3 narrow-body econ cabin, header reads "A  B  C     D  E  F"
    // Should appear at LEAST twice (top + bottom of cabin).
    const matches = resp.match(/^\s+A\s+B\s+C\s+D\s+E\s+F/gm);
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });

  it('legend updates to include <> WING + B BULKHEAD', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    const resp = await host.process('SM 1', wa);
    expect(resp).toContain('<> WING');
    expect(resp).toContain('B BULKHEAD');
  });

  it('does NOT print the "ECONOMY (Y)" cabin-label header line', async () => {
    // Mirrored mode uses cabin-code-per-row instead of the cross-dialect
    // "ECONOMY (Y)" line that simple mode prints.
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    const resp = await host.process('SM 1', wa);
    expect(resp).not.toContain('ECONOMY (Y)');
  });
});

describe('Sabre + Galileo unaffected by mirrored-rows feature', () => {
  it('Sabre 4G1* still uses simple-row format (no mirrored cabin codes)', async () => {
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new SabreDialect(), pcc: 'XYZ' });
    const wa = host.newWorkArea();
    await host.process('SI', wa);
    await host.process('115JULJFKLAX', wa);
    await host.process('01Y1', wa);
    const resp = await host.process('4G1*', wa);
    // Still uses "ECONOMY (Y)" header line.
    expect(resp).toContain('ECONOMY (Y)');
    // No < or > wing markers should appear at row-edges (no `< ` after row number).
    expect(resp).not.toMatch(/^\s*\d+\s+<\s/m);
  });

  it('Galileo SA*S1 still uses simple-row format', async () => {
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    await host.process('N1Y1', wa);
    const resp = await host.process('SA*S1', wa);
    expect(resp).toContain('ECONOMY (Y)');
    expect(resp).not.toMatch(/^\s*\d+\s+<\s/m);
  });
});
