import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo TTL<n> parsing', () => {
  it('parses TTL1 as flight_info with source availability + line 1', () => {
    const r = parseGalileoEntry('TTL1');
    expect(r.kind).toBe('flight_info');
    if (r.kind === 'flight_info') {
      expect(r.source).toBe('availability');
      expect(r.lines).toEqual([1]);
    }
  });

  it('parses TTL10 (multi-digit line)', () => {
    const r = parseGalileoEntry('TTL10');
    if (r.kind === 'flight_info') expect(r.lines).toEqual([10]);
  });

  it('rejects TTL0, TTL, and TTL<garbage>', () => {
    expect(() => parseGalileoEntry('TTL0')).toThrow();
    expect(() => parseGalileoEntry('TTL')).toThrow();
    expect(() => parseGalileoEntry('TTLABC')).toThrow();
  });
});

describe('Galileo TTL<n> through the host (emulated)', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S',
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });

  it('TTL with no cached availability returns NO AVAILABILITY DISPLAYED', async () => {
    expect(await host.process('TTL1', wa)).toBe('NO AVAILABILITY DISPLAYED');
  });

  it('TTL<n> after A<date><orig><dest> renders carrier + flight + route + times', async () => {
    await host.process('A15JUNJFKLAX', wa);
    const resp = await host.process('TTL1', wa);
    expect(resp).toContain('FLIGHT');
    expect(resp).toContain('JFK');
    expect(resp).toContain('LAX');
    expect(resp).toContain('15JUN');
  });

  it('TTL99 (out-of-range line) returns FORMAT', async () => {
    await host.process('A15JUNJFKLAX', wa);
    expect(await host.process('TTL99', wa)).toBe('FORMAT');
  });

  it('does NOT show a TVP OFFER line for emulated-backend availability', async () => {
    await host.process('A15JUNJFKLAX', wa);
    const resp = await host.process('TTL1', wa);
    expect(resp).not.toContain('TVP OFFER');
  });
});

describe('Galileo TTL<n> with LiveTravelportBackend (mocked fetch) surfaces vendor IDs', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  function searchResponse(): Response {
    return new Response(
      JSON.stringify({
        CatalogProductOfferingsResponse: {
          CatalogProductOfferings: {
            Identifier: { value: 'SRCH-FIXTURE' },
            CatalogProductOffering: [
              {
                Identifier: { value: 'OFF-7K9S-LIVE-001' },
                ProductBrandOptions: [
                  {
                    Flight: [
                      {
                        carrier: 'UA',
                        number: 1234,
                        Departure: { location: 'DEN', time: '2026-06-27T08:00:00.000-06:00' },
                        Arrival: { location: 'FRA', time: '2026-06-28T07:30:00.000+02:00' },
                        equipment: '777',
                      },
                    ],
                    ProductBrandOffering: [
                      { Product: [{ productRef: 'p0' }], FareDetail: [{ FareBasis: 'Y', BookingCode: { code: 'Y', count: 9 } }] },
                    ],
                  },
                ],
              },
            ],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(searchResponse());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('TTL1 after a live A<date><orig><dest> surfaces TVP OFFER <offerId>', async () => {
    const backend = new LiveTravelportBackend({
      clientId: 'x', clientSecret: 'y', username: 'z', password: 'w',
    });
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend,
    });
    const wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
    await host.process('A27JUNDENFRA', wa);
    const resp = await host.process('TTL1', wa);
    expect(resp).toContain('FLIGHT UA');
    expect(resp).toContain('DEN');
    expect(resp).toContain('FRA');
    expect(resp).toContain('TVP OFFER OFF-7K9S-LIVE-001');
  });
});
