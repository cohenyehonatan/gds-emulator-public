import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo live N. — multi-pax routes to /travelers/list batch endpoint', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const searchResp = () =>
    new Response(
      JSON.stringify({
        CatalogProductOfferingsResponse: {
          CatalogProductOfferings: {
            CatalogProductOffering: [
              {
                Identifier: { value: 'OFF-001' },
                ProductBrandOptions: [
                  {
                    Flight: [
                      {
                        carrier: 'UA',
                        number: 1234,
                        Departure: { location: 'DEN', time: '2026-06-27T08:00:00Z' },
                        Arrival: { location: 'FRA', time: '2026-06-28T07:30:00Z' },
                      },
                    ],
                    ProductBrandOffering: [
                      { FareDetail: [{ BookingCode: { code: 'Y', count: 9 } }] },
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
  const createWb = () =>
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-MP' } } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  const ok = () =>
    new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const travelerListResp = (ids: string[]) =>
    new Response(
      JSON.stringify({
        TravelerListResponse: {
          Traveler: ids.map((id, i) => ({
            Identifier: { authority: 'Travelport', value: id },
            PersonName: { Given: i === 0 ? 'JOHN' : 'JANE', Surname: 'SMITH' },
          })),
        },
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend({
      clientId: 'x',
      clientSecret: 'y',
      username: 'z',
      password: 'w',
    });
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
      backend,
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });

  afterEach(() => fetchSpy.mockRestore());

  it('N.SMITH/JOHN MR/JANE MRS — 2 pax post in ONE call to /travelers/list (not 2)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                                // addOffer
      .mockResolvedValueOnce(travelerListResp(['uuid-1', 'uuid-2'])); // addTravelers (batch)

    await host.process('A27JUNDENFRA', wa);
    await host.process('N2Y1', wa);
    await host.process('N.SMITH/JOHN MR/JANE MRS', wa);

    // Exactly 5 calls — token, search, createWb, addOffer, addTravelers.
    // Critically NOT 6 (which would mean we made two separate addTraveler calls).
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    // Verify the batch call hit /travelers/list with the canonical body.
    const [url, init] = fetchSpy.mock.calls[4];
    expect(url).toContain('/travelers/list');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.TravelerListRequest?.['@type']).toBe('TravelerListRequest');
    expect(body.TravelerListRequest?.Traveler).toHaveLength(2);
    expect(body.TravelerListRequest?.Traveler?.[0]?.PersonName?.Given).toContain('JOHN');
    expect(body.TravelerListRequest?.Traveler?.[1]?.PersonName?.Given).toContain('JANE');
    expect(body.TravelerListRequest?.Traveler?.[0]?.PersonName?.Surname).toBe('SMITH');
    expect(body.TravelerListRequest?.Traveler?.[1]?.PersonName?.Surname).toBe('SMITH');

    // Both UUIDs captured in order on wa.liveTravelerIds.
    expect(wa.liveTravelerIds).toEqual(['uuid-1', 'uuid-2']);
  });

  it('Single-pax N. uses the simpler /travelers (object body, not array)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Traveler: {
              Identifier: { authority: 'Travelport', value: 'uuid-single' },
              PersonName: { Given: 'JOHN', Surname: 'SMITH' },
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      );

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);

    const [url, init] = fetchSpy.mock.calls[4];
    expect(url).toContain('/travelers');
    expect(url).not.toContain('/travelers/list');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.Traveler).toBeDefined();
    expect(body.Traveler?.PersonName?.Given).toContain('JOHN'); // object shape
    expect(Array.isArray(body.Traveler)).toBe(false);

    expect(wa.liveTravelerIds).toEqual(['uuid-single']);
  });

  it('Multi-pax batch failure surfaces LIVE BACKEND ERROR; no liveTravelerIds captured', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(
        new Response('"limit exceeded"', { status: 400, statusText: 'Bad Request' })
      );

    await host.process('A27JUNDENFRA', wa);
    await host.process('N2Y1', wa);
    const resp = await host.process('N.SMITH/JOHN MR/JANE MRS', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('400');
    expect(wa.liveTravelerIds).toBeUndefined();
  });

  it('Multi-pax response without Identifiers still aligns indexes with input', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            TravelerListResponse: {
              Traveler: [
                { PersonName: { Given: 'JOHN' } }, // no Identifier
                { PersonName: { Given: 'JANE' } }, // no Identifier
              ],
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      );

    await host.process('A27JUNDENFRA', wa);
    await host.process('N2Y1', wa);
    await host.process('N.SMITH/JOHN MR/JANE MRS', wa);

    // Empty strings as placeholders to keep alignment with pnr.names.
    expect(wa.liveTravelerIds).toEqual(['', '']);
  });

  it('Two consecutive N. entries accumulate in liveTravelerIds — first batch, then single', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                                // addOffer
      .mockResolvedValueOnce(travelerListResp(['uuid-A', 'uuid-B'])) // N.SMITH/JOHN/JANE → batch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Traveler: {
              Identifier: { authority: 'Travelport', value: 'uuid-C' },
              PersonName: { Given: 'CARL', Surname: 'JONES' },
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        ) // N.JONES/CARL → singular
      );

    await host.process('A27JUNDENFRA', wa);
    await host.process('N3Y1', wa);
    await host.process('N.SMITH/JOHN MR/JANE MRS', wa);
    await host.process('N.JONES/CARL MR', wa);

    expect(wa.liveTravelerIds).toEqual(['uuid-A', 'uuid-B', 'uuid-C']);
  });
});
