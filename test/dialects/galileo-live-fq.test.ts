import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';
import { mapPricedOffer } from '../../src/backends/travelport-mapper.js';

describe('mapPricedOffer', () => {
  const PRICED_FIXTURE = {
    CatalogProductOfferingsResponse: {
      CatalogProductOfferings: {
        Identifier: { value: 'SRCH-FIXTURE' },
            CatalogProductOffering: [
          {
            ProductBrandOptions: [
              {
                Flight: [{ carrier: 'UA', number: 1234 }],
                ProductBrandOffering: [
                  {
                    Product: [{ productRef: 'p0' }], FareDetail: [{ FareBasis: 'YPRO' }],
                    Price: {
                      currencyCode: 'USD',
                      passengerType: 'ADT',
                      Base: { value: 500 },
                      TotalPrice: { value: 580 },
                      Tax: [
                        { code: 'US', value: 50 },
                        { code: 'XF', value: 30 },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };

  it('extracts the first brand offering into a FareQuote', () => {
    const fq = mapPricedOffer(PRICED_FIXTURE, { departureDate: '27JUN' });
    expect(fq).not.toBeNull();
    expect(fq!.passengers).toHaveLength(1);
    expect(fq!.passengers[0]).toMatchObject({
      passengerType: 'ADT',
      base: 500,
      total: 580,
    });
    expect(fq!.passengers[0].taxes).toHaveLength(2);
    expect(fq!.passengers[0].taxTotal).toBe(80);
    expect(fq!.fareBasis).toEqual(['YPRO']);
    expect(fq!.currency).toBe('USD');
    expect(fq!.departureDate).toBe('27JUN');
    expect(fq!.validatingCarrier).toBe('UA');
  });

  it('returns null for an empty / malformed response', () => {
    expect(mapPricedOffer({})).toBeNull();
    expect(mapPricedOffer(null)).toBeNull();
    expect(mapPricedOffer({
      CatalogProductOfferingsResponse: { CatalogProductOfferings: { Identifier: { value: 'SRCH-FIXTURE' },
            CatalogProductOffering: [] } },
    })).toBeNull();
  });
});

describe('Galileo live FQ — pricing via /price/offers/buildfromcatalogproductofferings', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const ok = () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const createWb = () =>
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-FQ' } } }), {
      status: 201, headers: { 'Content-Type': 'application/json' },
    });
  const searchResp = () =>
    new Response(JSON.stringify({
      CatalogProductOfferingsResponse: {
        CatalogProductOfferings: {
          Identifier: { value: 'SRCH-FIXTURE' },
            CatalogProductOffering: [{
            Identifier: { value: 'OFF-001' },
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
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const priceResp = () =>
    new Response(JSON.stringify({
      CatalogProductOfferingsResponse: {
        CatalogProductOfferings: {
          Identifier: { value: 'SRCH-FIXTURE' },
            CatalogProductOffering: [{
            ProductBrandOptions: [{
              Flight: [{ carrier: 'UA', number: 1234 }],
              ProductBrandOffering: [{
                Product: [{ productRef: 'p0' }], FareDetail: [{ FareBasis: 'YPRO' }],
                Price: {
                  currencyCode: 'USD',
                  passengerType: 'ADT',
                  Base: { value: 500 },
                  TotalPrice: { value: 580 },
                  Tax: [{ code: 'US', value: 80 }],
                },
              }],
            }],
          }],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend({
      clientId: 'x', clientSecret: 'y', username: 'z', password: 'w',
    });
    host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend,
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });

  afterEach(() => fetchSpy.mockRestore());

  it('FQ during build POSTs priceOffer with the cached offer ID', async () => {
    // After 2026-06-06 refactor: N. doesn't fire addTraveler (no phone
    // yet), so the chain is one mock shorter. FQ doesn't depend on
    // traveler-ID state.
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                // addOffer
      .mockResolvedValueOnce(priceResp());        // FQ

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    const resp = await host.process('FQ', wa);

    expect(resp).toContain('FILED FARE 1');
    expect(resp).toContain('ADT');
    expect(resp).toContain('500');  // base
    expect(resp).toContain('580');  // total
    expect(wa.pnr.priceQuotes).toHaveLength(1);
    expect(wa.pnr.priceQuotes[0].validatingCarrier).toBe('UA');

    // priceOffer is at index 4 now (was 5 when addTraveler fired at N.).
    const [priceUrl, priceInit] = fetchSpy.mock.calls[4];
    expect(priceUrl).toContain('/air/price/offers/buildfromcatalogproductofferings');
    const body = JSON.parse((priceInit?.body as string) ?? '{}');
    // Canonical body per devkit Price One-Way (same envelope as addOffer):
    // OfferQueryBuildFromCatalogProductOfferings with the 3-ID triple
    // (searchIdentifier + offerId + productId).
    const req = body.OfferQueryBuildFromCatalogProductOfferings?.BuildFromCatalogProductOfferingsRequest;
    expect(req?.['@type']).toBe('BuildFromCatalogProductOfferingsRequestAir');
    expect(req?.CatalogProductOfferingsIdentifier?.Identifier?.value).toBe('SRCH-FIXTURE');
    const selection = req?.CatalogProductOfferingSelection?.[0];
    expect(selection?.CatalogProductOfferingIdentifier?.Identifier?.value).toBe('OFF-001');
    expect(selection?.ProductIdentifier?.[0]?.Identifier?.value).toBe('p0');
  });

  it('FQ without itinerary / names rejects without any fetch', async () => {
    const r1 = await host.process('FQ', wa);
    expect(r1).toContain('ITINERARY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('FQ live failure (5xx) surfaces as LIVE BACKEND ERROR; no quote filed', async () => {
    // Refactor: no addTraveler at N. anymore — one fewer mock.
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())  // addOffer
      .mockResolvedValueOnce(new Response('"down"', { status: 503, statusText: 'Service Unavailable' }));

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    const resp = await host.process('FQ', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(wa.pnr.priceQuotes).toHaveLength(0);
  });

  it('FQ multi-offer: two priceOffer calls (one per offer), merged into one quote', async () => {
    // Search response with TWO distinct offerings — one per segment.
    const twoOfferSearch = () =>
      new Response(JSON.stringify({
        CatalogProductOfferingsResponse: {
          CatalogProductOfferings: {
            Identifier: { value: 'SRCH-FIXTURE' },
            CatalogProductOffering: [
              {
                Identifier: { value: 'OFF-A' },
                ProductBrandOptions: [{
                  Flight: [{ carrier: 'UA', number: 1234, Departure: { location: 'DEN', time: '2026-06-27T08:00:00Z' }, Arrival: { location: 'FRA', time: '2026-06-28T07:30:00Z' } }],
                  ProductBrandOffering: [{ Product: [{ productRef: 'pA' }], FareDetail: [{ BookingCode: { code: 'Y', count: 9 } }] }],
                }],
              },
              {
                Identifier: { value: 'OFF-B' },
                ProductBrandOptions: [{
                  Flight: [{ carrier: 'LH', number: 5678, Departure: { location: 'FRA', time: '2026-06-30T10:00:00Z' }, Arrival: { location: 'DEN', time: '2026-06-30T18:00:00Z' } }],
                  ProductBrandOffering: [{ Product: [{ productRef: 'pB' }], FareDetail: [{ BookingCode: { code: 'Y', count: 9 } }] }],
                }],
              },
            ],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const priceForOffer = (basis: string, base: number, tax: number) =>
      new Response(JSON.stringify({
        CatalogProductOfferingsResponse: {
          CatalogProductOfferings: {
            CatalogProductOffering: [{
              ProductBrandOptions: [{
                Flight: [{ carrier: 'UA', number: 1234 }],
                ProductBrandOffering: [{
                  Product: [{ productRef: 'pA' }],
                  FareDetail: [{ FareBasis: basis }],
                  Price: {
                    currencyCode: 'USD',
                    passengerType: 'ADT',
                    Base: { value: base },
                    TotalPrice: { value: base + tax },
                    Tax: [{ code: 'US', value: tax }],
                  },
                }],
              }],
            }],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(twoOfferSearch())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                            // addOffer for OFF-A
      .mockResolvedValueOnce(ok())                            // addOffer for OFF-B
      .mockResolvedValueOnce(priceForOffer('YPRO', 500, 80))  // FQ priceOffer #1
      .mockResolvedValueOnce(priceForOffer('YDEUR', 300, 40)); // FQ priceOffer #2

    await host.process('A27JUNDENFRA', wa);
    // Sell line 1 (offer A) + line 2 (offer B) in one multi-leg cryptic.
    await host.process('N1Y1Y2', wa);
    expect(wa.pnr.segments).toHaveLength(2);
    await host.process('N.SMITH/JOHN MR', wa);
    const resp = await host.process('FQ', wa);

    // Two priceOffer fetches, NOT one — because each segment lives in
    // a different offering.
    const priceCallCount = fetchSpy.mock.calls.filter(([url]) =>
      typeof url === 'string' && url.includes('/air/price/offers/buildfromcatalogproductofferings')
    ).length;
    expect(priceCallCount).toBe(2);

    // Merged quote: base 500+300=800, tax 80+40=120, total 920.
    expect(wa.pnr.priceQuotes).toHaveLength(1);
    const fq = wa.pnr.priceQuotes[0];
    expect(fq.passengers).toHaveLength(1);
    expect(fq.passengers[0].base).toBe(800);
    expect(fq.passengers[0].taxTotal).toBe(120);
    expect(fq.passengers[0].total).toBe(920);
    // Fare-basis codes from both offers in segment order.
    expect(fq.fareBasis).toEqual(['YPRO', 'YDEUR']);
    expect(resp).toContain('800');
    expect(resp).toContain('920');
  });

  it('FQ falls back to emulated when the segment has no reachable offerId', async () => {
    // Build emulated, then switch backend? Easier: spin up emulated host.
    const emulatedHost = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);
    await emulatedHost.process('A15JUNJFKLAX', ewa);
    await emulatedHost.process('N1Y1', ewa);
    await emulatedHost.process('N.SMITH/JOHN MR', ewa);
    const resp = await emulatedHost.process('FQ', ewa);
    expect(resp).toContain('FILED FARE 1');
    expect(ewa.pnr.priceQuotes).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
