import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

/**
 * Galileo `E` vs `ER` end-tx invariants — covers the surface that
 * separates the two: bare `E` returns just the locator string; `ER`
 * returns the rendered BF AND keeps it on screen for follow-on
 * queries; both reset the WA's live-build state.
 */

describe('Galileo E / ER — emulated end-tx invariants', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
  });

  it('E returns the locator only (no BF body)', async () => {
    const resp = await host.process('E', wa);
    expect(resp).toMatch(/^[A-Z0-9]{6}$/);
    // No itinerary in the response.
    expect(resp).not.toContain('UA');
    expect(resp).not.toContain('SMITH');
  });

  it('E resets the WA (no pnr.locator afterwards; *R returns NO PNR)', async () => {
    await host.process('E', wa);
    expect(wa.pnr.locator).toBeUndefined();
    expect(wa.pnr.segments).toHaveLength(0);
    const star = await host.process('*R', wa);
    expect(star).toMatch(/NO/); // NO PNR
  });

  it('ER returns the rendered BF (locator + names + segments)', async () => {
    const resp = await host.process('ER', wa);
    expect(resp).toMatch(/[A-Z0-9]{6}/);  // locator somewhere in header
    expect(resp).toContain('SMITH');
    // Itinerary lines reference the emulated O&D somewhere — JFK or LAX.
    expect(resp).toMatch(/JFK|LAX/);
  });

  it('ER resets the WA same as E (state-bearing surface stays consistent)', async () => {
    await host.process('ER', wa);
    expect(wa.pnr.locator).toBeUndefined();
    expect(wa.pnr.segments).toHaveLength(0);
  });

  it('ER → *<locator> sequence retrieves the committed BF', async () => {
    const er = await host.process('ER', wa);
    // Extract the locator from the rendered BF — typical Galileo header
    // has the locator near the start.
    const locMatch = /([A-Z0-9]{6})/.exec(er);
    expect(locMatch).not.toBeNull();
    const locator = locMatch![1];

    const star = await host.process(`*${locator}`, wa);
    expect(star).toContain(locator);
    expect(star).toContain('SMITH');
    expect(wa.pnr.locator).toBe(locator);
  });

  it('E without mandatory fields rejects with USE marker, no commit, no WA reset', async () => {
    // Set up a fresh WA missing R.
    const ewa = host.newWorkArea();
    await host.process('SON/ZHA', ewa);
    await host.process('A15JUNJFKLAX', ewa);
    await host.process('N1Y1', ewa);
    await host.process('N.SMITH/JOHN MR', ewa);
    await host.process('P.LON*02012345678', ewa);
    await host.process('T.TAU/10JUN', ewa);
    // R. omitted.

    const resp = await host.process('E', ewa);
    expect(resp).toMatch(/USE [PRINT.\s]/);
    // WA state preserved so the agent can correct.
    expect(ewa.pnr.segments).toHaveLength(1);
    expect(ewa.pnr.names).toHaveLength(1);
    expect(ewa.pnr.locator).toBeUndefined();
  });
});

describe('Galileo E / ER — live end-tx invariants', () => {
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
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-ER' } } }), {
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

  async function buildPnr(): Promise<void> {
    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
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

  it('live ER returns the rendered BF with the server locator + clears liveWorkbenchId', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok()) // addOffer
      .mockResolvedValueOnce(ok()) // addTraveler
      .mockResolvedValueOnce(ok()) // addPrimaryContact
      .mockResolvedValueOnce(commitResp('LIVE01'));

    await buildPnr();
    expect(wa.liveWorkbenchId).toBe('WB-ER');

    const resp = await host.process('ER', wa);
    expect(resp).toContain('LIVE01');
    expect(resp).toContain('SMITH');
    expect(resp).toContain('UA');

    // Workbench consumed server-side; cleared locally too.
    expect(wa.liveWorkbenchId).toBeUndefined();
    // WA reset matches the E path.
    expect(wa.pnr.locator).toBeUndefined();
  });

  it('live E (no redisplay) returns just the locator + clears liveWorkbenchId', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(commitResp('LIVE02'));

    await buildPnr();
    const resp = await host.process('E', wa);
    expect(resp).toBe('LIVE02');
    expect(wa.liveWorkbenchId).toBeUndefined();
  });

  it('live commit failure: locator NOT stamped, workbench NOT cleared (caller can retry)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(
        new Response('"down"', { status: 503, statusText: 'Service Unavailable' })
      );

    await buildPnr();
    const resp = await host.process('ER', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(wa.pnr.locator).toBeUndefined();
    // The workbench is still server-side until the agent retries or
    // ignores — local state still references it.
    expect(wa.liveWorkbenchId).toBe('WB-ER');
  });
});
