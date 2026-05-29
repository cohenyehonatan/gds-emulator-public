import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo DP<n> parsing', () => {
  it('parses DP2 as divide refs[0].item=2', () => {
    const r = parseGalileoEntry('DP2');
    expect(r.kind).toBe('divide');
    if (r.kind === 'divide') {
      expect(r.refs).toEqual([{ item: 2 }]);
    }
  });

  it('rejects DP0 (zero) and malformed DP', () => {
    expect(() => parseGalileoEntry('DP0')).toThrow();
    expect(() => parseGalileoEntry('DP')).toThrow();
    expect(() => parseGalileoEntry('DPABC')).toThrow();
  });
});

describe('Galileo live DP<n> — divide via /reservations/divide', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const ok = () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const reservationResp = (loc: string) =>
    new Response(JSON.stringify({
      Reservation: {
        Identifier: { value: loc },
        Traveler: [
          { PersonName: { Given: 'JOHN', Surname: 'SMITH' } },
          { PersonName: { Given: 'JANE', Surname: 'SMITH' } },
        ],
        AirReservation: {
          Flights: [{
            carrier: 'UA', number: '1234',
            Departure: { location: 'DEN', time: '2026-06-27T08:00:00Z' },
            Arrival: { location: 'FRA', time: '2026-06-28T07:30:00Z' },
          }],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend({
      clientId: 'x', clientSecret: 'y', username: 'z', password: 'w',
    });
    host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend,
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });

  afterEach(() => fetchSpy.mockRestore());

  it('DP2 after *<locator> POSTs /reservations/divide with locator + passenger', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(ok());  // divide

    await host.process('*ABC123', wa);
    // The mapped Pnr has 2 names but passengerCount is 2 (one passenger each)
    const resp = await host.process('DP2', wa);
    expect(resp).toBe('OK-DIVIDE P2');

    const [divideUrl, divideInit] = fetchSpy.mock.calls[2];
    expect(divideUrl).toContain('/air/book/reservation/reservations/divide');
    const body = JSON.parse((divideInit?.body as string) ?? '{}');
    expect(body.DivideQuery?.SourceLocator).toBe('ABC123');
    expect(body.DivideQuery?.PassengerNumbers).toEqual([2]);
  });

  it('DP<n> without a locator (mid-build) returns LIVE DIVIDE REQUIRES COMMITTED BF', async () => {
    // Manually populate a PNR so we get past the no-content check
    wa.pnr.names.push({ surname: 'SMITH', passengers: [{ firstName: 'JOHN' }], count: 1, infant: false });
    wa.pnr.names.push({ surname: 'SMITH', passengers: [{ firstName: 'JANE' }], count: 1, infant: false });
    wa.pnr.segments.push({
      segmentNumber: 1, carrier: 'UA', flightNumber: '1', bookingClass: 'Y',
      date: '27JUN', dayOfWeek: '?', dayOfWeekNum: 0,
      origin: 'DEN', destination: 'FRA', status: 'SS', seats: 2,
      departTime: '0800', arriveTime: '0730',
    });
    const resp = await host.process('DP2', wa);
    expect(resp).toBe('LIVE DIVIDE REQUIRES COMMITTED BF');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('DP<out-of-range> returns FORMAT', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'));

    await host.process('*ABC123', wa);
    expect(await host.process('DP99', wa)).toBe('FORMAT');
    expect(fetchSpy).toHaveBeenCalledTimes(2);  // no divide attempted
  });

  it('5xx from /reservations/divide surfaces as LIVE BACKEND ERROR', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(new Response('"down"', { status: 503, statusText: 'Service Unavailable' }));

    await host.process('*ABC123', wa);
    const resp = await host.process('DP2', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
  });

  it('emulated DP returns OK-DIVIDE placeholder (full local divide deferred)', async () => {
    const emulatedHost = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);
    await emulatedHost.process('A15JUNJFKLAX', ewa);
    await emulatedHost.process('N2Y1', ewa);
    await emulatedHost.process('N.SMITH/JOHN MR/JANE MRS', ewa);  // 2 pax in one name item
    const resp = await emulatedHost.process('DP2', ewa);
    expect(resp).toBe('OK-DIVIDE P2');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
