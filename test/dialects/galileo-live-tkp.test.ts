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

  it('TKP1 during build stamps local ticket records (FOP is post-commit only)', async () => {
    // After the 2026-06-06 ticket-issuance refactor, TKP at build time
    // doesn't POST a FOP — the FOP+Payment+commit-for-tickets dance
    // runs from commitGalileoLive after the initial commit returns a
    // locator. Verify TKP just files local TicketRecord(s); no live
    // fetch fires at TKP time.
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                // addOffer
      .mockResolvedValueOnce(ok())                // addTraveler (at P.)
      .mockResolvedValueOnce(ok())                // addPrimaryContact (at P.)
      .mockResolvedValueOnce(priceResp());        // FQ

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('FQ', wa);
    const fetchesBeforeTkp = fetchSpy.mock.calls.length;
    const resp = await host.process('TKP1', wa);

    expect(resp).toMatch(/^TKT \d{13}/m);
    expect(wa.pnr.tickets).toHaveLength(1);
    // No extra fetch at TKP time — the FOP call moved to commit.
    expect(fetchSpy.mock.calls.length).toBe(fetchesBeforeTkp);
  });

  it('TKP without a filed fare returns FILED FARE NOT FOUND (no fetch)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                // addOffer
      .mockResolvedValueOnce(ok())                // addTraveler (at P.)
      .mockResolvedValueOnce(ok());               // addPrimaryContact (at P.)

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    expect(await host.process('TKP1', wa)).toBe('FILED FARE NOT FOUND');
    // FQ never called → priceQuotes empty → TKP rejects before FOP POST
    expect(fetchSpy).toHaveBeenCalledTimes(6);  // no FOP fetch
  });

  it('TKP1 + ER: post-commit ticket dance is non-fatal — BF still commits if FOP fails', async () => {
    // After the 2026-06-06 refactor, FOP/Payment/commit-for-tickets
    // runs post-commit via issueTicketsPostCommit. A failure there is
    // logged as a warning but doesn't unwind the already-committed
    // BF (it's a console.warn, and the locator still surfaces). The
    // user sees the rendered BF and `wa.pnr.tickets` keeps the local
    // ticket record that TKP stamped — only server-side tickets are
    // missing.
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                // addOffer
      .mockResolvedValueOnce(ok())                // addTraveler (at P.)
      .mockResolvedValueOnce(ok())                // addPrimaryContact (at P.)
      .mockResolvedValueOnce(priceResp())         // FQ
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ Receipt: [{ Confirmation: { Locator: { value: 'ABC123' } } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )                                            // initial commit (succeeds)
      .mockResolvedValueOnce(
        new Response('"workbench gone"', { status: 410, statusText: 'Gone' })
      );                                           // post-commit buildfromlocator (fails)

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('FQ', wa);
    await host.process('TKP1', wa);
    await host.process('R.AGT', wa);
    await host.process('T.TAU/10JUN', wa);
    const erResp = await host.process('ER', wa);

    // The post-commit dance failure is non-fatal — locator surfaces.
    expect(erResp).toContain('ABC123');
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
