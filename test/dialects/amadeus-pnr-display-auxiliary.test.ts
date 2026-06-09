/**
 * v6 gap #1 — hotel/car segments in PNR displays.
 *
 * Chunks 22/23 added pnr.hotelSegments / carSegments but the PNR
 * displays (RT<locator>, the build display, RTI) only rendered air
 * segments — a sold hotel/car was invisible. This closes that plus
 * the adjacent persistence gaps: Pnr.clone() (RRN/SP paths),
 * Pnr.hasContent(), and JsonFilePnrStore round-trip.
 *
 * Display shape: auxiliary segments interleave by segmentNumber with
 * HHL (hotel) / CCR (car) type markers per Amadeus convention;
 * response wording reconstructed.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';
import { Pnr } from '../../src/models/pnr.js';
import type { HotelSegment } from '../../src/models/hotel.js';
import type { CarSegment } from '../../src/models/car.js';

function makeHost() {
  return new GdsHost({
    port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
  });
}

async function buildWithAux(host: GdsHost) {
  const wa = host.newWorkArea();
  await host.process('JI2345HA/GS', wa);
  await host.process('AN15JULJFKLAX', wa);
  await host.process('SS1Y1', wa);
  await host.process('NM1SMITH/JOHN MR', wa);
  await host.process('AP020 555-1212-A', wa);
  await host.process('TKOK', wa);
  await host.process('RFAGT', wa);
  await host.process('HALON12MAR-15MAR', wa);
  await host.process('HS1', wa);
  await host.process('CALON12MAR-15MAR', wa);
  await host.process('CS1', wa);
  return wa;
}

describe('RTI — itinerary display interleaves air + hotel + car by segment number', () => {
  it('renders HHL and CCR lines after the air segment', async () => {
    const host = makeHost();
    const wa = await buildWithAux(host);
    const rti = await host.process('RTI', wa);
    const lines = rti.split('\n');
    expect(lines[0]).toContain('1. B6 615');
    expect(lines[1]).toContain('2. HHL HI HK LON 12MAR-15MAR');
    expect(lines[1]).toContain('HOLIDAY INN LONDON KENSINGTON');
    expect(lines[2]).toContain('3. CCR ZE HK LON 12MAR-15MAR ECMN');
  });
});

describe('RT<locator> — retrieved PNR shows auxiliary segments', () => {
  it('hotel + car survive ER and render on retrieve', async () => {
    const host = makeHost();
    const wa = await buildWithAux(host);
    const er = await host.process('ER', wa);
    const loc = /([A-Z0-9]{6})\s*$/.exec(er)![1];
    const wa2 = host.newWorkArea();
    await host.process('JI2345HA/GS', wa2);
    const rt = await host.process(`RT${loc}`, wa2);
    expect(rt).toContain('HHL HI HK LON');
    expect(rt).toContain('CCR ZE HK LON');
    expect(rt).toContain('HC'); // hotel confirmation number
  });
});

describe('Pnr.clone() carries auxiliary segments (RRN / SP paths)', () => {
  it('clone() deep-copies hotelSegments + carSegments', () => {
    const p = new Pnr();
    const hotel: HotelSegment = {
      segmentNumber: 1, chain: 'HI', property: 'LON', name: 'TEST HOTEL',
      city: 'LON', checkIn: '12MAR', checkOut: '15MAR', nights: 3,
      rateCode: 'RAC', ratePerNight: 199, currency: 'GBP', rooms: 1, status: 'HK',
    };
    const car: CarSegment = {
      segmentNumber: 2, company: 'ZE', companyName: 'HERTZ',
      vehicleType: 'ECMN', category: 'ECONOMY MANUAL', rateCode: 'BST',
      city: 'LON', pickup: '12MAR', dropoff: '15MAR', days: 3,
      amount: 35, currency: 'GBP', status: 'HK',
    };
    p.hotelSegments.push(hotel);
    p.carSegments.push(car);
    const c = p.clone();
    expect(c.hotelSegments).toHaveLength(1);
    expect(c.carSegments).toHaveLength(1);
    // Deep copy — mutating the clone must not touch the original.
    c.hotelSegments[0].status = 'XX';
    expect(p.hotelSegments[0].status).toBe('HK');
  });

  it('RRN copy carries the hotel segment', async () => {
    const host = makeHost();
    const wa = await buildWithAux(host);
    const er = await host.process('ER', wa);
    const loc = /([A-Z0-9]{6})\s*$/.exec(er)![1];
    const wa2 = host.newWorkArea();
    await host.process('JI2345HA/GS', wa2);
    await host.process(`RT${loc}`, wa2);
    await host.process('RRN', wa2);
    expect(wa2.pnr.hotelSegments).toHaveLength(1);
    expect(wa2.pnr.carSegments).toHaveLength(1);
    expect(wa2.pnr.locator).toBeUndefined();
  });
});

describe('Pnr.hasContent() counts auxiliary segments', () => {
  it('a PNR with only a hotel segment is dirty', () => {
    const p = new Pnr();
    expect(p.hasContent()).toBe(false);
    p.hotelSegments.push({
      segmentNumber: 1, chain: 'HI', property: 'LON', name: 'X',
      city: 'LON', checkIn: '12MAR', checkOut: '13MAR', nights: 1,
      rateCode: 'RAC', ratePerNight: 100, currency: 'GBP', rooms: 1, status: 'HK',
    });
    expect(p.hasContent()).toBe(true);
  });
});
