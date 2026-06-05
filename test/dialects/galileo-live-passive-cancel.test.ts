import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo live @<n>XK — passive cancel via /cancelitems', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

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
                      { Product: [{ productRef: 'p0' }], FareDetail: [{ BookingCode: { code: 'Y', count: 9 } }] },
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

  const createWb = () =>
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-X' } } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  const ok = () =>
    new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });

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

  it('@1XK during build POSTs CancelSelectedOffers with sendPassiveNotificationInd:true', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok()) // addOffer
      .mockResolvedValueOnce(ok()); // cancelitems (passive)

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    expect(wa.pnr.segments.length).toBe(1);
    const resp = await host.process('@1XK', wa);
    expect(resp).toBe('ITINERARY CANCELLED');
    expect(wa.pnr.segments.length).toBe(0);

    const [cancelUrl, cancelInit] = fetchSpy.mock.calls[4];
    expect(cancelUrl).toContain('/book/reservationworkbench/WB-X/reservations/cancelitems');
    const body = JSON.parse((cancelInit?.body as string) ?? '{}');
    expect(body['@type']).toBe('CancelRequest');
    expect(body.cancelOffers?.objectType).toBe('CancelSelectedOffers');
    expect(body.cancelOffers?.offerProductSelection).toEqual([
      {
        sendPassiveNotificationInd: true,
        offerID: { Identifier: { authority: 'Travelport', value: 'OFF-001' } },
      },
    ]);
  });

  it('@<out-of-range>XK rejects BEFORE any REST call', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok());

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    expect(await host.process('@99XK', wa)).toBe('SEGMENT NUMBER NOT IN ITINERARY');
    expect(fetchSpy).toHaveBeenCalledTimes(4); // token, search, workbench, addOffer
  });

  it('REST failure surfaces as LIVE BACKEND ERROR; local segments untouched', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(
        new Response('"workbench expired"', { status: 410, statusText: 'Gone' })
      );

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    const resp = await host.process('@1XK', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('410');
    expect(wa.pnr.segments.length).toBe(1); // not cleared on failure
  });
});
