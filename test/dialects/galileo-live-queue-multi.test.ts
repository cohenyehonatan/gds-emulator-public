import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo multi-queue `+` parsing', () => {
  it('QEB/35+40+45 → primary 35, additionalTargets [40, 45]', () => {
    const r = parseGalileoEntry('QEB/35+40+45');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.queue).toBe('35');
      expect(r.additionalTargets).toEqual([{ queue: '40' }, { queue: '45' }]);
      expect(r.endTransaction).toBe(true);
    }
  });

  it('QEB/35 → primary 35, no additionalTargets', () => {
    const r = parseGalileoEntry('QEB/35');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.queue).toBe('35');
      expect(r.additionalTargets).toBeUndefined();
    }
  });

  it('QR/23+77 → primary 23, additionalTargets [77]', () => {
    const r = parseGalileoEntry('QR/23+77');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.op).toBe('remove');
      expect(r.queue).toBe('23');
      expect(r.additionalTargets).toEqual([{ queue: '77' }]);
    }
  });

  it('QR (no targets) parses as bare remove', () => {
    const r = parseGalileoEntry('QR');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.op).toBe('remove');
      expect(r.queue).toBeUndefined();
      expect(r.additionalTargets).toBeUndefined();
    }
  });

  it('QRQ/ALL still parses (must not be eaten by the QR/ prefix branch)', () => {
    const r = parseGalileoEntry('QRQ/ALL');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') expect(r.op).toBe('remove_all_in_pcc');
  });

  it('rejects QEB with empty chain trailer', () => {
    expect(() => parseGalileoEntry('QEB/35+')).toThrow();
    expect(() => parseGalileoEntry('QEB/+35')).toThrow();
  });
});

describe('Galileo live QEB multi-queue place — N round-trips', () => {
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
                      { FareDetail: [{ BookingCode: { code: 'Y', count: 9 } }] },
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
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-MQ' } } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  const ok = () =>
    new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const commitResp = (loc: string) =>
    new Response(
      JSON.stringify({
        Receipt: [{ Confirmation: { Locator: { value: loc, authority: 'Travelport' } } }],
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

  it('QEB/35+40+45 commits once and POSTs /queue/queue three times', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok()) // addOffer
      .mockResolvedValueOnce(ok()) // addTraveler
      .mockResolvedValueOnce(ok()) // primaryContact
      .mockResolvedValueOnce(commitResp('MQ001')) // commit
      .mockResolvedValueOnce(ok()) // place 35
      .mockResolvedValueOnce(ok()) // place 40
      .mockResolvedValueOnce(ok()); // place 45

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);

    const resp = await host.process('QEB/35+40+45', wa);
    expect(resp).toBe('OK-QUEUE 35+40+45');
    expect(wa.pnr.locator).toBe('MQ001');

    // Three /queue/queue calls (after the commit at index 6).
    for (let i = 0; i < 3; i++) {
      const [url, init] = fetchSpy.mock.calls[7 + i];
      expect(url).toContain('/air/queue/queue');
      expect(url).not.toContain('/list');
      expect(url).not.toContain('/remove');
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.QueuePlaceQuery?.LocatorCode).toBe('MQ001');
      expect(body.QueuePlaceQuery?.QueueNumber).toBe(['35', '40', '45'][i]);
    }

    // All three queues mirror the placement locally.
    expect(host.backend.queues.get('35')).toContain('MQ001');
    expect(host.backend.queues.get('40')).toContain('MQ001');
    expect(host.backend.queues.get('45')).toContain('MQ001');
  });

  it('QEB/35+40 — second placement failure surfaces error, first stays placed', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(commitResp('MQ002'))
      .mockResolvedValueOnce(ok()) // place 35 OK
      .mockResolvedValueOnce(
        new Response('"queue full"', { status: 503, statusText: 'Service Unavailable' })
      ); // place 40 fails

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);

    const resp = await host.process('QEB/35+40', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    // Mirror reflects the partial state — short-circuit means no local
    // mirror write for either queue (writes happen after the REST loop).
    expect(host.backend.queues.get('35') ?? []).not.toContain('MQ002');
    expect(host.backend.queues.get('40') ?? []).not.toContain('MQ002');
  });
});

describe('Galileo live QR multi-queue — single multi-queue body', () => {
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
  const removeOk = () =>
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

  it('QR/23+77 with no active queue: POSTs single multi-queue body covering 23+77', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(removeOk());

    await host.process('*ABC123', wa);
    host.backend.queues.set('23', ['ABC123']);
    host.backend.queues.set('77', ['ABC123', 'OTHER']);

    const resp = await host.process('QR/23+77', wa);
    expect(resp).toBe('OK-QUEUE REMOVE 23+77');

    const [removeUrl, removeInit] = fetchSpy.mock.calls[2];
    expect(removeUrl).toContain('/air/queue/queue/remove');
    const body = JSON.parse((removeInit?.body as string) ?? '{}');
    expect(body.ReservationIdentifier).toEqual({ value: 'ABC123' });
    expect(body.Queue).toEqual([{ value: '23' }, { value: '77' }]);

    expect(host.backend.queues.get('23') ?? []).not.toContain('ABC123');
    expect(host.backend.queues.get('77') ?? []).toEqual(['OTHER']);
  });

  it('QR/23+77 inside a queue cursor: implicit active queue added, deduped', async () => {
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
      )
      .mockResolvedValueOnce(removeOk());

    await host.process('*ABC123', wa);
    await host.process('Q/43', wa);
    expect(wa.currentQueue).toBe('43');

    const resp = await host.process('QR/23+77', wa);
    expect(resp).toBe('OK-QUEUE REMOVE 43+23+77');

    const [, removeInit] = fetchSpy.mock.calls[3];
    const body = JSON.parse((removeInit?.body as string) ?? '{}');
    expect(body.Queue).toEqual([{ value: '43' }, { value: '23' }, { value: '77' }]);
  });

  it('QR/43 — single explicit queue still uses the simpler single-queue body', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(removeOk());

    await host.process('*ABC123', wa);
    const resp = await host.process('QR/43', wa);
    expect(resp).toBe('OK-QUEUE REMOVE 43');

    const [, removeInit] = fetchSpy.mock.calls[2];
    const body = JSON.parse((removeInit?.body as string) ?? '{}');
    expect(body.Queue).toEqual([{ value: '43' }]); // single-element, not multi
  });
});
