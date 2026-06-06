import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo live OSI — POST to /reservationcomments/list', () => {
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
  const createWb = () =>
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-OSI' } } }), {
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

  it('SI.KL*VIP STONE in live workbench POSTs canonical Supplier comment', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())  // addOffer
      .mockResolvedValueOnce(ok()); // addReservationComment (OSI)

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    expect(wa.liveWorkbenchId).toBe('WB-OSI');

    const resp = await host.process('SI.KL*VIP STONE', wa);
    expect(resp).toContain('KL');
    expect(resp).toContain('VIP STONE');

    const [url, init] = fetchSpy.mock.calls[4];
    expect(url).toContain('/reservationcomments/list');
    const body = JSON.parse((init?.body as string) ?? '{}');
    const c = body.ReservationComment?.[0];
    expect(c).toBeDefined();
    expect(c['@type']).toBe('ReservationComment');
    expect(c.commentSource).toBe('Supplier');
    expect(c.shareWithSupplier).toEqual(['KL']);
    expect(c.Comment).toEqual([{ id: 'comment_1', name: 'Vendor Remarks', value: 'VIP STONE' }]);
  });

  it('SI.YY*1 CHD AGED 5 — YY (all airlines) goes through the same path', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('SI.YY*1 CHD AGED 5', wa);

    const [, init] = fetchSpy.mock.calls[4];
    const body = JSON.parse((init?.body as string) ?? '{}');
    const c = body.ReservationComment?.[0];
    expect(c.shareWithSupplier).toEqual(['YY']);
    expect(c.Comment[0]).toEqual({ id: 'comment_1', name: 'Vendor Remarks', value: '1 CHD AGED 5' });
  });

  it('live failure surfaces LIVE BACKEND ERROR; local pnr.osis NOT pushed', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(
        new Response('"down"', { status: 503, statusText: 'Service Unavailable' })
      );

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    const resp = await host.process('SI.UA*RUSH TICKETING', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(wa.pnr.osis).toHaveLength(0);
  });

  it('SI.<carrier>*<text> outside a workbench stays local-only — no fetch', async () => {
    expect(wa.liveWorkbenchId).toBeUndefined();
    const resp = await host.process('SI.YY*INFORMATIONAL', wa);
    expect(resp).toContain('YY');
    expect(wa.pnr.osis).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
