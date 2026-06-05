import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo I / IR parsing', () => {
  it('parses I as ignore without retrieve', () => {
    const r = parseGalileoEntry('I');
    expect(r.kind).toBe('ignore');
    if (r.kind === 'ignore') expect(r.retrieve).toBeFalsy();
  });

  it('parses IR as ignore + retrieve', () => {
    const r = parseGalileoEntry('IR');
    expect(r.kind).toBe('ignore');
    if (r.kind === 'ignore') expect(r.retrieve).toBe(true);
  });
});

describe('Galileo live I / IR — workbench DELETE + re-retrieve', () => {
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
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-IG' } } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  const ok = () =>
    new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const reservationResp = (loc: string) =>
    new Response(
      JSON.stringify({
        Reservation: {
          Identifier: { value: loc },
          Traveler: [{ PersonName: { Given: 'JOHN', Surname: 'SMITH' } }],
          AirReservation: {
            Flights: [
              {
                carrier: 'UA',
                number: '1234',
                Departure: { location: 'DEN', time: '2026-06-27T08:00:00Z' },
                Arrival: { location: 'FRA', time: '2026-06-28T07:30:00Z' },
              },
            ],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
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

  it('I during build sends DELETE /reservationworkbench/{wb}, returns IGNORED, clears WA', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok()) // addOffer
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // DELETE workbench

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    expect(wa.liveWorkbenchId).toBe('WB-IG');

    const resp = await host.process('I', wa);
    expect(resp).toBe('IGNORED');
    expect(wa.liveWorkbenchId).toBeUndefined();
    expect(wa.pnr.segments.length).toBe(0);

    const [deleteUrl, deleteInit] = fetchSpy.mock.calls[4];
    expect(deleteUrl).toContain('/reservationworkbench/WB-IG');
    expect(deleteInit?.method).toBe('DELETE');
  });

  it('I when DELETE returns 5xx still returns IGNORED (polite-citizen non-fatal)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(
        new Response('"down"', { status: 503, statusText: 'Service Unavailable' })
      );

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    const resp = await host.process('I', wa);
    expect(resp).toBe('IGNORED');
    expect(wa.liveWorkbenchId).toBeUndefined();
  });

  it('I with no workbench (e.g. after retrieve) makes no DELETE call', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(reservationResp('ABC123'));

    await host.process('*ABC123', wa);
    expect(wa.liveWorkbenchId).toBeUndefined();
    const callsBefore = fetchSpy.mock.calls.length;

    const resp = await host.process('I', wa);
    expect(resp).toBe('IGNORED');
    expect(fetchSpy.mock.calls.length).toBe(callsBefore); // no DELETE
  });

  it('IR after *<locator> re-retrieves the same BF', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(reservationResp('ABC123')); // second retrieve

    await host.process('*ABC123', wa);
    expect(wa.pnr.locator).toBe('ABC123');

    const resp = await host.process('IR', wa);
    expect(resp).toContain('ABC123');
    expect(wa.pnr.locator).toBe('ABC123');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('IR mid-build (no prior locator) degrades to plain I', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    expect(wa.pnr.locator).toBeUndefined();

    const resp = await host.process('IR', wa);
    expect(resp).toBe('IGNORED');
    expect(wa.pnr.segments.length).toBe(0);
  });

  it('emulated I clears the work area, no fetch', async () => {
    const emulatedHost = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);
    await emulatedHost.process('A15JUNJFKLAX', ewa);
    await emulatedHost.process('N1Y1', ewa);
    expect(ewa.pnr.segments.length).toBe(1);

    const resp = await emulatedHost.process('I', ewa);
    expect(resp).toBe('IGNORED');
    expect(ewa.pnr.segments.length).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('emulated IR after retrieve re-pulls the BF from pnrStore', async () => {
    const emulatedHost = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);
    // Build and commit so a locator exists in pnrStore.
    await emulatedHost.process('A15JUNJFKLAX', ewa);
    await emulatedHost.process('N1Y1', ewa);
    await emulatedHost.process('N.SMITH/JOHN MR', ewa);
    await emulatedHost.process('P.LON*02012345678', ewa);
    await emulatedHost.process('T.TAU/10JUN', ewa);
    await emulatedHost.process('R.AGT', ewa);
    const locator = await emulatedHost.process('E', ewa);
    expect(locator).toMatch(/^[A-Z0-9]{6}$/);
    await emulatedHost.process(`*${locator}`, ewa);
    expect(ewa.pnr.locator).toBe(locator);

    // IR re-runs the same retrieve path *<locator> uses, so the response
    // is the BF display (not the IGNORED placeholder) and wa.pnr.locator
    // is the prior locator. (NOTE: emulated pnrStore returns PNR by
    // reference rather than by clone, so we can't assert post-modify
    // restoration here — that's a pre-existing limitation of the emulated
    // path shared with `*<locator>` retrieve.)
    const resp = await emulatedHost.process('IR', ewa);
    expect(resp).toContain(locator);
    expect(ewa.pnr.locator).toBe(locator);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
