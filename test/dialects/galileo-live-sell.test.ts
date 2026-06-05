import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

/**
 * Live-sell wiring: A<DDMMM><orig><dest> → cached AvailabilityLine with
 * vendorRef.offerId → N1Y1 → createWorkbench + addOffer against TripServices.
 * Fetch is mocked end-to-end; the live integration is exercised manually
 * via TVP_CLIENT_ID etc. (see galileo-live-availability.test.ts for that
 * pattern).
 */

describe('Galileo live sell (mocked fetch chain)', () => {
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
                Identifier: { value: 'OFF-7K9S-001' },
                ProductBrandOptions: [
                  {
                    Identifier: { value: 'PRD-001' },
                    Flight: [
                      {
                        carrier: 'UA',
                        number: 1234,
                        Departure: { location: 'DEN', time: '2026-06-27T08:00:00Z' },
                        Arrival: { location: 'FRA', time: '2026-06-28T07:30:00Z' },
                        equipment: '777',
                      },
                    ],
                    ProductBrandOffering: [
                      {
                        Product: [{ productRef: 'p0' }], Identifier: { value: 'BRD-Y' },
                        FareDetail: [{ FareBasis: 'Y', BookingCode: { code: 'Y', count: 9 } }],
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

  function createWorkbenchResponse(id: string): Response {
    return new Response(
      JSON.stringify({ ReservationWorkbench: { Identifier: { value: id } } }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  }

  function addOfferResponse(): Response {
    return new Response(
      JSON.stringify({ ReservationWorkbench: { addedOffers: 1 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend({
      clientId: 'x', clientSecret: 'y', username: 'z', password: 'w',
    });
    host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend,
    });
    wa = host.newWorkArea();
    // SON/ZHA needs no network calls.
    await host.process('SON/ZHA', wa);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('N1Y1 after a live availability creates a workbench and adds the offer', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())              // OAuth
      .mockResolvedValueOnce(searchResponse())             // A27JUNDENFRA
      .mockResolvedValueOnce(createWorkbenchResponse('WB-001'))  // create workbench
      .mockResolvedValueOnce(addOfferResponse());          // add offer

    await host.process('A27JUNDENFRA', wa);
    expect(wa.lastAvailability?.lines[0].vendorRef?.offerId).toBe('OFF-7K9S-001');

    const sellResp = await host.process('N1Y1', wa);
    expect(sellResp).toContain('UA');
    expect(sellResp).toContain('1234');
    expect(wa.pnr.segments.length).toBe(1);
    expect(wa.liveWorkbenchId).toBe('WB-001');

    // Four fetches: token + search + createWorkbench + addOffer
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    // Verify the createWorkbench call:
    const [createUrl] = fetchSpy.mock.calls[2];
    expect(createUrl).toContain('/air/book/session/reservationworkbench');

    // Verify the addOffer call carries the canonical three-ID body
    // (VERIFIED PRE-PROD 2026-06-05): searchIdentifier + offerId +
    // productId, wrapped in OfferQueryBuildFromCatalogProductOfferings.
    const [addUrl, addInit] = fetchSpy.mock.calls[3];
    expect(addUrl).toContain('/reservationworkbench/WB-001/offers/buildfromcatalogofferings');
    const body = JSON.parse((addInit?.body as string) ?? '{}');
    const req = body.OfferQueryBuildFromCatalogProductOfferings?.BuildFromCatalogProductOfferingsRequest;
    expect(req?.['@type']).toBe('BuildFromCatalogProductOfferingsRequestAir');
    expect(req?.CatalogProductOfferingsIdentifier?.Identifier?.value).toBe('SRCH-FIXTURE');
    const selection = req?.CatalogProductOfferingSelection?.[0];
    expect(selection?.CatalogProductOfferingIdentifier?.Identifier?.value).toBe('OFF-7K9S-001');
    expect(selection?.ProductIdentifier?.[0]?.Identifier?.value).toBe('p0');
  });

  it('a second N<seats><class><line> reuses the existing workbench', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWorkbenchResponse('WB-001'))
      .mockResolvedValueOnce(addOfferResponse())
      .mockResolvedValueOnce(addOfferResponse());  // second sell — no second createWorkbench

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N1Y1', wa);  // sell same line again

    expect(wa.liveWorkbenchId).toBe('WB-001');
    expect(fetchSpy).toHaveBeenCalledTimes(5);  // not 6 — no second createWorkbench

    // Confirm second-sell fetch was addOffer, not createWorkbench:
    const [lastUrl] = fetchSpy.mock.calls[4];
    expect(lastUrl).toContain('/offers/buildfromcatalogofferings');
  });

  it('refuses to sell a line whose vendorRef.offerId is missing', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        CatalogProductOfferingsResponse: {
          CatalogProductOfferings: {
            Identifier: { value: 'SRCH-FIXTURE' },
            CatalogProductOffering: [{
              // NO Identifier — vendorRef will be undefined
              ProductBrandOptions: [{
                Flight: [{
                  carrier: 'UA', number: 1234,
                  Departure: { location: 'DEN', time: '2026-06-27T08:00:00Z' },
                  Arrival: { location: 'FRA', time: '2026-06-28T07:30:00Z' },
                }],
                ProductBrandOffering: [{ Product: [{ productRef: 'p0' }], FareDetail: [{ BookingCode: { code: 'Y', count: 9 } }] }],
              }],
            }],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await host.process('A27JUNDENFRA', wa);
    // vendorRef is populated (productRef present) but offerId is missing
    // — sell handler refuses on the offerId check.
    expect(wa.lastAvailability?.lines[0].vendorRef?.offerId).toBeUndefined();

    const sellResp = await host.process('N1Y1', wa);
    expect(sellResp).toBe('LIVE OFFER ID MISSING');
    expect(wa.pnr.segments.length).toBe(0);
    expect(wa.liveWorkbenchId).toBeUndefined();
    // Only 2 fetches happened (token + search) — no createWorkbench attempted.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('surfaces upstream errors as LIVE BACKEND ERROR (createWorkbench fails)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(new Response('"workbench limit exceeded"', { status: 429, statusText: 'Too Many Requests' }));

    await host.process('A27JUNDENFRA', wa);
    const sellResp = await host.process('N1Y1', wa);
    expect(sellResp).toContain('LIVE BACKEND ERROR');
    expect(sellResp).toContain('429');
    expect(wa.liveWorkbenchId).toBeUndefined();  // failed before stashing
    expect(wa.pnr.segments.length).toBe(0);  // segment NOT appended on live failure
  });

  it('IG / reset clears liveWorkbenchId along with the rest of the slot state', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWorkbenchResponse('WB-001'))
      .mockResolvedValueOnce(addOfferResponse());

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    expect(wa.liveWorkbenchId).toBe('WB-001');

    await host.process('I', wa);
    expect(wa.liveWorkbenchId).toBeUndefined();
  });
});
