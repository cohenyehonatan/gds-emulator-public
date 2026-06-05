import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo live TKP — form of payment + commit', () => {
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
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-T' } } }), {
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

  it('TKP1 during build POSTs cash form-of-payment to /payment/.../formofpayment', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                // addOffer
      .mockResolvedValueOnce(ok())                // addTraveler
      .mockResolvedValueOnce(priceResp())         // FQ
      .mockResolvedValueOnce(ok());               // addFormOfPayment

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('FQ', wa);
    const resp = await host.process('TKP1', wa);

    expect(resp).toMatch(/^TKT \d{13}/m);
    expect(wa.pnr.tickets).toHaveLength(1);

    const [fopUrl, fopInit] = fetchSpy.mock.calls[6];
    expect(fopUrl).toContain('/payment/reservationworkbench/WB-T/formofpayment');
    const body = JSON.parse((fopInit?.body as string) ?? '{}');
    // Canonical body per APIRef_AddFOP.htm (verified 2026-05-29):
    // top-level discriminator is `FormOfPaymentCash`, not the bare
    // `FormOfPayment[].Type` we'd been posting.
    expect(body.FormOfPaymentCash).toBeDefined();
    expect(body.FormOfPaymentCash.id).toBe('formOfPayment_1');
    expect(body.FormOfPaymentCash.agentNonRefundableInd).toBeUndefined();
  });

  it('TKP without a filed fare returns FILED FARE NOT FOUND (no fetch)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                // addOffer
      .mockResolvedValueOnce(ok());               // addTraveler

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    expect(await host.process('TKP1', wa)).toBe('FILED FARE NOT FOUND');
    // FQ never called → priceQuotes empty → TKP rejects before FOP POST
    expect(fetchSpy).toHaveBeenCalledTimes(5);  // no FOP fetch
  });

  it('form-of-payment failure (5xx) surfaces as LIVE BACKEND ERROR; no tickets issued', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(priceResp())
      .mockResolvedValueOnce(new Response('"payment system down"', {
        status: 503, statusText: 'Service Unavailable',
      }));

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('FQ', wa);
    const resp = await host.process('TKP1', wa);

    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(wa.pnr.tickets).toHaveLength(0);  // no local issuance on failure
  });

  it('emulated TKP still works locally without any fetch', async () => {
    const emulatedHost = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);
    await emulatedHost.process('A15JUNJFKLAX', ewa);
    await emulatedHost.process('N1Y1', ewa);
    await emulatedHost.process('N.SMITH/JOHN MR', ewa);
    await emulatedHost.process('P.LON*02012345678', ewa);
    await emulatedHost.process('T.TAU/10JUN', ewa);
    await emulatedHost.process('R.AGT', ewa);
    await emulatedHost.process('FQ', ewa);
    const resp = await emulatedHost.process('TKP1', ewa);

    expect(resp).toMatch(/^TKT \d{13}/m);
    expect(ewa.pnr.tickets).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
