import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo Q/<queue> parsing', () => {
  it('parses Q/<n> as queue access', () => {
    const r = parseGalileoEntry('Q/43');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.op).toBe('access');
      expect(r.queue).toBe('43');
    }
  });

  it('parses Q/1 (general queue token from Mini Guide p.41)', () => {
    const r = parseGalileoEntry('Q/1');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') expect(r.queue).toBe('1');
  });

  it('rejects malformed Q/', () => {
    expect(() => parseGalileoEntry('Q/')).toThrow();
    expect(() => parseGalileoEntry('Q/abc-def')).toThrow();
  });
});

describe('Galileo live Q/<queue> — access via /queue/queue/list', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  function listResponse(items: Array<{ Locator: string; Name: string; TravelDate: string }>) {
    return new Response(
      JSON.stringify({
        AgencyQueueResponse: {
          transactionId: 'abc',
          AgencyQueue: {
            QueueList: items,
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

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

  // Reservation response factory for the first-BF retrieve after Q/<n>.
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

  it('Q/<n> POSTs canonical AgencyQueueSummary body and loads first BF on screen', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        listResponse([
          { Locator: 'ABC123', Name: 'SMITH/J', TravelDate: '27JUN' },
          { Locator: 'DEF456', Name: 'JONES/M', TravelDate: '30JUN' },
        ])
      )
      .mockResolvedValueOnce(reservationResp('ABC123')); // first BF retrieved

    const resp = await host.process('Q/43', wa);

    const [listUrl, listInit] = fetchSpy.mock.calls[1];
    expect(listUrl).toContain('/air/queue/queue/list');
    const body = JSON.parse((listInit?.body as string) ?? '{}');
    expect(body['@type']).toBe('AgencyQueueSummary');
    expect(body.Queue).toEqual([{ value: '43' }]);

    // Response is the rendered BF, not a list — Smartpoint Cloud
    // semantic: "Select the queue number to display the FIRST booking
    // file in the selected queue."
    expect(resp).toContain('ABC123');

    expect(wa.currentQueue).toBe('43');
    expect(wa.queueWorkingSet).toEqual(['ABC123', 'DEF456']);
    expect(wa.queueCursor).toBe(0);
    expect(wa.pnr.locator).toBe('ABC123');
  });

  it('Q/<n> on an empty queue returns QUEUE <n> EMPTY and does NOT enter queue context', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResponse([]));

    const resp = await host.process('Q/9', wa);
    expect(resp).toBe('QUEUE 9 EMPTY');
    expect(wa.currentQueue).toBeUndefined();
    expect(wa.queueWorkingSet).toBeUndefined();
    expect(wa.queueCursor).toBeUndefined();
  });

  it('5xx from /queue/queue/list surfaces as LIVE BACKEND ERROR; currentQueue untouched', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response('"down"', { status: 503, statusText: 'Service Unavailable' })
      );

    const resp = await host.process('Q/43', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(wa.currentQueue).toBeUndefined();
  });

  it('emulated Q/<n> reads backend.queues + pnrs, loads first BF, no fetch', async () => {
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
    const placeResp = await emulatedHost.process('QEB/43', ewa);
    expect(placeResp).toMatch(/^OK-QUEUE 43( - [A-Z0-9]+)?$/);
    const queuedLocators = emulatedHost.backend.queues.get('43') ?? [];
    expect(queuedLocators.length).toBe(1);

    const resp = await emulatedHost.process('Q/43', ewa);
    expect(resp).toContain(queuedLocators[0]);
    expect(resp).toContain('SMITH');
    expect(ewa.currentQueue).toBe('43');
    expect(ewa.queueWorkingSet).toEqual([queuedLocators[0]]);
    expect(ewa.queueCursor).toBe(0);
    expect(ewa.pnr.locator).toBe(queuedLocators[0]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('emulated Q/<n> on an empty queue returns EMPTY marker, no queue context entered', async () => {
    const emulatedHost = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);
    const resp = await emulatedHost.process('Q/77', ewa);
    expect(resp).toBe('QUEUE 77 EMPTY');
    expect(ewa.currentQueue).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Q/<n> at a dirty queue BF (the 03:23:11 wipe)', () => {
  it('refuses to reload over uncommitted modifications', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const backend = new LiveTravelportBackend({ clientId: 'x', clientSecret: 'y', username: 'z', password: 'w' });
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend });
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    // Simulate queue context with a modified BF on screen.
    wa.currentQueue = '38';
    wa.queueWorkingSet = ['GZWF93'];
    wa.queueCursor = 0;
    wa.queueCurrentDirty = true;

    const resp = await host.process('Q/38', wa);
    expect(resp).toBe('USE I OR END');
    expect(wa.queueCurrentDirty).toBe(true); // nothing wiped
    expect(wa.queueWorkingSet).toEqual(['GZWF93']); // context intact
    fetchSpy.mockRestore();
  });
});
