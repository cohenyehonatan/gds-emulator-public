/**
 * Amadeus v4 chunk 22 — hotel availability + sell (HA / HS / HX).
 *
 * Per QRG p.101 (HOTEL AVAILABILITY) + p.105 (HOTEL SELL).
 *
 * Verbs implemented:
 *   HA<city>[<date1>[-<date2>]]            all hotels in city
 *   HA<chain><city>[<date1>[-<date2>]]     chain-filtered list
 *   HA<chain><city><property>[<date>]      single-property display
 *   HS<n>[/<rate-code>]                    sell from cached avail
 *   HX<n>                                  cancel hotel segment
 *
 * Seed data (HOTEL_SEED): 10 fictional properties across 4 cities
 * (LON, MAD, ZRH, NYC) and 6 chains (HI/MC/SI/UI/BW/HN).
 *
 * Response wording reconstructed from QRG conventions — the QRG
 * documents the entries but not the verbatim screen layouts. The
 * shape is format-faithful to documented field naming.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';
import { Inventory } from '../../src/store/inventory.js';

function makeHost() {
  return new GdsHost({
    port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
  });
}

async function signedIn(host: GdsHost) {
  const wa = host.newWorkArea();
  await host.process('JI2345HA/GS', wa);
  return wa;
}

describe('Hotel inventory seed', () => {
  it('hotelsIn(LON) returns three properties', () => {
    const inv = new Inventory();
    expect(inv.hotelsIn('LON')).toHaveLength(3);
  });

  it('hotelsIn(LON, HI) filters to Holiday Inn', () => {
    const inv = new Inventory();
    const props = inv.hotelsIn('LON', 'HI');
    expect(props).toHaveLength(1);
    expect(props[0].name).toContain('HOLIDAY INN');
  });

  it('hotelByCode(UI, TIE) returns Park Hyatt Zurich', () => {
    const inv = new Inventory();
    const prop = inv.hotelByCode('UI', 'TIE');
    expect(prop?.name).toBe('PARK HYATT ZURICH');
  });

  it('hotelsIn(unknown city) returns empty', () => {
    const inv = new Inventory();
    expect(inv.hotelsIn('XYZ')).toEqual([]);
  });
});

describe('HA — hotel availability', () => {
  it('HA<city> returns city list', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('HALON', wa);
    expect(resp).toContain('AMADEUS HOTEL AVAILABILITY LON');
    expect(resp).toContain('3 PROPERTIES');
    expect(resp).toContain('HOLIDAY INN LONDON KENSINGTON');
  });

  it('HA<chain><city> filters by chain', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('HAHILON', wa);
    expect(resp).toContain('1 PROPERTIES');
    expect(resp).toContain('HOLIDAY INN');
    expect(resp).not.toContain('MARRIOTT');
  });

  it('HA<chain><city><property> selects one property', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('HAUIZRHTIE', wa);
    expect(resp).toContain('PARK HYATT ZURICH');
  });

  it('HA<city><date1>-<date2> computes night count', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('HALON12MAR-15MAR', wa);
    expect(resp).toContain('12MAR-15MAR');
    expect(resp).toContain('3N');
  });

  it('HA<city> with no date defaults to 1 night', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('HALON', wa);
    expect(resp).toContain('1N');
  });

  it('HA<unknown-city> returns NO HOTELS FOUND', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    expect(await host.process('HAXYZ', wa)).toBe('NO HOTELS FOUND');
  });

  it('HA caches the result for HS line reference', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('HAMAD', wa);
    expect(wa.lastHotelAvail?.city).toBe('MAD');
    expect(wa.lastHotelAvail?.properties.length).toBeGreaterThan(0);
  });
});

describe('HS — hotel sell', () => {
  async function setup(host: GdsHost) {
    const wa = await signedIn(host);
    await host.process('HALON', wa);
    return wa;
  }

  it('HS1 sells line 1 with default RAC rate', async () => {
    const host = makeHost();
    const wa = await setup(host);
    const resp = await host.process('HS1', wa);
    expect(resp).toContain('OK HOTEL CONFIRMED');
    expect(resp).toContain('HILON');
    expect(resp).toContain('RATE RAC');
    expect(wa.pnr.hotelSegments).toHaveLength(1);
    expect(wa.pnr.hotelSegments[0].rateCode).toBe('RAC');
  });

  it('HS1/COR sells line 1 with corporate rate', async () => {
    const host = makeHost();
    const wa = await setup(host);
    const resp = await host.process('HS1/COR', wa);
    expect(resp).toContain('RATE COR');
    expect(wa.pnr.hotelSegments[0].rateCode).toBe('COR');
    expect(wa.pnr.hotelSegments[0].ratePerNight).toBe(169);
  });

  it('HS with no cached availability → NO HOTEL DISPLAY', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    expect(await host.process('HS1', wa)).toBe('NO HOTEL DISPLAY');
  });

  it('HS99 (beyond list) → INVALID LINE', async () => {
    const host = makeHost();
    const wa = await setup(host);
    expect(await host.process('HS99', wa)).toBe('INVALID LINE');
  });

  it('HS1/ZZZ (unknown rate code) → INVALID RATE CODE', async () => {
    const host = makeHost();
    const wa = await setup(host);
    expect(await host.process('HS1/ZZZ', wa)).toBe('INVALID RATE CODE');
  });

  it('confirmation number is deterministic per (chain, property, idx)', async () => {
    const host1 = makeHost();
    const wa1 = await setup(host1);
    const host2 = makeHost();
    const wa2 = await setup(host2);
    const r1 = await host1.process('HS1', wa1);
    const r2 = await host2.process('HS1', wa2);
    const conf1 = r1.match(/HC(\d+)/)?.[1];
    const conf2 = r2.match(/HC(\d+)/)?.[1];
    expect(conf1).toBe(conf2);
  });

  it('subsequent HS bumps segment number', async () => {
    const host = makeHost();
    const wa = await setup(host);
    await host.process('HS1', wa);
    await host.process('HS2', wa);
    expect(wa.pnr.hotelSegments).toHaveLength(2);
    expect(wa.pnr.hotelSegments[0].segmentNumber).toBe(1);
    expect(wa.pnr.hotelSegments[1].segmentNumber).toBe(2);
  });
});

describe('HX — hotel cancel', () => {
  it('HX<n> removes the hotel segment', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('HALON', wa);
    await host.process('HS1', wa);
    expect(await host.process('HX1', wa)).toBe('OK CANCELLED');
    expect(wa.pnr.hotelSegments).toHaveLength(0);
  });

  it('HX with no matching segment → SEGMENT NOT IN ITINERARY', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    expect(await host.process('HX1', wa)).toBe('SEGMENT NOT IN ITINERARY');
  });
});
