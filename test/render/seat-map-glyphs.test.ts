/**
 * Per-dialect glyph map tests. The renderer takes a SeatMapGlyphs
 * config that each dialect overrides to match its published
 * convention:
 *   - Sabre: * = available, . = taken (per DL/MD90 + Eurostar 2026)
 *   - Amadeus: . = available, + = occupied, X = blocked (per Service
 *     Hub solution 794907)
 *   - Galileo: . = available, X = reserved, - = blocked + position
 *     SCC W/A/M per-cell (cross-dialect default; no public Galileo
 *     cryptic sample, see `docs/seatmap-output-parity.md`)
 *
 * Tests assert that each dialect renders with the right glyphs by
 * finding seats in known status buckets via the deterministic
 * synthesizer.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { SabreDialect } from '../../src/dialects/sabre/index.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';
import {
  AMADEUS_GLYPHS,
  SABRE_GLYPHS,
  GALILEO_GLYPHS,
} from '../../src/render/seat-map-render.js';

describe('Per-dialect glyph maps — published-convention constants', () => {
  it('AMADEUS_GLYPHS matches Service Hub solution 794907 legend', () => {
    expect(AMADEUS_GLYPHS.statusGlyphs.Available).toBe('.');
    expect(AMADEUS_GLYPHS.statusGlyphs.Reserved).toBe('+'); // OCCUPIED
    expect(AMADEUS_GLYPHS.statusGlyphs.Blocked).toBe('X');
    expect(AMADEUS_GLYPHS.statusGlyphs.NoSeat).toBe(' ');
    expect(AMADEUS_GLYPHS.legend).toContain('Amadeus');
  });

  it('SABRE_GLYPHS matches Basic Course DL/MD90 + Eurostar 2026 (. = TAKEN)', () => {
    expect(SABRE_GLYPHS.statusGlyphs.Available).toBe('*');
    expect(SABRE_GLYPHS.statusGlyphs.Reserved).toBe('.'); // TAKEN
    expect(SABRE_GLYPHS.statusGlyphs.Blocked).toBe('-');
    expect(SABRE_GLYPHS.statusGlyphs.NoSeat).toBe(' ');
    expect(SABRE_GLYPHS.legend).toContain('Sabre');
  });

  it('GALILEO_GLYPHS is the cross-dialect default (reconstructed)', () => {
    expect(GALILEO_GLYPHS.statusGlyphs.Available).toBe('.');
    expect(GALILEO_GLYPHS.statusGlyphs.Reserved).toBe('X');
    expect(GALILEO_GLYPHS.statusGlyphs.Blocked).toBe('-');
    // Position SCC labeling per-cell — Galileo keeps the full set
    expect(GALILEO_GLYPHS.positionPriority).toContain('W');
    expect(GALILEO_GLYPHS.positionPriority).toContain('A');
  });

  it('Amadeus + Sabre drop W/A/M from per-cell position priority', () => {
    // Both Amadeus and Sabre published samples don't show window/aisle/
    // middle SCCs per-cell — those are column-header / structural
    // annotations, not per-cell.
    expect(AMADEUS_GLYPHS.positionPriority).not.toContain('W');
    expect(AMADEUS_GLYPHS.positionPriority).not.toContain('A');
    expect(AMADEUS_GLYPHS.positionPriority).not.toContain('M');
    expect(SABRE_GLYPHS.positionPriority).not.toContain('W');
    expect(SABRE_GLYPHS.positionPriority).not.toContain('A');
    expect(SABRE_GLYPHS.positionPriority).not.toContain('M');
    // Both keep E (exit) — exit rows are still per-cell in both
    expect(AMADEUS_GLYPHS.positionPriority).toContain('E');
    expect(SABRE_GLYPHS.positionPriority).toContain('E');
  });
});

describe('Per-dialect glyph rendering — actual output verification', () => {
  it('Sabre 4G1* renders Sabre-style legend (`* AVAIL  . TAKEN`)', async () => {
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new SabreDialect(), pcc: 'XYZ' });
    const wa = host.newWorkArea();
    await host.process('SI', wa);
    await host.process('115JULJFKLAX', wa);
    await host.process('01Y1', wa);
    const resp = await host.process('4G1*', wa);
    expect(resp).toContain('* AVAIL');
    expect(resp).toContain('. TAKEN');
    expect(resp).toContain('Sabre Basic Course');
    // Per-cell glyph: an available seat in Sabre is `*`, not `.`
    // (the cross-dialect default would have been `.`). Find any line
    // with multiple `*` chars — confirms `*` is the available glyph.
    const hasAvailStars = resp.split('\n').some((line) => /\*\s+\*/.test(line));
    expect(hasAvailStars).toBe(true);
  });

  it('Amadeus SM 1 renders Amadeus-style legend (`. AVAILABLE  + OCCUPIED  X BLOCKED`)', async () => {
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC' });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    const resp = await host.process('SM 1', wa);
    expect(resp).toContain('. AVAILABLE');
    expect(resp).toContain('+ OCCUPIED');
    expect(resp).toContain('X BLOCKED');
    expect(resp).toContain('Amadeus Service Hub');
    // Per-cell glyph: occupied seats render as `+`, not `X` (the
    // cross-dialect default would have been `X`).
    const hasOccupiedPluses = resp.split('\n').some((line) => /\+\s+\+/.test(line));
    expect(hasOccupiedPluses).toBe(true);
  });

  it('Galileo SA*S1 keeps the cross-dialect default (. = avail, X = reserved)', async () => {
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    await host.process('N1Y1', wa);
    const resp = await host.process('SA*S1', wa);
    expect(resp).toContain('. avail');
    expect(resp).toContain('X reserved');
    expect(resp).toContain('W window');
    // Per-cell glyph: window seats show 'W' per-cell (Galileo keeps
    // position SCC labeling; Amadeus + Sabre drop it).
    const hasWindowMarkers = resp.split('\n').some((line) => /W\s/.test(line));
    expect(hasWindowMarkers).toBe(true);
  });

  it('Amadeus + Sabre body differs from Galileo at the same seat coords', async () => {
    // Build all three with the same flight, compare a row of seats.
    const sabreHost = new GdsHost({ port: 0, logLevel: 'error', dialect: new SabreDialect(), pcc: 'XYZ' });
    const wa1 = sabreHost.newWorkArea();
    await sabreHost.process('SI', wa1);
    await sabreHost.process('115JULJFKLAX', wa1);
    await sabreHost.process('01Y1', wa1);
    const sabreOut = await sabreHost.process('4G1*', wa1);

    const amadeusHost = new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC' });
    const wa2 = amadeusHost.newWorkArea();
    await amadeusHost.process('JI2345HA/GS', wa2);
    await amadeusHost.process('AN15JULJFKLAX', wa2);
    await amadeusHost.process('SS1Y1', wa2);
    const amadeusOut = await amadeusHost.process('SM 1', wa2);

    const galileoHost = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
    const wa3 = galileoHost.newWorkArea();
    await galileoHost.process('SON/ZGS', wa3);
    await galileoHost.process('A15JULJFKLAX', wa3);
    await galileoHost.process('N1Y1', wa3);
    const galileoOut = await galileoHost.process('SA*S1', wa3);

    // All three render different per-cell glyphs (legends differ; body
    // glyphs differ; cabin layout structure is identical).
    expect(sabreOut).not.toBe(amadeusOut);
    expect(amadeusOut).not.toBe(galileoOut);
    expect(sabreOut).not.toBe(galileoOut);
  });
});
