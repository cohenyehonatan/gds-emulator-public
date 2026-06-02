import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo QP / QPI parsing', () => {
  it('parses QP as previous', () => {
    const r = parseGalileoEntry('QP');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') expect(r.op).toBe('previous');
  });

  it('parses QPI as previous_ignore', () => {
    const r = parseGalileoEntry('QPI');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') expect(r.op).toBe('previous_ignore');
  });
});

describe('Galileo QP / QPI — navigate backward in queue working set', () => {
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

  it('Q/<n> then QP at cursor 0 returns TOP OF QUEUE, cursor unchanged', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp('ABC123', 'DEF456'))
      .mockResolvedValueOnce(reservationResp('ABC123'));

    await host.process('Q/43', wa);
    expect(wa.queueCursor).toBe(0);
    const callsBefore = fetchSpy.mock.calls.length;

    const resp = await host.process('QP', wa);
    expect(resp).toBe('TOP OF QUEUE');
    expect(wa.queueCursor).toBe(0);
    expect(fetchSpy.mock.calls.length).toBe(callsBefore); // no fetch when at top
  });

  it('QP from cursor 2 decrements to 1 and reloads BF at the new cursor', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp('ABC123', 'DEF456', 'GHI789'))
      .mockResolvedValueOnce(reservationResp('ABC123')) // Q/43 first BF
      .mockResolvedValueOnce(reservationResp('DEF456')); // QP retrieve

    await host.process('Q/43', wa);
    // Programmatically advance cursor (forward-navigation is a follow-on commit).
    wa.queueCursor = 2;

    const resp = await host.process('QP', wa);
    expect(resp).toContain('DEF456');
    expect(wa.queueCursor).toBe(1);
    expect(wa.pnr.locator).toBe('DEF456');
  });

  it('QPI behaves like QP — decrement + reload', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp('ABC123', 'DEF456'))
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(reservationResp('ABC123'));

    await host.process('Q/43', wa);
    wa.queueCursor = 1;

    const resp = await host.process('QPI', wa);
    expect(resp).toContain('ABC123');
    expect(wa.queueCursor).toBe(0);
  });

  it('QP outside any queue context returns NO QUEUE CONTEXT', async () => {
    const resp = await host.process('QP', wa);
    expect(resp).toBe('NO QUEUE CONTEXT');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('QP at a dirty BF refuses with USE QPI OR END; QPI navigates anyway', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp('ABC123', 'DEF456'))
      .mockResolvedValueOnce(reservationResp('ABC123')) // Q/43 first BF
      .mockResolvedValueOnce(reservationResp('ABC123')); // QPI re-load (DEF456 not used since cursor goes 1→0)

    await host.process('Q/43', wa);
    // Simulate having advanced + modified the BF on screen.
    wa.queueCursor = 1;
    wa.queueCurrentDirty = true;

    const qpResp = await host.process('QP', wa);
    expect(qpResp).toBe('USE QPI OR END');
    expect(wa.queueCursor).toBe(1); // refused — cursor unchanged
    expect(wa.queueCurrentDirty).toBe(true); // still dirty

    const qpiResp = await host.process('QPI', wa);
    expect(qpiResp).toContain('ABC123');
    expect(wa.queueCursor).toBe(0);
    expect(wa.queueCurrentDirty).toBe(false); // cleared by reload
  });

  it('QP at a clean BF still navigates normally (no divergence from QPI)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp('ABC123', 'DEF456'))
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(reservationResp('ABC123'));

    await host.process('Q/43', wa);
    wa.queueCursor = 1; // advance without modification — still clean
    expect(wa.queueCurrentDirty).toBeFalsy();

    const resp = await host.process('QP', wa);
    expect(resp).toContain('ABC123');
    expect(wa.queueCursor).toBe(0);
  });

  it('modifying a queue BF (X1) flips the dirty flag', async () => {
    const reservationWith2Segs = (loc: string) =>
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
                {
                  carrier: 'UA',
                  number: '5678',
                  Departure: { location: 'FRA', time: '2026-06-30T08:00:00Z' },
                  Arrival: { location: 'DEN', time: '2026-06-30T15:30:00Z' },
                },
              ],
            },
            // Two offers so partial cancel can be wired (extractSegmentOfferIds).
            Offer: [
              {
                Identifier: { value: 'OFF-A' },
                Flight: [
                  {
                    carrier: 'UA',
                    number: '1234',
                    Departure: { location: 'DEN', time: '2026-06-27T08:00:00Z' },
                    Arrival: { location: 'FRA', time: '2026-06-28T07:30:00Z' },
                  },
                ],
              },
              {
                Identifier: { value: 'OFF-B' },
                Flight: [
                  {
                    carrier: 'UA',
                    number: '5678',
                    Departure: { location: 'FRA', time: '2026-06-30T08:00:00Z' },
                    Arrival: { location: 'DEN', time: '2026-06-30T15:30:00Z' },
                  },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResp('ABC123', 'DEF456'))
      .mockResolvedValueOnce(reservationWith2Segs('ABC123')) // Q/43 retrieve (2 segs, 2 offers)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Reservation: { Identifier: { value: 'ABC123' }, Offer: [{ Identifier: { value: 'OFF-A' }, Flight: [{ carrier: 'UA', number: '1234' }] }] },
            Identifier: { value: 'WB-CANCEL' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ) // buildfromlocator
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 })) // cancelitems
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Receipt: [{ Confirmation: { Locator: { value: 'ABC123', authority: 'Travelport' } } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ); // commit

    await host.process('Q/43', wa);
    expect(wa.queueCurrentDirty).toBe(false);
    expect(wa.pnr.segments.length).toBe(2);

    await host.process('X1', wa);
    expect(wa.queueCurrentDirty).toBe(true);
  });

  it('emulated QP navigates the working set without any fetch', async () => {
    const emulatedHost = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);

    // Build + commit one BF, then retrieve and place it on queue 50.
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

    // Seed a second locator directly into backend.queues + pnrs (skip
    // the build flow — we only need two locators in the queue).
    const otherPnr = emulatedHost.backend.pnrs.get(loc1)!;
    emulatedHost.backend.queues.set('50', [...(emulatedHost.backend.queues.get('50') ?? []), 'ZZZZZZ']);
    emulatedHost.backend.pnrs.commit(
      Object.assign(Object.create(Object.getPrototypeOf(otherPnr)), otherPnr, { locator: 'ZZZZZZ' })
    );

    await emulatedHost.process('Q/50', ewa);
    expect(ewa.queueWorkingSet?.length).toBe(2);
    expect(ewa.queueCursor).toBe(0);
    expect(ewa.pnr.locator).toBe(loc1);

    // Programmatically advance to position 1; QP brings us back to 0.
    ewa.queueCursor = 1;

    const resp = await emulatedHost.process('QP', ewa);
    expect(resp).toContain(loc1);
    expect(ewa.queueCursor).toBe(0);
    expect(ewa.pnr.locator).toBe(loc1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
