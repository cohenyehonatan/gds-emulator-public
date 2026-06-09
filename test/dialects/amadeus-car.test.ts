/**
 * Amadeus v4 chunk 23 — car availability + sell (CA / CS / CX).
 *
 * Per QRG p.81 (CAR AVAILABILITY) + p.89 (CAR SELL).
 *
 * Verbs implemented:
 *   CA<city>[<date>[-<date>|-<N>]]         multi-company
 *   CA<company><city>[<date>[-<date>]]     specific company
 *   CS<n>[/VT-<vehicle-type>]              sell from cached list
 *   CX<n>                                  cancel car segment
 *
 * Companies (2-letter Amadeus codes): ZE Hertz, ZD Budget, ZA Avis,
 * ET Enterprise, ZI National, ZL Dollar, ZR Thrifty.
 *
 * Vehicle-type codes follow ACRISS SIPP (4 chars): ECMN, CCAR, ICAR,
 * IDAR, SDAR, FDAR, PDAR.
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

describe('Car inventory seed', () => {
  it('carsIn(LON) returns multiple rentals', () => {
    const inv = new Inventory();
    const cars = inv.carsIn('LON');
    expect(cars.length).toBeGreaterThan(3);
  });

  it('carsIn(LON, ZE) filters to Hertz', () => {
    const inv = new Inventory();
    const cars = inv.carsIn('LON', 'ZE');
    expect(cars.every((c) => c.company === 'ZE')).toBe(true);
  });

  it('carsIn(unknown city) returns empty', () => {
    const inv = new Inventory();
    expect(inv.carsIn('XYZ')).toEqual([]);
  });
});

describe('CA — car availability', () => {
  it('CA<city> returns multi-company list', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('CALON', wa);
    expect(resp).toContain('AMADEUS CAR AVAILABILITY LON');
    expect(resp).toContain('VEHICLES');
    expect(resp).toContain('1D'); // default 1 day
  });

  it('CA<company><city> filters by company', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('CAZELON', wa);
    expect(resp).toContain('ZE ECMN');
    expect(resp).not.toContain('ZD ');
    expect(resp).not.toContain('ZA ');
  });

  it('CA<city><date1>-<date2> computes day count', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('CAZRH15MAR-17MAR', wa);
    expect(resp).toContain('15MAR-17MAR');
    expect(resp).toContain('2D');
  });

  it('CA<city><date>-<N> uses N as rental-day count', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('CALON12MAR-3', wa);
    expect(resp).toContain('3D');
    expect(resp).toContain('12MAR-15MAR'); // bumped date
  });

  it('CA<unknown-city> returns NO CARS FOUND', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    expect(await host.process('CAXYZ', wa)).toBe('NO CARS FOUND');
  });

  it('CA caches the result for CS line reference', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('CAMAD', wa);
    expect(wa.lastCarAvail?.city).toBe('MAD');
    expect(wa.lastCarAvail?.rentals.length).toBeGreaterThan(0);
  });

  it('CA accepts /ARR-<time> suffix', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('CALON/ARR-0900', wa);
    expect(resp).toContain('AVAILABILITY LON');
    expect(wa.lastCarAvail?.arrivalTime).toBe('0900');
  });
});

describe('CS — car sell', () => {
  async function setup(host: GdsHost) {
    const wa = await signedIn(host);
    await host.process('CALON', wa);
    return wa;
  }

  it('CS1 sells line 1', async () => {
    const host = makeHost();
    const wa = await setup(host);
    const resp = await host.process('CS1', wa);
    expect(resp).toContain('OK CAR CONFIRMED');
    expect(resp).toContain('ZE ECMN');
    expect(resp).toContain('HERTZ');
    expect(wa.pnr.carSegments).toHaveLength(1);
    expect(wa.pnr.carSegments[0].company).toBe('ZE');
    expect(wa.pnr.carSegments[0].vehicleType).toBe('ECMN');
  });

  it('CS without cached availability → NO CAR DISPLAY', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    expect(await host.process('CS1', wa)).toBe('NO CAR DISPLAY');
  });

  it('CS99 (beyond list) → INVALID LINE', async () => {
    const host = makeHost();
    const wa = await setup(host);
    expect(await host.process('CS99', wa)).toBe('INVALID LINE');
  });

  it('confirmation number is deterministic', async () => {
    const host1 = makeHost();
    const wa1 = await setup(host1);
    const host2 = makeHost();
    const wa2 = await setup(host2);
    const r1 = await host1.process('CS1', wa1);
    const r2 = await host2.process('CS1', wa2);
    const conf1 = r1.match(/CC(\d+)/)?.[1];
    const conf2 = r2.match(/CC(\d+)/)?.[1];
    expect(conf1).toBe(conf2);
  });

  it('multiple CS calls increment segment numbers', async () => {
    const host = makeHost();
    const wa = await setup(host);
    await host.process('CS1', wa);
    await host.process('CS2', wa);
    expect(wa.pnr.carSegments).toHaveLength(2);
    expect(wa.pnr.carSegments[0].segmentNumber).toBe(1);
    expect(wa.pnr.carSegments[1].segmentNumber).toBe(2);
  });
});

describe('CX — car cancel', () => {
  it('CX<n> removes the car segment', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('CALON', wa);
    await host.process('CS1', wa);
    expect(await host.process('CX1', wa)).toBe('OK CANCELLED');
    expect(wa.pnr.carSegments).toHaveLength(0);
  });

  it('CX with no matching segment → SEGMENT NOT IN ITINERARY', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    expect(await host.process('CX1', wa)).toBe('SEGMENT NOT IN ITINERARY');
  });
});
