/**
 * Amadeus v4 chunk 24 — RRN passenger-specific variants + RRI.
 *
 * Per QRG p.47 (Copying a PNR). Builds on chunk 18 which landed
 * RRN/DP<n>, RRN/DM<n>, RRN/C<class>, RRN/S<list>.
 *
 * Variants added in chunk 24:
 *   RRN/<n>          change number of passengers
 *   RRN/P<list>      keep only listed passengers (range + comma)
 *   RRN/PX<list>     exclude listed passengers
 *   RRN/SX<list>     exclude listed segments
 *   RRI[/<opts>]     copy itinerary elements only (no names/services)
 *
 * Lists support comma + range syntax: `1,3-5`.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

function makeHost() {
  return new GdsHost({
    port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
  });
}

async function commit(host: GdsHost, passengers: string[][], segs = 1): Promise<string> {
  const wa = host.newWorkArea();
  await host.process('JI2345HA/GS', wa);
  await host.process('AN15JULJFKLAX', wa);
  await host.process(`SS${passengers.length}Y${segs}`, wa);
  for (const p of passengers) {
    const body = p.length === 1
      ? `NM1${p[0]}`
      : `NM${p.length - 1}${p[0]}/${p.slice(1).join('/')}`;
    await host.process(body, wa);
  }
  await host.process('AP020 555-1212-A', wa);
  await host.process('TKOK', wa);
  await host.process('RFAGT', wa);
  const er = await host.process('ER', wa);
  return / - ([A-Z0-9]{6})/.exec(er)?.[1] ?? '';
}

async function retrieve(host: GdsHost, locator: string) {
  const wa = host.newWorkArea();
  await host.process('JI2345HA/GS', wa);
  await host.process(`RT${locator}`, wa);
  return wa;
}

describe('RRN/<n> — change number of passengers', () => {
  it('RRN/2 trims a 3-pax PNR to 2 names', async () => {
    const host = makeHost();
    const loc = await commit(host, [
      ['SMITH', 'JOHN MR'],
      ['JONES', 'JANE MRS'],
      ['BROWN', 'BOB MR'],
    ]);
    const wa = await retrieve(host, loc);
    expect(await host.process('RRN/2', wa)).toBe(`COPIED FROM ${loc} 2`);
    expect(wa.pnr.names).toHaveLength(2);
    expect(wa.pnr.names[0].surname).toBe('SMITH');
    expect(wa.pnr.names[1].surname).toBe('JONES');
    // BROWN dropped (last-added first).
  });

  it('RRN/1 trims a 3-pax PNR to 1 name', async () => {
    const host = makeHost();
    const loc = await commit(host, [
      ['SMITH', 'JOHN MR'],
      ['JONES', 'JANE MRS'],
      ['BROWN', 'BOB MR'],
    ]);
    const wa = await retrieve(host, loc);
    await host.process('RRN/1', wa);
    expect(wa.pnr.names).toHaveLength(1);
  });

  it('RRN/<n> on a multi-passenger NameItem trims within the item', async () => {
    // 1 NM with 3 pax → RRN/2 should keep 2 of 3 passengers
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS3Y1', wa);
    await host.process('NM3SMITH/JOHN MR/JANE MRS/BABY MISS', wa);
    await host.process('AP020 555-1212-A', wa);
    await host.process('TKOK', wa);
    await host.process('RFAGT', wa);
    const er = await host.process('ER', wa);
    const loc = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    const wa2 = await retrieve(host, loc);
    await host.process('RRN/2', wa2);
    // One NameItem with count=2 + 2 passengers.
    expect(wa2.pnr.names).toHaveLength(1);
    expect(wa2.pnr.names[0].count).toBe(2);
    expect(wa2.pnr.names[0].passengers).toHaveLength(2);
  });

  it('RRN/0 returns FORMAT', async () => {
    const host = makeHost();
    const loc = await commit(host, [['SMITH', 'JOHN MR']]);
    const wa = await retrieve(host, loc);
    expect(await host.process('RRN/0', wa)).toBe('FORMAT');
  });
});

describe('RRN/P<list> — keep only listed passengers', () => {
  it('RRN/P1 keeps only the first NameItem', async () => {
    const host = makeHost();
    const loc = await commit(host, [
      ['SMITH', 'JOHN MR'],
      ['JONES', 'JANE MRS'],
      ['BROWN', 'BOB MR'],
    ]);
    const wa = await retrieve(host, loc);
    expect(await host.process('RRN/P1', wa)).toBe(`COPIED FROM ${loc} P1`);
    expect(wa.pnr.names).toHaveLength(1);
    expect(wa.pnr.names[0].surname).toBe('SMITH');
  });

  it('RRN/P1,3 keeps NameItems 1 and 3 (skips 2)', async () => {
    const host = makeHost();
    const loc = await commit(host, [
      ['SMITH', 'JOHN MR'],
      ['JONES', 'JANE MRS'],
      ['BROWN', 'BOB MR'],
    ]);
    const wa = await retrieve(host, loc);
    await host.process('RRN/P1,3', wa);
    expect(wa.pnr.names).toHaveLength(2);
    expect(wa.pnr.names.map((n) => n.surname)).toEqual(['SMITH', 'BROWN']);
  });

  it('RRN/P1-2 (range) keeps NameItems 1 and 2', async () => {
    const host = makeHost();
    const loc = await commit(host, [
      ['SMITH', 'JOHN MR'],
      ['JONES', 'JANE MRS'],
      ['BROWN', 'BOB MR'],
    ]);
    const wa = await retrieve(host, loc);
    await host.process('RRN/P1-2', wa);
    expect(wa.pnr.names).toHaveLength(2);
    expect(wa.pnr.names.map((n) => n.surname)).toEqual(['SMITH', 'JONES']);
  });

  it('RRN/P99 returns INVALID PASSENGER', async () => {
    const host = makeHost();
    const loc = await commit(host, [['SMITH', 'JOHN MR']]);
    const wa = await retrieve(host, loc);
    expect(await host.process('RRN/P99', wa)).toBe('INVALID PASSENGER');
  });
});

describe('RRN/PX<list> — exclude listed passengers', () => {
  it('RRN/PX2 drops only NameItem 2', async () => {
    const host = makeHost();
    const loc = await commit(host, [
      ['SMITH', 'JOHN MR'],
      ['JONES', 'JANE MRS'],
      ['BROWN', 'BOB MR'],
    ]);
    const wa = await retrieve(host, loc);
    expect(await host.process('RRN/PX2', wa)).toBe(`COPIED FROM ${loc} PX2`);
    expect(wa.pnr.names.map((n) => n.surname)).toEqual(['SMITH', 'BROWN']);
  });

  it('RRN/PX1,3 drops first and third', async () => {
    const host = makeHost();
    const loc = await commit(host, [
      ['SMITH', 'JOHN MR'],
      ['JONES', 'JANE MRS'],
      ['BROWN', 'BOB MR'],
    ]);
    const wa = await retrieve(host, loc);
    await host.process('RRN/PX1,3', wa);
    expect(wa.pnr.names).toHaveLength(1);
    expect(wa.pnr.names[0].surname).toBe('JONES');
  });

  it('RRN/PX99 returns INVALID PASSENGER', async () => {
    const host = makeHost();
    const loc = await commit(host, [['SMITH', 'JOHN MR']]);
    const wa = await retrieve(host, loc);
    expect(await host.process('RRN/PX99', wa)).toBe('INVALID PASSENGER');
  });
});

describe('RRN/SX<list> — exclude listed segments', () => {
  it('RRN/SX2 drops only segment 2', async () => {
    const host = makeHost();
    // Build a 2-segment PNR via two separate AN+SS.
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('AN20JULLAXJFK', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('AP020 555-1212-A', wa);
    await host.process('TKOK', wa);
    await host.process('RFAGT', wa);
    const er = await host.process('ER', wa);
    const loc = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    const wa2 = await retrieve(host, loc);
    expect(await host.process('RRN/SX2', wa2)).toBe(`COPIED FROM ${loc} SX2`);
    expect(wa2.pnr.segments).toHaveLength(1);
    expect(wa2.pnr.segments[0].origin).toBe('JFK');
  });
});

describe('RRI — copy itinerary only', () => {
  it('RRI drops names + phones + services, keeps segments', async () => {
    const host = makeHost();
    const loc = await commit(host, [
      ['SMITH', 'JOHN MR'],
      ['JONES', 'JANE MRS'],
    ]);
    const wa = await retrieve(host, loc);
    expect(await host.process('RRI', wa)).toBe(`COPIED FROM ${loc}`);
    expect(wa.pnr.names).toHaveLength(0);
    expect(wa.pnr.phones).toHaveLength(0);
    // Segments retained.
    expect(wa.pnr.segments.length).toBeGreaterThan(0);
  });

  it('RRI history records the RRI tag (not RRN)', async () => {
    const host = makeHost();
    const loc = await commit(host, [['SMITH', 'JOHN MR']]);
    const wa = await retrieve(host, loc);
    await host.process('RRI', wa);
    const lastHistory = wa.pnr.history[wa.pnr.history.length - 1];
    expect(lastHistory.text).toContain('RRI');
  });

  it('RRI/<n> returns FORMAT (numeric not allowed on RRI)', async () => {
    const host = makeHost();
    const loc = await commit(host, [['SMITH', 'JOHN MR']]);
    const wa = await retrieve(host, loc);
    expect(await host.process('RRI/2', wa)).toBe('FORMAT');
  });

  it('RRI/P1 returns FORMAT (RRI dropped names)', async () => {
    const host = makeHost();
    const loc = await commit(host, [['SMITH', 'JOHN MR']]);
    const wa = await retrieve(host, loc);
    expect(await host.process('RRI/P1', wa)).toBe('FORMAT');
  });

  it('RRI/SX<n> works (segment filter compatible with itinerary-only copy)', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('AN20JULLAXJFK', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('AP020 555-1212-A', wa);
    await host.process('TKOK', wa);
    await host.process('RFAGT', wa);
    const er = await host.process('ER', wa);
    const loc = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    const wa2 = await retrieve(host, loc);
    expect(await host.process('RRI/SX2', wa2)).toBe(`COPIED FROM ${loc} SX2`);
    expect(wa2.pnr.segments).toHaveLength(1);
    expect(wa2.pnr.names).toHaveLength(0);
  });
});

describe('RRN regression — chunk 18 variants still work', () => {
  it('RRN (no opts) full copy', async () => {
    const host = makeHost();
    const loc = await commit(host, [['SMITH', 'JOHN MR']]);
    const wa = await retrieve(host, loc);
    expect(await host.process('RRN', wa)).toBe(`COPIED FROM ${loc}`);
  });

  it('RRN/DP7 still pushes dates forward', async () => {
    const host = makeHost();
    const loc = await commit(host, [['SMITH', 'JOHN MR']]);
    const wa = await retrieve(host, loc);
    await host.process('RRN/DP7', wa);
    expect(wa.pnr.segments[0].date).toBe('22JUL');
  });

  it('RRN/CY still changes all classes', async () => {
    const host = makeHost();
    const loc = await commit(host, [['SMITH', 'JOHN MR']]);
    const wa = await retrieve(host, loc);
    await host.process('RRN/CY', wa);
    expect(wa.pnr.segments.every((s) => s.bookingClass === 'Y')).toBe(true);
  });
});
