import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { mapHotelSearch } from '../../src/backends/travelport-mapper.js';
import type { WorkArea } from '../../src/session/work-area.js';

/**
 * Live HOA via the Travelport Stays API v11 (chunk 2 of
 * docs/live-stays-wiring.md). The request body is verified against the
 * Stays v11.34 spec AND pre-prod (7K9S accepts it); the RESPONSE mapping
 * is spec-derived (the trial tenant 500s on hotel content), so these
 * tests exercise the wiring + mapper against mocked spec-shaped responses.
 */

// Spec-shaped PropertiesResponse (the search 200 body, PropertiesResponseWrapper):
// Properties.PropertyInfo[].{Property: PropertyDetail, LowestAvailableRate}.
const PROPS_RESPONSE = {
  PropertiesResponse: {
    Properties: {
      '@type': 'Properties',
      PropertyInfo: [
        {
          '@type': 'PropertyInfo',
          availability: 'Available',
          LowestAvailableRate: { value: 189, code: 'EUR' },
          Property: {
            '@type': 'PropertyDetail',
            PropertyKey: { chainCode: 'HN', propertyCode: 'PAR1' },
            name: 'HILTON PARIS OPERA',
            Address: { City: 'PAR', AddressLine: ['108 RUE SAINT-LAZARE'] },
          },
        },
        {
          '@type': 'PropertyInfo',
          LowestAvailableRate: { value: 145, code: 'EUR' },
          Property: {
            '@type': 'PropertyDetail',
            PropertyKey: { chainCode: 'HI', propertyCode: 'PAR2' },
            name: 'HOLIDAY INN PARIS OPERA',
            Address: { City: 'PAR' },
          },
        },
      ],
    },
  },
};

describe('mapHotelSearch — Stays PropertiesResponse → HotelProperty[]', () => {
  it('maps PropertyInfo[].Property (PropertyKey + name + city) + LowestAvailableRate', () => {
    const props = mapHotelSearch(PROPS_RESPONSE, 'PAR');
    expect(props).toHaveLength(2);
    expect(props[0].chain).toBe('HN');
    expect(props[0].property).toBe('PAR1');
    expect(props[0].name).toBe('HILTON PARIS OPERA');
    expect(props[0].city).toBe('PAR');
    expect(props[0].address).toBe('108 RUE SAINT-LAZARE');
    expect(props[0].rates[0]).toMatchObject({ amount: 189, currency: 'EUR' });
  });

  it('a property with no LowestAvailableRate maps to empty rates (→ HOA shows RQ)', () => {
    const r = { PropertiesResponse: { Properties: { PropertyInfo: [
      { Property: { PropertyKey: { chainCode: 'MC', propertyCode: 'X' }, name: 'M HOTEL', Address: { City: 'PAR' } } },
    ] } } };
    expect(mapHotelSearch(r, 'PAR')[0].rates).toHaveLength(0);
  });

  it('falls back to the searched city when Address.City is absent', () => {
    const r = { PropertiesResponse: { Properties: { PropertyInfo: [
      { Property: { PropertyKey: { chainCode: 'HN', propertyCode: 'Y' }, name: 'N' } },
    ] } } };
    expect(mapHotelSearch(r, 'LON')[0].city).toBe('LON');
  });
});

describe('Galileo live HOA — Stays hotel search', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;
  const tokenResp = () =>
    new Response(JSON.stringify({ access_token: 'T', token_type: 'Bearer', expires_in: 3600 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  const searchResp = (body: unknown = PROPS_RESPONSE) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend({ clientId: 'x', clientSecret: 'y', username: 'z', password: 'w' });
    host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });
  afterEach(() => fetchSpy.mockRestore());

  it('HOA hits /hotel/search/properties/search with ISO dates + renders the live list', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(searchResp());
    const resp = await host.process('HOA6FEB-09FEBPAR2', wa);
    expect(resp).toContain('HOTEL AVAILABILITY PAR');
    expect(resp).toContain('HILTON PARIS OPERA');
    expect(resp).toContain('189EUR');

    // The request: verified endpoint + body shape + DDMON→ISO conversion.
    const [url, init] = fetchSpy.mock.calls[1];
    expect(String(url)).toContain('/hotel/search/properties/search');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.PropertiesQuerySearch['@type']).toBe('PropertiesQuerySearch');
    expect(body.PropertiesQuerySearch.SearchBy.SearchAirport).toBe('PAR');
    expect(body.PropertiesQuerySearch.CheckInDate).toMatch(/^\d{4}-02-06$/);
    expect(body.PropertiesQuerySearch.CheckOutDate).toMatch(/^\d{4}-02-09$/);
    expect(body.PropertiesQuerySearch.RoomStayCandidate[0].GuestCounts.GuestCount[0].count).toBe(2);

    // Cached for the follow-on reference sell, just like the emulated path.
    expect(wa.lastHotelAvail?.properties).toHaveLength(2);
  });

  it('a live search with no properties → NO HOTELS', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(
      searchResp({ PropertiesResponse: { Properties: { PropertyInfo: [] } } })
    );
    expect(await host.process('HOA6FEB-09FEBPAR2', wa)).toBe('NO HOTELS');
  });

  it('a property lacking a rate renders RQ (rate on request), not Infinity', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(
      searchResp({ PropertiesResponse: { Properties: { PropertyInfo: [
        { Property: { PropertyKey: { chainCode: 'MC', propertyCode: 'P' }, name: 'MARRIOTT PARIS', Address: { City: 'PAR' } } },
      ] } } })
    );
    const resp = await host.process('HOA6FEB-09FEBPAR2', wa);
    expect(resp).toContain('MARRIOTT PARIS');
    expect(resp).toContain('RQ');
    expect(resp).not.toContain('Infinity');
  });
});
