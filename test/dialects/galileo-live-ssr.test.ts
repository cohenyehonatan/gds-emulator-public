import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo live SI. — POST to /specialservices/list', () => {
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
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-SSR' } } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  const ok = () =>
    new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const travelerResp = (uuid: string) =>
    new Response(
      JSON.stringify({
        Traveler: [
          {
            Identifier: { authority: 'Travelport', value: uuid },
            PersonName: { Given: 'JOHN', Surname: 'SMITH' },
          },
        ],
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

  it('SI.VGML in live workbench POSTs canonical SpecialServiceListRequest', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())  // addOffer
      .mockResolvedValueOnce(ok()); // addSpecialServices

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    expect(wa.liveWorkbenchId).toBe('WB-SSR');

    const resp = await host.process('SI.VGML', wa);
    expect(resp).toContain('VGML');

    const [url, init] = fetchSpy.mock.calls[4];
    expect(url).toContain('/specialservices/list');
    const body = JSON.parse((init?.body as string) ?? '{}');
    const sr = body.SpecialServiceListRequest?.SpecialServiceID?.[0];
    expect(sr).toBeDefined();
    expect(sr['@type']).toBe('SpecialService');
    expect(sr.SSRCode).toBe('VGML');
    expect(sr.Identifier?.authority).toBe('Travelport');
    expect(sr.Identifier?.value).toMatch(/^[0-9a-f]{8}-/); // client-generated UUID
    // AppliesTo populated from cached availability's first offer:
    expect(sr.AppliesTo?.OfferIdentifier?.[0]?.Identifier?.value).toBe('OFF-001');
    // No nameRef on SI.VGML → no TravelerIdentifier:
    expect(sr.TravelerIdentifier).toBeUndefined();
    // No free text:
    expect(sr.FreeText).toBeUndefined();
  });

  it('SI.SPML*NO EGGS includes FreeText in the body', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('SI.SPML*NO EGGS', wa);

    const [, init] = fetchSpy.mock.calls[4];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.SpecialServiceListRequest?.SpecialServiceID?.[0]?.SSRCode).toBe('SPML');
    expect(body.SpecialServiceListRequest?.SpecialServiceID?.[0]?.FreeText).toBe('NO EGGS');
  });

  // Refactor 2026-06-06: addTraveler fires at P. (when both name+phone
  // present); SSR needs liveTravelerIds, so tests now have to add a
  // P. step before the SI. cryptic to ensure the traveler is posted.
  it('SI.P1/WCHR resolves TravelerIdentifier from wa.liveTravelerIds[0]', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                       // addOffer
      .mockResolvedValueOnce(travelerResp('uuid-john'))  // addTraveler (at P.)
      .mockResolvedValueOnce(ok())                       // addPrimaryContact (at P.)
      .mockResolvedValueOnce(ok());                      // addSpecialServices

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    expect(wa.liveTravelerIds).toEqual(['uuid-john']);

    await host.process('SI.P1/WCHR', wa);

    const [, init] = fetchSpy.mock.calls[6];
    const body = JSON.parse((init?.body as string) ?? '{}');
    const sr = body.SpecialServiceListRequest?.SpecialServiceID?.[0];
    expect(sr.SSRCode).toBe('WCHR');
    expect(sr.TravelerIdentifier?.Identifier?.value).toBe('uuid-john');
  });

  it('SI.P1/<code> with no captured traveler ID omits TravelerIdentifier', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(
        // Traveler response without Identifier — UUID isn't captured.
        new Response(JSON.stringify({ Traveler: [{ PersonName: { Given: 'JOHN' } }] }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(ok())  // addPrimaryContact
      .mockResolvedValueOnce(ok()); // SSR

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    // liveTravelerIds has '' for the missing UUID — handler treats
    // that as no ref.
    expect(wa.liveTravelerIds).toEqual(['']);

    await host.process('SI.P1/WCHR', wa);

    const [, init] = fetchSpy.mock.calls[6];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.SpecialServiceListRequest?.SpecialServiceID?.[0]?.TravelerIdentifier).toBeUndefined();
  });

  it('live SSR failure surfaces LIVE BACKEND ERROR; local pnr.ssrs NOT pushed', async () => {
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
    const resp = await host.process('SI.VGML', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(wa.pnr.ssrs).toHaveLength(0);
  });

  it('SI. outside a workbench (no live build) stays local-only — no fetch', async () => {
    expect(wa.liveWorkbenchId).toBeUndefined();
    const resp = await host.process('SI.VGML', wa);
    expect(resp).toContain('VGML');
    expect(wa.pnr.ssrs).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SI.S2/<code> picks the second leg\'s workbench offer UUID', async () => {
    // Manually populate the workbench offer-id array as if two
    // addOffer calls had already run — wb1 for leg 1, wb2 for leg 2.
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())  // addOffer (we'll inject offer IDs)
      .mockResolvedValueOnce(ok()); // SSR

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    // Inject two workbench offer UUIDs as if addOffer had captured
    // them per-leg. (The mocked addOffer above returned `ok()` which
    // doesn't include an OfferListResponse, so the handler captured
    // ['']; overwrite with the per-leg fixture.)
    wa.liveWorkbenchOfferIds = ['wb-offer-LEG-1', 'wb-offer-LEG-2'];

    await host.process('SI.S2/WCHR', wa);

    const [, init] = fetchSpy.mock.calls[4];
    const body = JSON.parse((init?.body as string) ?? '{}');
    const sr = body.SpecialServiceListRequest?.SpecialServiceID?.[0];
    expect(sr.SSRCode).toBe('WCHR');
    expect(sr.AppliesTo?.OfferIdentifier?.[0]?.Identifier?.value).toBe('wb-offer-LEG-2');
  });
});
