import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

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
  new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-R' } } }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
const ok = () =>
  new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('Galileo R. polite-citizen audit — default off', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

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

  it('R. with default options does NOT post a reservation comment', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok()); // addOffer

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    const callsBefore = fetchSpy.mock.calls.length;

    const resp = await host.process('R.AGT', wa);
    expect(resp).toBe('OK');
    expect(wa.pnr.receivedFrom).toBe('AGT');
    // No additional call beyond the local state update.
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
  });
});

describe('Galileo R. polite-citizen audit — opt-in', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend(
      { clientId: 'x', clientSecret: 'y', username: 'z', password: 'w' },
      { politeReceivedFromAudit: true }
    );
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

  it('R. with politeReceivedFromAudit=true POSTs canonical Agency comment', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok()) // addOffer
      .mockResolvedValueOnce(ok()); // addReservationComment for R.

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    const resp = await host.process('R.AGT', wa);
    expect(resp).toBe('OK');
    expect(wa.pnr.receivedFrom).toBe('AGT');

    const [url, init] = fetchSpy.mock.calls[4];
    expect(url).toContain('/reservationcomments/list');
    const body = JSON.parse((init?.body as string) ?? '{}');
    // R. routes through the General Remark envelope (notepad path) —
    // no commentSource, has id + language: 'EN', name: 'RE'.
    const c = body.ReservationComment?.[0];
    expect(c?.commentSource).toBeUndefined();
    expect(c?.id).toBe('reservationComment_1');
    expect(c?.Comment?.[0]?.name).toBe('RE');
    expect(c?.Comment?.[0]?.value).toBe('R. AGT');
  });

  it('5xx on the polite-citizen POST surfaces LIVE BACKEND ERROR; local R. NOT set', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(
        new Response('"down"', { status: 503, statusText: 'Service Unavailable' })
      );

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    const resp = await host.process('R.AGT', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(wa.pnr.receivedFrom).toBeUndefined();
  });

  it('R. outside a workbench (no live build) stays local-only, no fetch', async () => {
    expect(wa.liveWorkbenchId).toBeUndefined();
    const resp = await host.process('R.YY', wa);
    expect(resp).toBe('OK');
    expect(wa.pnr.receivedFrom).toBe('YY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
