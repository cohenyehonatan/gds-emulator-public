import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo QP/<queue> parsing', () => {
  it('parses QP/<n> as queue place without end-transaction', () => {
    const r = parseGalileoEntry('QP/43');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.op).toBe('place');
      expect(r.queue).toBe('43');
      expect(r.endTransaction).toBeFalsy();
    }
  });

  it('parses QEB/<n> with endTransaction flag (regression: distinguishes from QP)', () => {
    const r = parseGalileoEntry('QEB/43');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.op).toBe('place');
      expect(r.queue).toBe('43');
      expect(r.endTransaction).toBe(true);
    }
  });

  it('rejects malformed QP', () => {
    expect(() => parseGalileoEntry('QP')).toThrow();
    expect(() => parseGalileoEntry('QP/')).toThrow();
    expect(() => parseGalileoEntry('QP/abc-def')).toThrow();
  });
});

describe('Galileo live QP/<queue> — committed BF queue place', () => {
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

  it('QP/<n> after *<locator> POSTs /queue/queue with locator + queue, NO commit', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(ok()); // placeOnQueue

    await host.process('*ABC123', wa);
    const resp = await host.process('QP/43', wa);
    expect(resp).toBe('OK-QUEUE 43');

    // Exactly 3 calls — token, retrieve, queue-place. No commit call.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const [queueUrl, queueInit] = fetchSpy.mock.calls[2];
    expect(queueUrl).toContain('/air/queue/queue');
    const body = JSON.parse((queueInit?.body as string) ?? '{}');
    expect(body.QueuePlaceQuery?.LocatorCode).toBe('ABC123');
    expect(body.QueuePlaceQuery?.QueueNumber).toBe('43');

    // Local mirror reflects the placement.
    expect(host.backend.queues.get('43')).toContain('ABC123');
  });

  it('QP/<n> with no locator (in-flight build) rejects with FINISH OR IGNORE, no fetch', async () => {
    // Build state but never commit — workbench present, locator absent.
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
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
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-X' } } }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(ok()); // addOffer

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    expect(wa.pnr.locator).toBeUndefined();

    const resp = await host.process('QP/43', wa);
    expect(resp).toBe('FINISH OR IGNORE');
    expect(fetchSpy).toHaveBeenCalledTimes(4); // no /queue/queue call
  });

  it('5xx from /queue/queue surfaces as LIVE BACKEND ERROR; mirror untouched', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(
        new Response('"down"', { status: 503, statusText: 'Service Unavailable' })
      );

    await host.process('*ABC123', wa);
    const resp = await host.process('QP/43', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(host.backend.queues.get('43') ?? []).not.toContain('ABC123');
  });

  it('emulated QP places locally without any fetch', async () => {
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
    // E commits and returns the locator string, then resets the WA.
    // Re-retrieve to get the BF back on screen for QP.
    const locator = await emulatedHost.process('E', ewa);
    expect(locator).toMatch(/^[A-Z0-9]{6}$/);
    await emulatedHost.process(`*${locator}`, ewa);
    expect(ewa.pnr.locator).toBe(locator);

    const resp = await emulatedHost.process('QP/43', ewa);
    expect(resp).toBe('OK-QUEUE 43');
    expect(emulatedHost.backend.queues.get('43')).toContain(locator);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
