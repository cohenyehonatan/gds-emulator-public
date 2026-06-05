import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo QX / QXI / QXE parsing', () => {
  it('parses QX as queue exit', () => {
    const r = parseGalileoEntry('QX');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') expect(r.op).toBe('exit');
  });

  it('parses QXI as queue exit + ignore', () => {
    const r = parseGalileoEntry('QXI');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') expect(r.op).toBe('exit_ignore');
  });

  it('parses QXE as queue exit + end-tx', () => {
    const r = parseGalileoEntry('QXE');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') expect(r.op).toBe('exit_end_tx');
  });

  it('parses QXIR as queue exit + ignore + redisplay', () => {
    const r = parseGalileoEntry('QXIR');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') expect(r.op).toBe('exit_ignore_redisplay');
  });

  it('parses QXER as queue exit + end-tx + redisplay', () => {
    const r = parseGalileoEntry('QXER');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') expect(r.op).toBe('exit_end_redisplay');
  });
});

describe('Galileo QX family — semantics', () => {
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
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-QX' } } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  const ok = () =>
    new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const reservationRespQX = (loc: string) =>
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
  const listResp = () =>
    new Response(
      JSON.stringify({
        AgencyQueueResponse: {
          AgencyQueue: {
            QueueList: [{ Locator: 'ABC123', Name: 'SMITH/J', TravelDate: '27JUN' }],
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

  it('QX clears wa.currentQueue and returns OK-QUEUE EXIT, no fetch', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp())
      .mockResolvedValueOnce(reservationRespQX('ABC123')); // Q/43 first-BF retrieve
    await host.process('Q/43', wa);
    expect(wa.currentQueue).toBe('43');
    const callsBefore = fetchSpy.mock.calls.length;

    const resp = await host.process('QX', wa);
    expect(resp).toBe('OK-QUEUE EXIT');
    expect(wa.currentQueue).toBeUndefined();
    expect(fetchSpy.mock.calls.length).toBe(callsBefore); // no extra REST call
  });

  it('QX without a queue context still returns OK-QUEUE EXIT (idempotent)', async () => {
    expect(wa.currentQueue).toBeUndefined();
    const resp = await host.process('QX', wa);
    expect(resp).toBe('OK-QUEUE EXIT');
  });

  it('QXI exits queue and routes through I (workbench DELETE + reset)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp())
      .mockResolvedValueOnce(reservationRespQX('ABC123')) // Q/43 first-BF retrieve
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok()) // addOffer
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // workbench DELETE

    await host.process('Q/43', wa);
    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    expect(wa.liveWorkbenchId).toBe('WB-QX');
    expect(wa.currentQueue).toBe('43');

    const resp = await host.process('QXI', wa);
    expect(resp).toBe('IGNORED');
    expect(wa.currentQueue).toBeUndefined();
    expect(wa.liveWorkbenchId).toBeUndefined();
    expect(wa.pnr.segments.length).toBe(0);

    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
    expect(lastCall[0]).toContain('/reservationworkbench/WB-QX');
    expect(lastCall[1]?.method).toBe('DELETE');
  });

  it('QXE exits queue and routes through E (commit). Returns locator.', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok()) // addOffer
      .mockResolvedValueOnce(ok()) // addTraveler
      .mockResolvedValueOnce(ok()) // primaryContact
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Receipt: [{ Confirmation: { Locator: { value: 'QXE001', authority: 'Travelport' } } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ); // commit

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    wa.currentQueue = '99'; // simulate being in a queue context

    const resp = await host.process('QXE', wa);
    expect(resp).toBe('QXE001');
    expect(wa.currentQueue).toBeUndefined();
  });

  it('QXE with mandatory field missing surfaces the missing-field response', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok());

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    // No N. / P. / T. / R. — mandatory check rejects.
    wa.currentQueue = '99';
    const resp = await host.process('QXE', wa);
    expect(resp).toMatch(/USE [PRINT.\s]/); // missing-field marker (PHONE first)
    // Queue cursor cleared even on commit failure — QX is local-only.
    expect(wa.currentQueue).toBeUndefined();
  });

  it('QXIR exits queue, ignores changes, and re-retrieves the on-screen BF', async () => {
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

    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp())                  // Q/43 list
      .mockResolvedValueOnce(reservationResp('ABC123'))   // Q/43 first-BF retrieve
      .mockResolvedValueOnce(reservationResp('ABC123'));  // QXIR re-retrieve

    // Q/<n> alone now loads the first BF on screen.
    await host.process('Q/43', wa);
    expect(wa.currentQueue).toBe('43');
    expect(wa.pnr.locator).toBe('ABC123');

    const resp = await host.process('QXIR', wa);
    expect(resp).toContain('ABC123');
    expect(wa.currentQueue).toBeUndefined();
    expect(wa.pnr.locator).toBe('ABC123');
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('QXIR with no prior locator (degenerate: queue cursor set, no BF on screen) → IGNORED', async () => {
    // Simulate a state where queue cursor is set without a loaded BF
    // — can't happen via Q/<n> any more (it always loads), but covers
    // programmatic edge cases and future refactors.
    wa.currentQueue = '43';
    expect(wa.pnr.locator).toBeUndefined();

    const resp = await host.process('QXIR', wa);
    expect(resp).toBe('IGNORED');
    expect(wa.currentQueue).toBeUndefined();
  });

  it('QXER commits + redisplays the BF (locator + itinerary visible)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok()) // addOffer
      .mockResolvedValueOnce(ok()) // addTraveler
      .mockResolvedValueOnce(ok()) // primaryContact
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Receipt: [
              { Confirmation: { Locator: { value: 'XER001', authority: 'Travelport' } } },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    wa.currentQueue = '99';

    const resp = await host.process('QXER', wa);
    // Redisplay surfaces the rendered BF (header + itinerary), not just the locator.
    expect(resp).toContain('XER001');
    expect(resp).toContain('UA');
    expect(wa.currentQueue).toBeUndefined();
  });

  it('QXER with mandatory field missing leaves queue cursor cleared but WA intact', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok());

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    wa.currentQueue = '99';

    const resp = await host.process('QXER', wa);
    expect(resp).toMatch(/USE [PRINT.\s]/);
    expect(wa.currentQueue).toBeUndefined();
    // The WA still has the in-flight segments — agent can fix and retry.
    expect(wa.pnr.segments.length).toBe(1);
  });
});
