/**
 * v6 — Galileo HO-star / CA-star hotel + car cryptic (Apollo via
 * passthrough).
 *
 * Verb forms verbatim from the Comparison Guide's 5-way "Hotels" +
 * "Cars" tables (Travelport+ column; Apollo column identical):
 *   HOA6FEB-09FEBSAN2    hotel availability (dates + city + adults)
 *   HOI<city>[/<chain>]  hotel index
 *   HOC<line>            complete availability for a line
 *   CAL23AUG-25AUGDEN/…  car availability (qualifiers ignored)
 *   CAI<city>            car vendor index
 *   N1A2D3               hotel reference sell (rooms/line/days —
 *                        decomposition interpreted from the verbatim
 *                        example; the guide shows entries not fields)
 *   N1A4                 car reference sell
 *
 * Sells share the air-sell shape; disambiguation is display-context
 * (the sell references whatever availability is on screen). Air
 * availability clears the aux displays and vice versa.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { ApolloDialect } from '../../src/dialects/apollo/index.js';

function makeHost() {
  return new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
}

async function signedIn(host: GdsHost) {
  const wa = host.newWorkArea();
  await host.process('SON/ZGS', wa);
  return wa;
}

describe('HOA / HOI / HOC — hotel displays', () => {
  it('HOA<d1>-<d2><city><adults> lists properties + caches for sell', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('HOA6FEB-09FEBLON2', wa);
    expect(resp).toContain('HOTEL AVAILABILITY LON 6FEB-09FEB');
    expect(resp).toContain('HOLIDAY INN LONDON KENSINGTON');
    expect(wa.lastHotelAvail?.city).toBe('LON');
    expect(wa.lastHotelAvail?.nights).toBe(3);
  });

  it('LAX (the JFK-LAX market) is now seeded — HOA + reference sell complete', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const avail = await host.process('HOA01JUL-02JULLAX1', wa);
    expect(avail).toContain('HOTEL AVAILABILITY LAX');
    expect(avail).toContain('HILTON LOS ANGELES AIRPORT');
    expect(avail).not.toContain('NO HOTELS');
    const sold = await host.process('N1A1', wa); // 1 room, line 1
    expect(sold).toContain('HOTEL SOLD');
    expect(wa.pnr.hotelSegments).toHaveLength(1);
    expect(wa.pnr.hotelSegments[0].city).toBe('LAX');
  });

  it('CAL for LAX returns cars (seeded)', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const avail = await host.process('CAL01JUL-03JULLAX', wa);
    expect(avail).toContain('CAR AVAILABILITY LAX');
    expect(avail).not.toContain('NO CARS');
  });

  it('HOI<city> renders the index; HOI<city>/<chain> filters', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    expect(await host.process('HOILON', wa)).toContain('HOTEL INDEX LON');
    const filtered = await host.process('HOILON/HI', wa);
    expect(filtered).toContain('HOLIDAY INN');
    expect(filtered).not.toContain('MARRIOTT');
  });

  it('HOA…/GEO-<lat>,<lng>: geolocation search is live-only — emulated → NO HOTELS', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    // The emulated seed has no geo index, so geo search honestly returns
    // nothing (it's a live Stays capability — SearchByGeoLocation).
    expect(await host.process('HOA17JUN-22JUN/GEO-40.3772,-105.5217', wa)).toBe('NO HOTELS');
  });

  it('HOI is a directory (no rates); HOA is priced — the two are distinct', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    // HOI index: property names, but NO rate column.
    const index = await host.process('HOILON', wa);
    expect(index).toContain('HOLIDAY INN LONDON KENSINGTON');
    expect(index).not.toMatch(/\d+GBP/); // no rate in the index
    // HOA availability: the same property WITH its low rate.
    const avail = await host.process('HOA6FEB-09FEBLON2', wa);
    expect(avail).toContain('HOTEL AVAILABILITY LON 6FEB-09FEB');
    expect(avail).toMatch(/169GBP/); // HI LON low rate (COR 169)
  });

  it('HOC<line> shows all rates for the property on that line', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('HOA6FEB-09FEBLON2', wa);
    const resp = await host.process('HOC1', wa);
    expect(resp).toContain('HILON HOLIDAY INN');
    expect(resp).toContain('RAC  199.00 GBP');
    expect(resp).toContain('COR  169.00 GBP');
  });

  it('HOC without a display → NO HOTEL DISPLAY; unknown city → NO HOTELS', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    expect(await host.process('HOC1', wa)).toBe('NO HOTEL DISPLAY');
    expect(await host.process('HOA6FEB-09FEBXYZ2', wa)).toBe('NO HOTELS');
  });
});

describe('CAL / CAI — car displays', () => {
  it('CAL<d1>-<d2><city> lists rentals; trailing qualifiers ignored', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('CAL23AUG-25AUGLON/ARR-1P/DT-6P', wa);
    expect(resp).toContain('CAR AVAILABILITY LON 23AUG-25AUG');
    expect(resp).toContain('ZE ECMN');
    expect(wa.lastCarAvail?.days).toBe(2);
  });

  it('CAI<city> lists distinct vendors', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('CAILON', wa);
    expect(resp).toContain('CAR VENDORS LON');
    expect(resp).toContain('ZE');
    expect(resp).toContain('ZD');
  });
});

describe('N-sell display-context disambiguation', () => {
  it('N1A2D3 after HOA sells a hotel (rooms=1, line 2, 3 days)', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('HOA6FEB-09FEBLON2', wa);
    const resp = await host.process('N1A2D3', wa);
    expect(resp).toContain('HOTEL SOLD');
    expect(resp).toContain('HHL MC'); // line 2 = Marriott
    expect(wa.pnr.hotelSegments).toHaveLength(1);
    expect(wa.pnr.hotelSegments[0].nights).toBe(3);
    expect(wa.pnr.hotelSegments[0].rooms).toBe(1);
  });

  it('N1A4 after CAL sells a car from line 4', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('CAL23AUG-25AUGLON', wa);
    const resp = await host.process('N1A4', wa);
    expect(resp).toContain('CAR SOLD');
    expect(resp).toContain('CCR ZD'); // line 4 = Budget ECMN
    expect(wa.pnr.carSegments).toHaveLength(1);
  });

  it('a later air availability clears the aux display — N1Y1 sells air', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('HOA6FEB-09FEBLON2', wa);
    await host.process('A15JULJFKLAX', wa);
    const resp = await host.process('N1Y1', wa);
    expect(resp).toContain('B6 615');
    expect(wa.pnr.segments).toHaveLength(1);
    expect(wa.pnr.hotelSegments).toHaveLength(0);
  });

  it('HOA and CAL displays replace each other', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('HOA6FEB-09FEBLON2', wa);
    await host.process('CAL23AUG-25AUGLON', wa);
    expect(wa.lastHotelAvail).toBeUndefined();
    const resp = await host.process('N1A1', wa);
    expect(resp).toContain('CAR SOLD');
  });

  it('invalid line → INVALID LINE', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('HOA6FEB-09FEBLON2', wa);
    expect(await host.process('N1A99', wa)).toBe('INVALID LINE');
  });
});

describe('Apollo passthrough', () => {
  it('HOA + N1A1D2 work unchanged under ApolloDialect', async () => {
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: 'AB' });
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    expect(await host.process('HOA6FEB-09FEBNYC2', wa)).toContain('HOTEL AVAILABILITY NYC');
    expect(await host.process('N1A1D2', wa)).toContain('HOTEL SOLD');
    expect(wa.pnr.hotelSegments).toHaveLength(1);
  });
});

/**
 * Direct sell — Mini Format Guide v2 p.47/49 ("Direct sell car/hotel",
 * H/0CCR, H/0HTL). Needs NO availability, and the typed status (MK
 * passive / HK active) rides onto the segment — the way an agent adds a
 * hotel/car booked outside the GDS, or builds in an unloaded market.
 */
