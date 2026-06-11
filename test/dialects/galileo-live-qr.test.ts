import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo QR parsing', () => {
  it('parses QR as queue remove', () => {
    const r = parseGalileoEntry('QR');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') expect(r.op).toBe('remove');
  });
});

describe('Galileo live QR — remove BF from queue via /queue/queue/remove', () => {
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
  const listResp = (locator: string) =>
    new Response(
      JSON.stringify({
        AgencyQueueResponse: {
          AgencyQueue: {
            QueueList: [{ Locator: locator, Name: 'SMITH/J', TravelDate: '27JUN' }],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  const removeOkResp = () =>
    new Response(
      JSON.stringify({ BaseResponse: { Result: { status: 'Complete' } } }),
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

  it('QR after Q/<n> POSTs canonical AgencyQueueSummary with ReservationIdentifier', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp('ABC123'))      // Q/43 list
      .mockResolvedValueOnce(reservationResp('ABC123')) // Q/43 first-BF retrieve
      .mockResolvedValueOnce(removeOkResp());         // QR

    await host.process('Q/43', wa);
    expect(wa.currentQueue).toBe('43');
    expect(wa.pnr.locator).toBe('ABC123');

    // QR removes ABC123 — and since that was the only working-set
    // item, the queue context drains and we get the empty marker.
    const resp = await host.process('QR', wa);
    expect(resp).toBe('QUEUE 43 EMPTY');
    expect(wa.currentQueue).toBeUndefined();
    expect(wa.queueWorkingSet).toBeUndefined();

    const [removeUrl, removeInit] = fetchSpy.mock.calls[3];
    expect(removeUrl).toContain('/air/queue/queue/remove');
    const body = JSON.parse((removeInit?.body as string) ?? '{}');
    expect(body['@type']).toBe('AgencyQueueSummary');
    expect(body.ReservationIdentifier).toEqual({ value: 'ABC123' });
    expect(body.Queue).toEqual([{ value: '43' }]);
  });

  it('QR with another BF in the working set: removes + advances to next BF on screen', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            AgencyQueueResponse: {
              AgencyQueue: {
                QueueList: [
                  { Locator: 'ABC123', Name: 'SMITH/J', TravelDate: '27JUN' },
                  { Locator: 'DEF456', Name: 'JONES/M', TravelDate: '30JUN' },
                ],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(reservationResp('ABC123')) // first BF
      .mockResolvedValueOnce(removeOkResp())            // QR removes ABC123
      .mockResolvedValueOnce(reservationResp('DEF456')); // next BF auto-loaded

    await host.process('Q/43', wa);

    const resp = await host.process('QR', wa);
    expect(resp).toContain('DEF456'); // next BF on screen, not OK-QUEUE REMOVE
    expect(wa.queueWorkingSet).toEqual(['DEF456']);
    expect(wa.queueCursor).toBe(0);
    expect(wa.pnr.locator).toBe('DEF456');
  });

  it('QR without a queue context (no Q/<n> first) returns FORMAT, no fetch', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'));

    await host.process('*ABC123', wa);
    expect(wa.currentQueue).toBeUndefined();

    const callsBefore = fetchSpy.mock.calls.length;
    const resp = await host.process('QR', wa);
    expect(resp).toBe('FORMAT');
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
  });

  it('QR with no on-screen BF returns FORMAT', async () => {
    // Simulate a degenerate state: currentQueue is set but pnr.locator
    // isn't (can't happen via Q/<n> now — it always loads a BF — but
    // covers programmatic manipulation / future code paths).
    wa.currentQueue = '43';
    expect(wa.pnr.locator).toBeUndefined();

    const resp = await host.process('QR', wa);
    expect(resp).toBe('FORMAT');
  });

  it('5xx from /queue/queue/remove surfaces as LIVE BACKEND ERROR; mirror untouched', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp('ABC123'))      // Q/43 list
      .mockResolvedValueOnce(reservationResp('ABC123')) // Q/43 first-BF retrieve
      .mockResolvedValueOnce(
        new Response('"down"', { status: 503, statusText: 'Service Unavailable' })
      ); // QR fails

    await host.process('Q/43', wa);

    // Seed the local mirror to verify it's not nuked on 5xx.
    host.backend.queues.set('43', ['ABC123']);

    const resp = await host.process('QR', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(host.backend.queues.get('43')).toContain('ABC123');
  });

  it('emulated QR removes from local mirror and clears no fetch', async () => {
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
    await emulatedHost.process('N.SMITH/JOHN MR', ewa);
    await emulatedHost.process('P.LON*02012345678', ewa);
    await emulatedHost.process('T.TAU/10JUN', ewa);
    await emulatedHost.process('R.AGT', ewa);
    const locator = await emulatedHost.process('QEB/43', ewa); // commits + queues
    expect(locator).toMatch(/^OK-QUEUE 43( - [A-Z0-9]+)?$/);
    const committed = emulatedHost.backend.queues.get('43') ?? [];
    expect(committed.length).toBe(1);
    const committedLocator = committed[0];

    // Q/<n> loads the first BF on screen (no need for explicit *<locator>).
    await emulatedHost.process('Q/43', ewa);
    expect(ewa.currentQueue).toBe('43');
    expect(ewa.pnr.locator).toBe(committedLocator);

    const resp = await emulatedHost.process('QR', ewa);
    // Working set drains to empty → QUEUE n EMPTY marker + exit context.
    expect(resp).toBe('QUEUE 43 EMPTY');
    expect(emulatedHost.backend.queues.get('43') ?? []).not.toContain(committedLocator);
    expect(ewa.currentQueue).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
