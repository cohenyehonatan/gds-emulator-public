import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo QRQ/ALL parsing', () => {
  it('parses QRQ/ALL as remove_all_in_pcc', () => {
    const r = parseGalileoEntry('QRQ/ALL');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') expect(r.op).toBe('remove_all_in_pcc');
  });
});

describe('Galileo live QRQ/ALL — remove from every queue this BF sits on', () => {
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

  it('QRQ/ALL POSTs a single multi-queue body covering every local-mirror queue containing the locator', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(removeOkResp());

    await host.process('*ABC123', wa);

    // Seed the local mirror so the dispatch handler has queues to enumerate.
    host.backend.queues.set('43', ['ABC123']);
    host.backend.queues.set('77', ['ABC123', 'OTHER']);
    host.backend.queues.set('99', ['UNRELATED']);

    const resp = await host.process('QRQ/ALL', wa);
    expect(resp).toBe('OK-QUEUE REMOVE ALL');

    const [removeUrl, removeInit] = fetchSpy.mock.calls[2];
    expect(removeUrl).toContain('/air/queue/queue/remove');
    const body = JSON.parse((removeInit?.body as string) ?? '{}');
    expect(body['@type']).toBe('AgencyQueueSummary');
    expect(body.ReservationIdentifier).toEqual({ value: 'ABC123' });

    // Queue array should contain both 43 and 77 (the queues holding ABC123),
    // NOT 99 (which only held UNRELATED).
    const queueValues = (body.Queue as Array<{ value: string }>).map((q) => q.value).sort();
    expect(queueValues).toEqual(['43', '77']);

    // Local mirror is spliced: ABC123 gone from 43 and 77; OTHER stays in 77; 99 untouched.
    expect(host.backend.queues.get('43') ?? []).not.toContain('ABC123');
    expect(host.backend.queues.get('77') ?? []).toEqual(['OTHER']);
    expect(host.backend.queues.get('99') ?? []).toEqual(['UNRELATED']);
  });

  it('QRQ/ALL inside a queue context returns FORMAT (Pocket Guide: "cannot be done if in the queue")', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            AgencyQueueResponse: {
              AgencyQueue: {
                QueueList: [{ Locator: 'ABC123', Name: 'SMITH/J', TravelDate: '27JUN' }],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ); // Q/43 list

    await host.process('*ABC123', wa);
    await host.process('Q/43', wa);
    expect(wa.currentQueue).toBe('43');

    const callsBefore = fetchSpy.mock.calls.length;
    const resp = await host.process('QRQ/ALL', wa);
    expect(resp).toBe('FORMAT');
    expect(fetchSpy.mock.calls.length).toBe(callsBefore); // no remove POST
  });

  it('QRQ/ALL with no on-screen BF returns FORMAT', async () => {
    const resp = await host.process('QRQ/ALL', wa);
    expect(resp).toBe('FORMAT');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('QRQ/ALL when the BF is on no queues in the mirror still returns OK (idempotent, no REST call)', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(reservationResp('ABC123'));

    await host.process('*ABC123', wa);
    // No backend.queues seeding — locator is on zero queues.
    const callsBefore = fetchSpy.mock.calls.length;

    const resp = await host.process('QRQ/ALL', wa);
    expect(resp).toBe('OK-QUEUE REMOVE ALL');
    expect(fetchSpy.mock.calls.length).toBe(callsBefore); // skipped REST call
  });

  it('5xx from /queue/queue/remove surfaces as LIVE BACKEND ERROR; local mirror untouched', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(
        new Response('"down"', { status: 503, statusText: 'Service Unavailable' })
      );

    await host.process('*ABC123', wa);
    host.backend.queues.set('43', ['ABC123']);

    const resp = await host.process('QRQ/ALL', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(host.backend.queues.get('43')).toContain('ABC123');
  });

  it('emulated QRQ/ALL splices the local mirror across multiple queues, no fetch', async () => {
    const emulatedHost = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);

    // Build + commit + QP onto multiple queues.
    await emulatedHost.process('A15JUNJFKLAX', ewa);
    await emulatedHost.process('N1Y1', ewa);
    await emulatedHost.process('N.SMITH/JOHN MR', ewa);
    await emulatedHost.process('P.LON*02012345678', ewa);
    await emulatedHost.process('T.TAU/10JUN', ewa);
    await emulatedHost.process('R.AGT', ewa);
    const locator = await emulatedHost.process('E', ewa); // commit
    expect(locator).toMatch(/^[A-Z0-9]{6}$/);
    await emulatedHost.process(`*${locator}`, ewa);
    // QEB acts as a pure place when a locator is already on screen
    // (the commit phase short-circuits). Multi-queue in one call.
    await emulatedHost.process('QEB/10+20+30', ewa);
    expect(emulatedHost.backend.queues.get('10')).toContain(locator);
    expect(emulatedHost.backend.queues.get('20')).toContain(locator);
    expect(emulatedHost.backend.queues.get('30')).toContain(locator);

    const resp = await emulatedHost.process('QRQ/ALL', ewa);
    expect(resp).toBe('OK-QUEUE REMOVE ALL');
    expect(emulatedHost.backend.queues.get('10') ?? []).not.toContain(locator);
    expect(emulatedHost.backend.queues.get('20') ?? []).not.toContain(locator);
    expect(emulatedHost.backend.queues.get('30') ?? []).not.toContain(locator);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