describe('0HTL / 0CCR — direct sell (passive/active, no availability)', () => {
  it('0HTL builds a passive (MK) hotel from agent data; name keeps its space', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('0HTLICMK1STO10NOV-OUT18NOV/H-STRAND HOTEL/P-10327/R-AIK/BC-I', wa);
    expect(resp).toContain('HOTEL SOLD');
    const h = wa.pnr.hotelSegments[0];
    expect(h.chain).toBe('IC');
    expect(h.status).toBe('MK'); // passive
    expect(h.city).toBe('STO');
    expect(h.checkIn).toBe('10NOV');
    expect(h.checkOut).toBe('18NOV');
    expect(h.nights).toBe(8);
    expect(h.name).toBe('STRAND HOTEL'); // space preserved
    expect(h.property).toBe('10327');
    expect(h.rateCode).toBe('AIK');
  });

  it('0CCR builds a car (any market, no availability)', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('0CCRZEHK1LAX10NOV-12NOVICAR/RC-BEST', wa);
    expect(resp).toContain('CAR SOLD');
    const c = wa.pnr.carSegments[0];
    expect(c.company).toBe('ZE');
    expect(c.status).toBe('HK');
    expect(c.city).toBe('LAX');
    expect(c.vehicleType).toBe('ICAR');
    expect(c.rateCode).toBe('BEST');
    expect(c.days).toBe(2);
  });

  it('builds a full multi-content BF: air + passive hotel + passive car → E', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa); // air HK from availability
    await host.process('0HTLHNMK1LAX15JUN-OUT18JUN/H-HILTON LAX', wa); // passive hotel
    await host.process('0CCRZEMK1LAX18JUN-20JUNICAR', wa); // passive car
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    const locator = (await host.process('E', wa)).trim();
    expect(locator).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('Apollo inherits direct sell via the shared Galileo dispatch', async () => {
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: 'AB' });
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    expect(await host.process('0HTLICMK1STO10NOV-OUT18NOV/H-STRAND HOTEL', wa)).toContain('HOTEL SOLD');
    expect(wa.pnr.hotelSegments[0].status).toBe('MK');
  });
});
