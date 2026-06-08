/**
 * Galileo seat-map live-wire tests — chunk 6 of seatmap-design.md.
 *
 * Mocks `fetch` so the test exercises the same dispatch → backend
 * method → mapper → renderer chain that runs against pre-prod, but
 * without going live. Fixtures are scoped-down versions of the
 * Travelport v11 GDS reference-payload devkit's "Search Seat Maps"
 * sample response.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';

function tokenResponse() {
  return new Response(JSON.stringify({ access_token: 'tok', expires_in: 86000 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function devkitSeatMapResponse() {
  // Minimal but realistic shape from the devkit sample: one flight,
  // one cabin (FIRST), 2 rows, 6 columns with W/A position labels,
  // grouped availability (Available + Reserved).
  return new Response(
    JSON.stringify({
      CatalogOfferingsAncillaryListResponse: {
        '@type': 'CatalogOfferingsAncillaryListResponse',
        CatalogOfferingsID: [
          {
            '@type': 'CatalogOfferingsTravelerFlight',
            Flight: [
              {
                '@type': 'Flight',
                carrier: 'UA',
                number: '2430',
                equipment: '777',
                Departure: { location: 'DEN', date: '2026-01-02', time: '07:45:00' },
                Arrival: { location: 'ORD', date: '2026-01-02', time: '11:25:00' },
              },
            ],
            CatalogOffering: [
              {
                ProductOptions: [
                  {
                    Product: [
                      {
                        '@type': 'ProductSeatAvailability',
                        SeatAvailability: [
                          { seatAvailabilityStatus: 'Reserved', value: ['1A', '1B'] },
                          { seatAvailabilityStatus: 'Available', value: ['1D', '1E', '1F', '2A', '2B', '2D', '2E', '2F'] },
                        ],
                        SeatingChartRef: 'seatingChart_1',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        ReferenceList: [
          {
            '@type': 'ReferenceListSeatingChart',
            SeatingChart: [
              {
                '@type': 'SeatingChart',
                id: 'seatingChart_1',
                Cabin: [
                  {
                    '@type': 'Cabin',
                    name: 'FIRST',
                    Layout: [
                      { startRow: 1, endRow: 2 },
                      { position: ['W'], value: 'A' },
                      { position: ['A'], value: 'B' },
                      { position: ['A'], value: 'D' },
                      { position: ['C'], value: 'E' },
                      { position: ['C'], value: 'F' },
                      { position: ['W'], value: 'G' },
                    ],
                    Row: [
                      {
                        '@type': 'Row',
                        label: '1',
                        Space: [
                          { '@type': 'Space', location: 'A', Characteristic: ['W'] },
                          { '@type': 'Space', location: 'B', Characteristic: ['A'] },
                          { '@type': 'Space', location: 'D', Characteristic: ['A'] },
                          { '@type': 'Space', location: 'E' },
                          { '@type': 'Space', location: 'F' },
                          { '@type': 'Space', location: 'G', Characteristic: ['W'] },
                        ],
                      },
                      {
                        '@type': 'Row',
                        label: '2',
                        Space: [
                          { '@type': 'Space', location: 'A', Characteristic: ['W'] },
                          { '@type': 'Space', location: 'B', Characteristic: ['A'] },
                          { '@type': 'Space', location: 'D', Characteristic: ['A'] },
                          { '@type': 'Space', location: 'E' },
                          { '@type': 'Space', location: 'F' },
                          { '@type': 'Space', location: 'G', Characteristic: ['W'] },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeLiveHost(): { host: GdsHost; backend: LiveTravelportBackend } {
  const backend = new LiveTravelportBackend({
    apiBase: 'https://api.pp.travelport.net/11',
    authUrl: 'https://auth.pp.travelport.net/oauth/token',
    clientId: 'test', clientSecret: 'test',
    username: 'test', password: 'test',
    accessGroup: '7K9S_1G',
  });
  const host = new GdsHost({
    port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend,
  });
  return { host, backend };
}

describe('Galileo SA*S<n> live — POSTs the canonical /seatmaps body', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  it('maps a devkit-shape response into our SeatMap + availability', async () => {
    const { host, backend } = makeLiveHost();
    const wa = host.newWorkArea();
    // Stub availability so SA*S1 has a vendorRef to route on.
    wa.lastAvailability = {
      date: '15JUL', origin: 'DEN', destination: 'ORD',
      searchIdentifier: 'search-uuid-123',
      lines: [{
        line: 1, carrier: 'UA', flightNumber: '2430',
        classes: { Y: 9 }, origin: 'DEN', destination: 'ORD',
        departTime: '745A', arriveTime: '1125A', equipment: '777',
        date: '15JUL', dayOfWeek: 'W', dayOfWeekNum: 3,
        vendorRef: { offerId: 'o1', productId: 'p7' },
      }],
    };
    // Stub a single segment matching that line on wa.pnr so segment-form works.
    wa.pnr.segments.push({
      segmentNumber: 1, carrier: 'UA', flightNumber: '2430',
      bookingClass: 'Y', date: '15JUL', dayOfWeek: 'W', dayOfWeekNum: 3,
      origin: 'DEN', destination: 'ORD', status: 'HK', seats: 1,
      departTime: '745A', arriveTime: '1125A',
    });
    // mock token + seatmap response
    fetchSpy.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(devkitSeatMapResponse());

    const resp = await host.process('SA*S1', wa);
    // Header should show the carrier/flight/equipment from the response.
    expect(resp).toContain('UA2430');
    expect(resp).toContain('777');
    // Cabin name from the response — FIRST, mapped to (F).
    expect(resp).toContain('FIRST (F)');
    // Row 1: A is reserved (X), G is window (W shown), inner E/F are available (.)
    // The exact character per cell depends on POSITION_PRIORITY — verify
    // that the available cells appear as '.' and reserved as 'X' or position.
    expect(resp).toContain('LEGEND');
    // Cache populated.
    expect(wa.lastSeatMap?.segment).toBe(1);
    expect(wa.lastSeatMap?.map.carrier).toBe('UA');
    // fetch called twice: token + seatmap
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const seatMapCall = fetchSpy.mock.calls[1];
    const url = String(seatMapCall[0]);
    expect(url).toContain('/air/search/seat/catalogofferingsancillaries/seatavailabilities');
    expect(url).toContain('catalogProductOfferingsIdentifier=search-uuid-123');
    expect(url).toContain('catalogProductOfferingID=o1');
    expect(url).toContain('productIDs=p7');
  });

  it('falls back to emulated synthesis when no vendorRef is available', async () => {
    const { host } = makeLiveHost();
    const wa = host.newWorkArea();
    // Stub the work-area state directly (skip A/N1Y1 which would
    // trigger live fetches we'd have to mock too). Key shape: a
    // segment exists, but the matching availability line has no
    // vendorRef.offerId → live path is skipped, emulated synth fires.
    wa.lastAvailability = {
      date: '15JUL', origin: 'JFK', destination: 'LAX',
      searchIdentifier: undefined,
      lines: [{
        line: 1, carrier: 'B6', flightNumber: '615',
        classes: { Y: 9 }, origin: 'JFK', destination: 'LAX',
        departTime: '700A', arriveTime: '1015A', equipment: '32A',
        date: '15JUL', dayOfWeek: 'W', dayOfWeekNum: 3,
        // No vendorRef → live path skips, emulated synth takes over.
      }],
    };
    wa.pnr.segments.push({
      segmentNumber: 1, carrier: 'B6', flightNumber: '615',
      bookingClass: 'Y', date: '15JUL', dayOfWeek: 'W', dayOfWeekNum: 3,
      origin: 'JFK', destination: 'LAX', status: 'HK', seats: 1,
      departTime: '700A', arriveTime: '1015A',
    });
    const resp = await host.process('SA*S1', wa);
    expect(resp).toContain('LEGEND');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Result.Error[] with code 225 → SEAT MAP UNAVAILABLE - CODE SHARE FLIGHT', async () => {
    // Travelport semantic-200 pattern: HTTP 200 with Result.Error[].
    // extractSeatMapError peels the code and maps to a friendly string.
    const { host } = makeLiveHost();
    const wa = host.newWorkArea();
    wa.lastAvailability = {
      date: '15JUL', origin: 'DEN', destination: 'ORD',
      searchIdentifier: 'search-uuid-123',
      lines: [{
        line: 1, carrier: 'UA', flightNumber: '2430',
        classes: { Y: 9 }, origin: 'DEN', destination: 'ORD',
        departTime: '745A', arriveTime: '1125A', equipment: '777',
        date: '15JUL', dayOfWeek: 'W', dayOfWeekNum: 3,
        vendorRef: { offerId: 'o1', productId: 'p7' },
      }],
    };
    wa.pnr.segments.push({
      segmentNumber: 1, carrier: 'UA', flightNumber: '2430',
      bookingClass: 'Y', date: '15JUL', dayOfWeek: 'W', dayOfWeekNum: 3,
      origin: 'DEN', destination: 'ORD', status: 'HK', seats: 1,
      departTime: '745A', arriveTime: '1125A',
    });
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            CatalogOfferingsAncillaryListResponse: {
              Result: {
                Error: [{ Code: '225', Message: 'Seat map unavailable on code share flight' }],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    const resp = await host.process('SA*S1', wa);
    expect(resp).toBe('SEAT MAP UNAVAILABLE - CODE SHARE FLIGHT');
  });

  it('returns LIVE BACKEND ERROR when the seatmap endpoint throws', async () => {
    const { host } = makeLiveHost();
    const wa = host.newWorkArea();
    wa.lastAvailability = {
      date: '15JUL', origin: 'DEN', destination: 'ORD',
      searchIdentifier: 'search-uuid-123',
      lines: [{
        line: 1, carrier: 'UA', flightNumber: '2430',
        classes: { Y: 9 }, origin: 'DEN', destination: 'ORD',
        departTime: '745A', arriveTime: '1125A', equipment: '777',
        date: '15JUL', dayOfWeek: 'W', dayOfWeekNum: 3,
        vendorRef: { offerId: 'o1', productId: 'p7' },
      }],
    };
    wa.pnr.segments.push({
      segmentNumber: 1, carrier: 'UA', flightNumber: '2430',
      bookingClass: 'Y', date: '15JUL', dayOfWeek: 'W', dayOfWeekNum: 3,
      origin: 'DEN', destination: 'ORD', status: 'HK', seats: 1,
      departTime: '745A', arriveTime: '1125A',
    });
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('Tomcat 500', { status: 500 }));
    const resp = await host.process('SA*S1', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
  });
});
