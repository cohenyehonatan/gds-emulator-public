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

  it('Q/<n> POSTs canonical AgencyQueueSummary body and renders the result', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        listResponse([
          { Locator: 'ABC123', Name: 'SMITH/J', TravelDate: '27JUN' },
          { Locator: 'DEF456', Name: 'JONES/M', TravelDate: '30JUN' },
        ])
      );

    const resp = await host.process('Q/43', wa);

    const [listUrl, listInit] = fetchSpy.mock.calls[1];
    expect(listUrl).toContain('/air/queue/queue/list');
    const body = JSON.parse((listInit?.body as string) ?? '{}');
    expect(body['@type']).toBe('AgencyQueueSummary');
    expect(body.Queue).toEqual([{ value: '43' }]);

    expect(resp).toContain('QUEUE 43');
    expect(resp).toContain('2 ITEMS');
    expect(resp).toContain('ABC123');
    expect(resp).toContain('SMITH/J');
    expect(resp).toContain('27JUN');
    expect(resp).toContain('DEF456');

    expect(wa.currentQueue).toBe('43');
  });

  it('Q/<n> on an empty queue renders QUEUE <n>  EMPTY', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(listResponse([]));

    const resp = await host.process('Q/9', wa);
    expect(resp).toBe('QUEUE 9  EMPTY');
    expect(wa.currentQueue).toBe('9');
  });

  it('Q/<n> tolerates PersonName object shape for Name field', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            AgencyQueueResponse: {
              AgencyQueue: {
                QueueList: [
                  {
                    Locator: 'XYZ789',
                    Name: { Surname: 'BROWN', Given: 'ANNE' },
                    TravelDate: '02JUL',
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const resp = await host.process('Q/3', wa);
    expect(resp).toContain('BROWN/A');
    expect(resp).toContain('02JUL');
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

  it('emulated Q/<n> reads backend.queues + pnrs, no fetch', async () => {
    const emulatedHost = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);
    // Build, end-tx, queue place (QEB) — populates both pnrStore and queues.
    await emulatedHost.process('A15JUNJFKLAX', ewa);
    await emulatedHost.process('N1Y1', ewa);
    await emulatedHost.process('N.SMITH/JOHN MR', ewa);
    await emulatedHost.process('P.LON*02012345678', ewa);
    await emulatedHost.process('T.TAU/10JUN', ewa);
    await emulatedHost.process('R.AGT', ewa);
    const locator = await emulatedHost.process('QEB/43', ewa);
    // QEB returns OK-QUEUE; need to look up the committed locator.
    expect(locator).toBe('OK-QUEUE 43');
    const queuedLocators = emulatedHost.backend.queues.get('43') ?? [];
    expect(queuedLocators.length).toBe(1);

    const resp = await emulatedHost.process('Q/43', ewa);
    expect(resp).toContain('QUEUE 43');
    expect(resp).toContain('1 ITEMS');
    expect(resp).toContain(queuedLocators[0]);
    expect(resp).toContain('SMITH/J');
    expect(resp).toContain('15JUN');
    expect(ewa.currentQueue).toBe('43');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('emulated Q/<n> on an empty queue renders the EMPTY marker', async () => {
    const emulatedHost = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);
    const resp = await emulatedHost.process('Q/77', ewa);
    expect(resp).toBe('QUEUE 77  EMPTY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
