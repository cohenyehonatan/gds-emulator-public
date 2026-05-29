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

  it('QR after Q/<n> + *<locator> POSTs canonical AgencyQueueSummary with ReservationIdentifier', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp('ABC123'))   // Q/43
      .mockResolvedValueOnce(reservationResp('ABC123')) // *ABC123
      .mockResolvedValueOnce(removeOkResp());     // QR

    await host.process('Q/43', wa);
    await host.process('*ABC123', wa);
    expect(wa.currentQueue).toBe('43');
    expect(wa.pnr.locator).toBe('ABC123');

    const resp = await host.process('QR', wa);
    expect(resp).toBe('OK-QUEUE REMOVE 43');

    const [removeUrl, removeInit] = fetchSpy.mock.calls[3];
    expect(removeUrl).toContain('/air/queue/queue/remove');
    const body = JSON.parse((removeInit?.body as string) ?? '{}');
    expect(body['@type']).toBe('AgencyQueueSummary');
    expect(body.ReservationIdentifier).toEqual({ value: 'ABC123' });
    expect(body.Queue).toEqual([{ value: '43' }]);
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
    fetchSpy.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(listResp('ABC123'));

    await host.process('Q/43', wa);
    expect(wa.currentQueue).toBe('43');
    expect(wa.pnr.locator).toBeUndefined();

    const resp = await host.process('QR', wa);
    expect(resp).toBe('FORMAT');
  });

  it('5xx from /queue/queue/remove surfaces as LIVE BACKEND ERROR; mirror untouched', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp('ABC123'))
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(
        new Response('"down"', { status: 503, statusText: 'Service Unavailable' })
      );

    await host.process('Q/43', wa);
    await host.process('*ABC123', wa);

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
    expect(locator).toBe('OK-QUEUE 43');
    const committed = emulatedHost.backend.queues.get('43') ?? [];
    expect(committed.length).toBe(1);
    const committedLocator = committed[0];

    // Re-retrieve and access queue 43 to set up the QR preconditions.
    await emulatedHost.process(`*${committedLocator}`, ewa);
    await emulatedHost.process('Q/43', ewa);
    expect(ewa.currentQueue).toBe('43');
    expect(ewa.pnr.locator).toBe(committedLocator);

    const resp = await emulatedHost.process('QR', ewa);
    expect(resp).toBe('OK-QUEUE REMOVE 43');
    expect(emulatedHost.backend.queues.get('43') ?? []).not.toContain(committedLocator);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
