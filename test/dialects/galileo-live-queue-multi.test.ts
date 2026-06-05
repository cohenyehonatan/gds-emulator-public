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

  it('QEB/71MG/50 → branch-PCC 71MG, queue 50', () => {
    const r = parseGalileoEntry('QEB/71MG/50');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.queue).toBe('50');
      expect(r.pic).toBe('71MG');
      expect(r.additionalTargets).toBeUndefined();
    }
  });

  it('QEB/71MG/50+60 → branch-PCC 71MG, queues 50 then 60', () => {
    const r = parseGalileoEntry('QEB/71MG/50+60');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.queue).toBe('50');
      expect(r.pic).toBe('71MG');
      expect(r.additionalTargets).toEqual([{ queue: '60' }]);
    }
  });
});

describe('Galileo live QEB multi-queue place — single multi-queue call', () => {
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

  it('QEB/35+40+45 commits once and POSTs /queue/queue ONCE with three Queue[] elements', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok()) // addOffer
      .mockResolvedValueOnce(ok()) // addTraveler
      .mockResolvedValueOnce(ok()) // primaryContact
      .mockResolvedValueOnce(commitResp('MQ001')) // commit
      .mockResolvedValueOnce(ok()); // single multi-queue place

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);

    const resp = await host.process('QEB/35+40+45', wa);
    expect(resp).toBe('OK-QUEUE 35+40+45');
    expect(wa.pnr.locator).toBe('MQ001');

    // Exactly 8 calls — no per-queue fanout. The 7-index call is the
    // single multi-queue place.
    expect(fetchSpy).toHaveBeenCalledTimes(8);
    const [url, init] = fetchSpy.mock.calls[7];
    expect(url).toContain('/air/queue/queue');
    expect(url).not.toContain('/list');
    expect(url).not.toContain('/remove');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.AgencyQueue?.ReservationIdentifier).toEqual({ value: 'MQ001' });
    expect(body.AgencyQueue?.Queue).toEqual([
      { value: '35' },
      { value: '40' },
      { value: '45' },
    ]);

    // All three queues mirror the placement locally.
    expect(host.backend.queues.get('35')).toContain('MQ001');
    expect(host.backend.queues.get('40')).toContain('MQ001');
    expect(host.backend.queues.get('45')).toContain('MQ001');
  });

  it('QEB/35+40 — place 5xx surfaces LIVE BACKEND ERROR; mirror untouched (atomic)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(commitResp('MQ002'))
      .mockResolvedValueOnce(
        new Response('"queue full"', { status: 503, statusText: 'Service Unavailable' })
      ); // single multi-queue place fails

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);

    const resp = await host.process('QEB/35+40', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    // Single-call atomic: neither queue mirrored on REST failure.
    expect(host.backend.queues.get('35') ?? []).not.toContain('MQ002');
    expect(host.backend.queues.get('40') ?? []).not.toContain('MQ002');
  });

  it('QEB/<PCC>/<n> places via branch-PCC: pccOverride on each Queue element', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(commitResp('MQ003'))
      .mockResolvedValueOnce(ok());

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);

    const resp = await host.process('QEB/71MG/50', wa);
    expect(resp).toBe('OK-QUEUE 71MG/50');

    const [, init] = fetchSpy.mock.calls[7];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.AgencyQueue?.Queue).toEqual([{ value: '50', pccOverride: '71MG' }]);
  });

  it('QEB/<PCC>/<n>+<n> branch-PCC combined with multi-queue: pccOverride on each', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(commitResp('MQ004'))
      .mockResolvedValueOnce(ok());

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);

    const resp = await host.process('QEB/71MG/50+60', wa);
    expect(resp).toBe('OK-QUEUE 71MG/50+60');

    const [, init] = fetchSpy.mock.calls[7];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.AgencyQueue?.Queue).toEqual([
      { value: '50', pccOverride: '71MG' },
      { value: '60', pccOverride: '71MG' },
    ]);
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
      .mockResolvedValueOnce(reservationResp('ABC123')) // Q/43 first-BF retrieve
      .mockResolvedValueOnce(removeOk());

    // Q/<n> alone now loads the first BF on screen — no separate *<locator>.
    await host.process('Q/43', wa);
    expect(wa.currentQueue).toBe('43');
    expect(wa.pnr.locator).toBe('ABC123');

    const resp = await host.process('QR/23+77', wa);
    // Working set was [ABC123]; after QR removes ABC123, set drains
    // to empty and we exit queue context with the EMPTY marker.
    expect(resp).toBe('QUEUE 43 EMPTY');
    expect(wa.currentQueue).toBeUndefined();

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
