import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Hybrid-coverage explicitness: LOCAL VIEW ONLY trailer on live backend', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  const tokenResponse = () =>
    new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  const searchResp = () =>
    new Response(JSON.stringify({
      CatalogProductOfferingsResponse: {
        CatalogProductOfferings: {
          Identifier: { value: 'SRCH' },
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
  const createWb = () =>
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-LOCAL' } } }), {
      status: 201, headers: { 'Content-Type': 'application/json' },
    });
  const ok = () => new Response('{"ok":true}', { status: 200 });

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

  it('@<n>HK appends LOCAL VIEW ONLY trailer when running live', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok());                 // addOffer

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    const resp = await host.process('@1HK', wa);
    expect(resp).toContain('LOCAL VIEW ONLY');
    expect(resp).toContain('no v11 REST equivalent');
  });

  it('*H history appends LOCAL VIEW ONLY trailer when running live', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok());                 // addOffer

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    const resp = await host.process('*H', wa);
    expect(resp).toContain('LOCAL VIEW ONLY');
  });

  it('*-<surname> appends LOCAL VIEW ONLY trailer when running live (after commit)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                  // addOffer
      .mockResolvedValueOnce(ok())                  // addTraveler at P.
      .mockResolvedValueOnce(ok())                  // addPrimaryContact
      .mockResolvedValueOnce(                       // commit succeeds
        new Response(JSON.stringify({
          ReservationResponse: { Reservation: { Receipt: [
            { Confirmation: { Locator: { value: 'ABC123', source: '1G' } } },
          ] } },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('R.AGT', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('ER', wa);

    const wa2 = host.newWorkArea();
    await host.process('SON/ZHA', wa2);
    const resp = await host.process('*-SMITH', wa2);
    expect(resp).toContain('SMITH');
    expect(resp).toContain('LOCAL VIEW ONLY');
  });

  it('emulated backend does NOT append the trailer (local store IS authoritative)', async () => {
    const emulatedHost = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);
    await emulatedHost.process('A27JUNDENFRA', ewa);
    await emulatedHost.process('N1Y1', ewa);
    const resp = await emulatedHost.process('@1HK', ewa);
    expect(resp).not.toContain('LOCAL VIEW ONLY');
  });

  it('error responses are NOT decorated with the trailer (no noise)', async () => {
    // No itinerary → NEED ITINERARY response from @<n>HK without trailer.
    const resp = await host.process('@1HK', wa);
    expect(resp).toBe('NEED ITINERARY');
    expect(resp).not.toContain('LOCAL VIEW ONLY');
  });
});
