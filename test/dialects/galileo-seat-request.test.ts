/**
 * W.2 — Galileo `S.` advance seat request family + Worldspan `4R`
 * translations onto it.
 *
 * The Galileo S. family (Pocket Guide H/ASR) stores onto the
 * cross-dialect pnr.seatRequests model the Amadeus ST family already
 * uses. Apollo reaches it via passthrough; Worldspan translates the
 * 4R sigil (Comparison Guide p.26 verbatim rows).
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { ApolloDialect } from '../../src/dialects/apollo/index.js';
import {
  WorldspanDialect,
  translateWorldspanToGalileo as t,
} from '../../src/dialects/worldspan/index.js';

async function galileoWa(host: GdsHost) {
  const wa = host.newWorkArea();
  await host.process('SON/ZGS', wa);
  await host.process('A15JULJFKLAX', wa);
  await host.process('N1Y1', wa);
  return wa;
}

describe('Galileo S. family', () => {
  function makeHost() {
    return new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
  }

  it('S.<pref> stores a preference for all pax/segments', async () => {
    const host = makeHost();
    const wa = await galileoWa(host);
    expect(await host.process('S.NW', wa)).toBe('OK');
    expect(wa.pnr.seatRequests).toEqual([{ code: 'NW', segment: undefined, nameRef: undefined }]);
  });

  it('S.S<n>/<seat> validates the seat against the segment seat map', async () => {
    const host = makeHost();
    const wa = await galileoWa(host);
    expect(await host.process('S.S1/10A', wa)).toBe('OK');
    expect(wa.pnr.seatRequests[0]).toMatchObject({ code: '10A', segment: 1 });
    expect(await host.process('S.S1/99Z', wa)).toBe('INVALID SEAT');
  });

  it('S.S<n>/<seat> on a segment not in the itinerary rejects', async () => {
    const host = makeHost();
    const wa = await galileoWa(host);
    expect(await host.process('S.S9/10A', wa)).toBe('SEGMENT NOT IN ITINERARY');
  });

  it('S.P<n>/<seat> carries the name reference', async () => {
    const host = makeHost();
    const wa = await galileoWa(host);
    await host.process('S.P1/12C', wa);
    expect(wa.pnr.seatRequests[0]).toMatchObject({ code: '12C', nameRef: { item: 1 } });
  });

  it('S.S<n>@ cancels per-segment; S.@ cancels all; empty → NO SEAT DATA', async () => {
    const host = makeHost();
    const wa = await galileoWa(host);
    await host.process('S.S1/10A', wa);
    await host.process('S.NW', wa);
    expect(await host.process('S.S1@', wa)).toBe('SEATS CANCELLED');
    expect(wa.pnr.seatRequests).toHaveLength(1); // the NW pref (no segment)
    expect(await host.process('S.@', wa)).toBe('SEATS CANCELLED');
    expect(await host.process('S.@', wa)).toBe('NO SEAT DATA');
  });

  it('Apollo reaches the same family via passthrough', async () => {
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: 'AB' });
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    await host.process('01Y1', wa);
    expect(await host.process('S.NW', wa)).toBe('OK');
    expect(wa.pnr.seatRequests).toHaveLength(1);
  });
});

describe('Worldspan 4R translations (Comparison Guide verbatim rows)', () => {
  it('translator maps all five forms', () => {
    expect(t('4RA$W')).toBe('S.NW');
    expect(t('4RA$5A')).toBe('S.SA');
    expect(t('4RS6$9A')).toBe('S.S6P1/9A');
    expect(t('4RX-6')).toBe('S.S6@');
    expect(t('4RX')).toBe('S.@');
  });

  it('end-to-end: 4RS1$10A stores a validated seat request', async () => {
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new WorldspanDialect(), pcc: '1P' });
    const wa = host.newWorkArea();
    await host.process('BSI$5467AB/GS', wa);
    await host.process('A21NOVJFKLAX', wa);
    await host.process('01Y1', wa);
    expect(await host.process('4RS1$10A', wa)).toBe('OK');
    expect(wa.pnr.seatRequests[0]).toMatchObject({ code: '10A', segment: 1 });
    expect(await host.process('4RS1$99Z', wa)).toBe('INVALID SEAT');
    expect(await host.process('4RX', wa)).toBe('SEATS CANCELLED');
  });
});
