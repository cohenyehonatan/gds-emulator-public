import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo live cancel — workbench (in-flight build)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  function searchResponse(): Response {
    return new Response(
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
  }

  const createWb = () => new Response(
    JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-X' } } }),
    { status: 201, headers: { 'Content-Type': 'application/json' } }
  );
  const ok = () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });

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

  it('XI during build POSTs to /cancelitems with empty body and clears workbench segments', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())  // addOffer
      .mockResolvedValueOnce(ok()); // cancelWorkbenchItems

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    expect(wa.pnr.segments.length).toBe(1);
    const resp = await host.process('XI', wa);
    expect(resp).toBe('ITINERARY CANCELLED');
    expect(wa.pnr.segments.length).toBe(0);

    // Cancel call (4th non-token mock) used the workbench cancelitems URL with empty body
    const [cancelUrl, cancelInit] = fetchSpy.mock.calls[4];
    expect(cancelUrl).toContain('/book/reservationworkbench/WB-X/reservations/cancelitems');
    const body = JSON.parse((cancelInit?.body as string) ?? '{}');
    expect(body).toEqual({});  // XI = empty body
  });

  it('XA behaves the same as XI (full cancel)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    const resp = await host.process('XA', wa);
    expect(resp).toBe('ITINERARY CANCELLED');
    expect(wa.pnr.segments.length).toBe(0);
  });

  it('X1 (partial cancel) sends Segments body with the selected segment numbers', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())  // addOffer
      .mockResolvedValueOnce(ok()); // cancelitems

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('X1', wa);

    const [, cancelInit] = fetchSpy.mock.calls[4];
    const body = JSON.parse((cancelInit?.body as string) ?? '{}');
    expect(body.Segments).toEqual([{ segmentNumber: 1 }]);
  });

  it('X<n> out of range is rejected BEFORE any cancel POST', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok());

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    expect(await host.process('X99', wa)).toBe('SEGMENT NUMBER NOT IN ITINERARY');
    // Still only 4 fetches (token, search, workbench, addOffer). No cancel attempted.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('cancel REST failure surfaces as LIVE BACKEND ERROR; local segments untouched', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(new Response('"workbench expired"', {
        status: 410, statusText: 'Gone',
      }));

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    const resp = await host.process('XI', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('410');
    expect(wa.pnr.segments.length).toBe(1);  // not cleared on failure
  });
});

describe('Galileo live cancel — committed (post-retrieve)', () => {
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

  afterEach(() => fetchSpy.mockRestore());

  it('XI after *<locator> POSTs to /air/receipt/reservations/{loc}/receipts', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResponse('ABC123'))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await host.process('*ABC123', wa);
    expect(wa.pnr.segments.length).toBe(1);
    const resp = await host.process('XI', wa);
    expect(resp).toBe('ITINERARY CANCELLED');
    expect(wa.pnr.segments.length).toBe(0);

    const [cancelUrl] = fetchSpy.mock.calls[2];
    expect(cancelUrl).toContain('/air/receipt/reservations/ABC123/receipts');
  });

  it('partial cancel against a committed BF returns the deferred-feature marker', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResponse('ABC123'));

    await host.process('*ABC123', wa);
    const resp = await host.process('X1', wa);
    expect(resp).toBe('LIVE PARTIAL CANCEL REQUIRES WORKBENCH');
    expect(wa.pnr.segments.length).toBe(1);  // untouched
    expect(fetchSpy).toHaveBeenCalledTimes(2);  // no third (cancel) call
  });

  it('cancelReservation 5xx surfaces as LIVE BACKEND ERROR', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResponse('ABC123'))
      .mockResolvedValueOnce(new Response('"down"', { status: 503, statusText: 'Service Unavailable' }));

    await host.process('*ABC123', wa);
    const resp = await host.process('XI', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(wa.pnr.segments.length).toBe(1);  // not cleared on failure
  });
});
