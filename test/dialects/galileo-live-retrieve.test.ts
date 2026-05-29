import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';
import { SessionState } from '../../src/session/session-state.js';

/**
 * Galileo `*<locator>` → live TripServices GET, with the response
 * mapped via mapReservation to populate the work-area PNR. Surname
 * search (`*-SMITH`) stays local-only per the spec — no documented
 * REST surname endpoint.
 */

describe('Galileo live retrieve (mocked fetch)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  function reservationResponse(locator: string): Response {
    return new Response(
      JSON.stringify({
        Reservation: {
          Identifier: { value: locator },
          Traveler: [{ PersonName: { Given: 'JOHN', Surname: 'HENRIQUEZ' } }],
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
  }

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

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('*<locator> on live backend GETs /reservations/{locator} and renders the mapped BF', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResponse('ABC123'));

    const resp = await host.process('*ABC123', wa);
    expect(resp).toContain('ABC123');
    expect(resp).toContain('HENRIQUEZ');
    expect(resp).toContain('UA');
    expect(resp).toContain('DEN');

    // Two fetches: token + retrieve
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [retrieveUrl, retrieveInit] = fetchSpy.mock.calls[1];
    expect(retrieveUrl).toContain('/air/book/reservation/reservations/ABC123');
    expect(retrieveInit?.method).toBe('GET');
    const headers = retrieveInit?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe('Bearer TKN');
    expect(headers?.['TVP-PCC-CORE']).toBe('7K9S_1G');
  });

  it('populates wa.pnr with the mapped reservation + transitions to DISPLAYED', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResponse('ABC123'));
    await host.process('*ABC123', wa);
    expect(wa.pnr.locator).toBe('ABC123');
    expect(wa.pnr.names[0].surname).toBe('HENRIQUEZ');
    expect(wa.pnr.segments[0].carrier).toBe('UA');
    expect(wa.state()).toBe(SessionState.DISPLAYED);
  });

  it('404 from live retrieve surfaces as NO BOOKING FILE', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('{"error":"not found"}', {
        status: 404, statusText: 'Not Found',
      }));
    expect(await host.process('*MISSNG', wa)).toBe('NO BOOKING FILE');
    expect(wa.pnr.locator).toBeUndefined();
  });

  it('410 (workbench expired / committed reservation purged) → NO BOOKING FILE', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('{}', { status: 410, statusText: 'Gone' }));
    expect(await host.process('*EXPIRD', wa)).toBe('NO BOOKING FILE');
  });

  it('5xx surfaces as LIVE BACKEND ERROR with status preserved', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('"server is sad"', {
        status: 503, statusText: 'Service Unavailable',
      }));
    const resp = await host.process('*BROKEN', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
  });

  it('after live retrieve, a subsequent surname search finds it locally (pragmatic shadow)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResponse('ABC123'));
    await host.process('*ABC123', wa);

    // Surname search stays local (no REST surname endpoint per the spec).
    // The live-retrieved PNR is mirrored to the local pnrStore though,
    // so *-HENRIQUEZ finds it without another fetch.
    const surnameResp = await host.process('*-HENRIQUEZ', wa);
    expect(surnameResp).toContain('ABC123');
    expect(surnameResp).toContain('HENRIQUEZ');
    expect(fetchSpy).toHaveBeenCalledTimes(2);  // no additional fetch
  });

  it('*R / *I redisplay verbs still work locally after live retrieve', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResponse('ABC123'));
    await host.process('*ABC123', wa);
    const rResp = await host.process('*R', wa);
    expect(rResp).toContain('ABC123');
    const iResp = await host.process('*I', wa);
    expect(iResp).toContain('UA');
    expect(iResp).not.toContain('HENRIQUEZ');  // itinerary only — no names
  });
});
