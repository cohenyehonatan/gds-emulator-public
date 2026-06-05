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
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                // addOffer
      .mockResolvedValueOnce(ok())                // addTraveler
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

    // priceOffer call URL + body:
    const [priceUrl, priceInit] = fetchSpy.mock.calls[5];
    expect(priceUrl).toContain('/air/price/offers/buildfromcatalogproductofferings');
    const body = JSON.parse((priceInit?.body as string) ?? '{}');
    expect(body.OfferQueryRef?.SearchOfferId).toBe('OFF-001');
    expect(body.OfferQueryRef?.PassengerCriteria?.[0]?.passengerTypeCode).toBe('ADT');
  });

  it('FQ without itinerary / names rejects without any fetch', async () => {
    const r1 = await host.process('FQ', wa);
    expect(r1).toContain('ITINERARY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('FQ live failure (5xx) surfaces as LIVE BACKEND ERROR; no quote filed', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(new Response('"down"', { status: 503, statusText: 'Service Unavailable' }));

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    const resp = await host.process('FQ', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(wa.pnr.priceQuotes).toHaveLength(0);
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
