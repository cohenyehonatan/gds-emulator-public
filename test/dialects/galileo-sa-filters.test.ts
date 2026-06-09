/**
 * Galileo SA* filter suffixes — chunk 7 deferred #9.
 *
 * Per galileoindonesia.com Air Transportation guide, SA* and SM*
 * accept optional filter suffixes:
 *
 *   SA*S<n>/<row>                 from-row offset
 *   SA*S<n>/NW                    non-smoking-window preference
 *   SA*S<n>/NW/<row>              combined preference + offset
 *   SA*S<n>#<airport>             change-of-gauge leg
 *   SA*S<n>/<class>-<count>       for N passengers
 *   SC*<seat>                     display PADIS 9825 codes for one seat
 *
 * Semantic effect in our emulator:
 *   fromRow → drives renderer rowOffset (real effect)
 *   preference / paxCount / cogOrigin → accepted, no semantic effect
 *   (we don't model smoking; pax-count is allocation, not display)
 *
 * SC*<seat> reads from the cached seat map (must be displayed first).
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';

function makeHost() {
  return new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
}

async function withSegment(host: GdsHost): Promise<ReturnType<typeof host.newWorkArea>> {
  const wa = host.newWorkArea();
  await host.process('SON/ZGS', wa);
  await host.process('A15JULJFKLAX', wa);
  await host.process('N1Y1', wa);
  return wa;
}

describe('Galileo SA*S<n> filter suffix parsing', () => {
  for (const [entry, expected] of [
    ['SA*S1',          { segment: 1 }],
    ['SA*S1/15',       { segment: 1, fromRow: 15 }],
    ['SA*S1/NW',       { segment: 1, preference: 'NW' }],
    ['SA*S1/NW/15',    { segment: 1, preference: 'NW', fromRow: 15 }],
    ['SA*S1/15/NW',    { segment: 1, preference: 'NW', fromRow: 15 }],
    ['SA*S1#BRU',      { segment: 1, cogOrigin: 'BRU' }],
    ['SA*S1/F-3',      { segment: 1, paxCount: 3 }],
    ['SA*S1/N',        { segment: 1, preference: 'N' }],
    ['SA*S1/SA',       { segment: 1, preference: 'SA' }],
    ['SA*S4/NW/15;',   { segment: 4, preference: 'NW', fromRow: 15 }],
  ] as const) {
    it(`parses ${entry}`, () => {
      const e = parseGalileoEntry(entry);
      expect(e.kind).toBe('seat_map');
      if (e.kind !== 'seat_map') throw new Error('!');
      expect(e.source).toBe('segment');
      expect(e.segment).toBe(expected.segment);
      const f = e.filters ?? {};
      if ('fromRow' in expected) expect(f.fromRow).toBe(expected.fromRow);
      if ('preference' in expected) expect(f.preference).toBe(expected.preference);
      if ('paxCount' in expected) expect(f.paxCount).toBe(expected.paxCount);
      if ('cogOrigin' in expected) expect(f.cogOrigin).toBe(expected.cogOrigin);
    });
  }
});

describe('Galileo SM*A<line> filter suffix parsing', () => {
  it('parses SM*A1F/NW', () => {
    const e = parseGalileoEntry('SM*A1F/NW');
    if (e.kind !== 'seat_map') throw new Error('!');
    expect(e.source).toBe('avail-line');
    expect(e.line).toBe(1);
    expect(e.bookingClass).toBe('F');
    expect(e.filters?.preference).toBe('NW');
  });
  it('parses SM*A2/NW/20', () => {
    const e = parseGalileoEntry('SM*A2/NW/20');
    if (e.kind !== 'seat_map') throw new Error('!');
    expect(e.line).toBe(2);
    expect(e.filters?.preference).toBe('NW');
    expect(e.filters?.fromRow).toBe(20);
  });
});

describe('Galileo SA* fromRow filter — real semantic effect', () => {
  it('SA*S1/15 renders starting at row 15 (rowOffset)', async () => {
    const host = makeHost();
    const wa = await withSegment(host);
    const resp = await host.process('SA*S1/15', wa);
    // Row 15 should be the first row label shown.
    expect(resp).toMatch(/\b15\s+W/m);
    // Row 1 should NOT be shown (we offset past it).
    expect(resp).not.toMatch(/\b1\s+W\s+\.\s+A\s+\s+A\s+\.\s+W\b/);
    // Trailer notes the offset.
    expect(resp).toContain('ROWS 15-');
  });

  it('SA*S1/NW/15 still renders from row 15 (combined filter)', async () => {
    const host = makeHost();
    const wa = await withSegment(host);
    const resp = await host.process('SA*S1/NW/15', wa);
    expect(resp).toContain('ROWS 15-');
  });

  it('SA*S1#BRU (change-of-gauge) renders the same as SA*S1 (no semantic effect)', async () => {
    const host = makeHost();
    async function run(entry: string): Promise<string> {
      const wa = await withSegment(host);
      return host.process(entry, wa);
    }
    expect(await run('SA*S1#BRU')).toBe(await run('SA*S1'));
  });

  it('SA*S1/F-3 (pax count) renders the same as SA*S1 (no semantic effect)', async () => {
    const host = makeHost();
    async function run(entry: string): Promise<string> {
      const wa = await withSegment(host);
      return host.process(entry, wa);
    }
    expect(await run('SA*S1/F-3')).toBe(await run('SA*S1'));
  });

  it('SA*S1/NW (preference only) renders the same as SA*S1 (we don\'t model smoking)', async () => {
    const host = makeHost();
    async function run(entry: string): Promise<string> {
      const wa = await withSegment(host);
      return host.process(entry, wa);
    }
    expect(await run('SA*S1/NW')).toBe(await run('SA*S1'));
  });
});

describe('Galileo SC*<seat> — display PADIS 9825 codes for one seat', () => {
  it('SC*1A returns the SCC codes for seat 1A (bulkhead, window)', async () => {
    const host = makeHost();
    const wa = await withSegment(host);
    await host.process('SA*S1', wa); // cache the map
    const resp = await host.process('SC*1A', wa);
    expect(resp).toContain('SEAT 1A CHARACTERISTICS');
    expect(resp).toMatch(/W\s+Window seat/);
  });

  it('SC*11A on B6615 returns exit-row codes', async () => {
    const host = makeHost();
    const wa = await withSegment(host);
    await host.process('SA*S1', wa);
    const resp = await host.process('SC*11A', wa);
    expect(resp).toContain('SEAT 11A CHARACTERISTICS');
    expect(resp).toMatch(/E\s+Exit/);
  });

  it('SC*99Z (seat not in map) returns SEAT NOT FOUND', async () => {
    const host = makeHost();
    const wa = await withSegment(host);
    await host.process('SA*S1', wa);
    expect(await host.process('SC*99Z', wa)).toBe('SEAT NOT FOUND');
  });

  it('SC*1A without a cached seat map returns NO SEAT MAP DISPLAYED', async () => {
    const host = makeHost();
    const wa = await withSegment(host); // segment exists but no SA* fired
    expect(await host.process('SC*1A', wa)).toBe('NO SEAT MAP DISPLAYED');
  });
});
