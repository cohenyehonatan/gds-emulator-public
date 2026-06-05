import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend, liveTravelportFromEnv } from '../../src/backends/live-travelport-backend.js';

/**
 * Galileo dialect ↔ LiveTravelportBackend integration. The first group
 * mocks `fetch` to prove the wiring routes through airSearch + the
 * response mapper without hitting the network. The second group is
 * gated on TVP_CLIENT_ID etc. — runs ONLY when the user has provided
 * live pre-prod credentials in their shell, mirroring the spike's
 * one-call-per-run discipline.
 */

describe('Galileo dialect ↔ LiveTravelportBackend (mocked fetch)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;

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
                      {
                        Product: [{ productRef: 'p0' }], FareDetail: [
                          { FareBasis: 'YPRO', BookingCode: { code: 'Y', count: 9 } },
                        ],
                      },
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

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(searchResponse());
    const backend = new LiveTravelportBackend({
      clientId: 'x', clientSecret: 'y', username: 'z', password: 'w',
    });
    host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend,
    });
    const wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
    (host as any).__wa = wa;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('A<DDMMM><orig><dest> routes through airSearch when backend is LiveTravelportBackend', async () => {
    const wa = (host as any).__wa;
    const resp = await host.process('A27JUNDENFRA', wa);
    // The mapper output goes through the same renderGalileoAvailability path
    // as the EmulatedBackend, so the response shape is identical.
    expect(resp).toContain('DEN-FRA');
    expect(resp).toContain('UA');
    expect(resp).toContain('1234');
    expect(resp).toContain('0800');
    expect(resp).toContain('Y9');
    // Two fetch calls: one for OAuth, one for the search.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('a 401 from live search bubbles up as LIVE BACKEND ERROR', async () => {
    // Override the search response (second fetch) with a 401.
    fetchSpy.mockReset();
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response('{"error":"forbidden"}', { status: 401, statusText: 'Unauthorized' })
      );
    const wa = (host as any).__wa;
    const resp = await host.process('A27JUNDENFRA', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('401');
  });

  it('availability is still cached on the work area so a follow-up N<seats><class><line> resolves', async () => {
    const wa = (host as any).__wa;
    await host.process('A27JUNDENFRA', wa);
    expect(wa.lastAvailability).toBeDefined();
    expect(wa.lastAvailability!.lines.length).toBeGreaterThan(0);
    expect(wa.lastAvailability!.origin).toBe('DEN');
    expect(wa.lastAvailability!.destination).toBe('FRA');
  });
});

/**
 * Live integration — runs ONLY when TVP_CLIENT_ID + TVP_CLIENT_SECRET +
 * TVP_USERNAME + TVP_PASSWORD are all set in the shell. One call per
 * test, matching the spike's no-retry-no-probing discipline. To run:
 *
 *   export TVP_CLIENT_ID=... TVP_CLIENT_SECRET=...
 *   export TVP_USERNAME=...  TVP_PASSWORD=...
 *   npx vitest run test/dialects/galileo-live-availability.test.ts
 */
const RUN_LIVE =
  !!process.env.TVP_CLIENT_ID &&
  !!process.env.TVP_CLIENT_SECRET &&
  !!process.env.TVP_USERNAME &&
  !!process.env.TVP_PASSWORD;

describe.skipIf(!RUN_LIVE)('Galileo dialect ↔ LiveTravelportBackend (live, 7K9S pre-prod)', () => {
  it('A<DDMMM>DENFRA returns flights from the live TripServices API', async () => {
    const backend = liveTravelportFromEnv();
    expect(backend).toBeDefined();
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend,
    });
    const wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
    // Use a date ~30 days out to avoid sandbox no-availability windows.
    const future = new Date();
    future.setDate(future.getDate() + 30);
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const tok = `${future.getDate()}${months[future.getMonth()]}`;
    const resp = await host.process(`A${tok}DENFRA`, wa);
    // Either we get a real DEN-FRA display, or NO FLIGHTS (sandbox is variable).
    expect(['NO FLIGHTS'].includes(resp) || resp.includes('DEN-FRA')).toBe(true);
  }, 30_000);
});
