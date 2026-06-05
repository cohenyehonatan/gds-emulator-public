import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo `I` inside queue context — return BF to bottom + advance', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
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
  const listResp = (...locators: string[]) =>
    new Response(
      JSON.stringify({
        AgencyQueueResponse: {
          AgencyQueue: {
            QueueList: locators.map((l) => ({ Locator: l, Name: 'SMITH/J', TravelDate: '27JUN' })),
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
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

  it('I in queue context: places current BF back on its queue + advances cursor + loads next', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp('ABC123', 'DEF456'))
      .mockResolvedValueOnce(reservationResp('ABC123')) // Q/43 first BF
      .mockResolvedValueOnce(ok()) // I → place ABC123 back on queue 43
      .mockResolvedValueOnce(reservationResp('DEF456')); // load next BF (DEF456)

    await host.process('Q/43', wa);
    expect(wa.pnr.locator).toBe('ABC123');
    expect(wa.queueCursor).toBe(0);
    expect(wa.queueWorkingSet).toEqual(['ABC123', 'DEF456']);

    const resp = await host.process('I', wa);
    expect(resp).toContain('DEF456'); // next BF on screen

    // ABC123 dropped from working set, DEF456 slid into cursor 0.
    expect(wa.queueWorkingSet).toEqual(['DEF456']);
    expect(wa.queueCursor).toBe(0);
    expect(wa.pnr.locator).toBe('DEF456');

    // The place call put ABC123 back on queue 43.
    const [placeUrl, placeInit] = fetchSpy.mock.calls[3];
    expect(placeUrl).toContain('/air/queue/queue');
    expect(placeUrl).not.toContain('/list');
    expect(placeUrl).not.toContain('/remove');
    const body = JSON.parse((placeInit?.body as string) ?? '{}');
    expect(body.AgencyQueue?.ReservationIdentifier).toEqual({ value: 'ABC123' });
    expect(body.AgencyQueue?.Queue).toEqual([{ value: '43' }]);
  });

  it('I at the last item: returns QUEUE EMPTY and exits queue context', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp('ABC123'))
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(ok()); // I → place back on queue

    await host.process('Q/43', wa);
    expect(wa.queueWorkingSet?.length).toBe(1);

    const resp = await host.process('I', wa);
    expect(resp).toBe('QUEUE 43 EMPTY');
    expect(wa.currentQueue).toBeUndefined();
    expect(wa.queueCursor).toBeUndefined();
    expect(wa.queueWorkingSet).toBeUndefined();
  });

  it('I outside queue context: still discards workbench + returns IGNORED (preserved behaviour)', async () => {
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

    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-X' } } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(ok()) // addOffer
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // workbench DELETE

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    expect(wa.liveWorkbenchId).toBe('WB-X');

    const resp = await host.process('I', wa);
    expect(resp).toBe('IGNORED');
    expect(wa.liveWorkbenchId).toBeUndefined();
  });

  it('I in queue context: live place failure surfaces error; working set untouched', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp('ABC123', 'DEF456'))
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(
        new Response('"queue full"', { status: 503, statusText: 'Service Unavailable' })
      );

    await host.process('Q/43', wa);

    const resp = await host.process('I', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(wa.queueWorkingSet).toEqual(['ABC123', 'DEF456']); // untouched
  });

  it('emulated I in queue context: cycles BF to bottom of mirror + loads next, no fetch', async () => {
    const emulatedHost = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);

    // Build + commit one BF.
    await emulatedHost.process('A15JUNJFKLAX', ewa);
    await emulatedHost.process('N1Y1', ewa);
    await emulatedHost.process('N.SMITH/JOHN MR', ewa);
    await emulatedHost.process('P.LON*02012345678', ewa);
    await emulatedHost.process('T.TAU/10JUN', ewa);
    await emulatedHost.process('R.AGT', ewa);
    const loc1 = await emulatedHost.process('E', ewa);
    expect(loc1).toMatch(/^[A-Z0-9]{6}$/);
    await emulatedHost.process(`*${loc1}`, ewa);
    await emulatedHost.process('QEB/50', ewa);

    // Seed a second locator directly.
    const otherPnr = emulatedHost.backend.pnrs.get(loc1)!;
    emulatedHost.backend.queues.set('50', [...(emulatedHost.backend.queues.get('50') ?? []), 'XYZ001']);
    emulatedHost.backend.pnrs.commit(
      Object.assign(Object.create(Object.getPrototypeOf(otherPnr)), otherPnr, { locator: 'XYZ001' })
    );

    await emulatedHost.process('Q/50', ewa);
    expect(ewa.queueWorkingSet?.length).toBe(2);
    expect(ewa.pnr.locator).toBe(loc1);

    const resp = await emulatedHost.process('I', ewa);
    expect(resp).toContain('XYZ001');
    expect(ewa.queueWorkingSet).toEqual(['XYZ001']);
    expect(ewa.pnr.locator).toBe('XYZ001');

    // Mirror order: loc1 (which we returned to bottom) sits AFTER XYZ001.
    const mirror = emulatedHost.backend.queues.get('50') ?? [];
    expect(mirror).toEqual(['XYZ001', loc1]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
