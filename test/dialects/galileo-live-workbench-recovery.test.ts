import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

/**
 * Workbench-expiry recovery (fix B). Pre-prod kills a reservation
 * workbench after a 30-minute TTL and signals it as HTTP 200 with
 * `[PROCESS/200] HOST SESSION HAS EXPIRED. IGNORE AND REINITIATE
 * WORKBENCH AND RETRY` in the body. The Galileo dispatch now rebuilds a
 * fresh workbench from wa.pnr and retries the failed op exactly once,
 * instead of leaking a raw LIVE BACKEND ERROR and re-hitting the dead
 * workbench on the operator's next entry.
 */
describe('Galileo live — workbench-expiry recovery', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  const tokenResponse = () =>
    new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
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
  const createWb = (id: string) =>
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: id } } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  const ok = () =>
    new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const travelerListResp = (ids: string[]) =>
    new Response(
      JSON.stringify({
        TravelerListResponse: {
          Traveler: ids.map((id, i) => ({
            Identifier: { authority: 'Travelport', value: id },
            PersonName: { Given: i === 0 ? 'JOHN' : 'JANE', Surname: 'SMITH' },
          })),
        },
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  // The expiry: HTTP 200, error buried in Result.Error[].Message — the
  // shape assertNoSemanticErrors walks for.
  const expiredResp = () =>
    new Response(
      JSON.stringify({
        TravelerListResponse: {
          Result: {
            Error: [
              {
                category: 'PROCESS',
                StatusCode: 200,
                Message: 'HOST SESSION HAS EXPIRED. IGNORE AND REINITIATE WORKBENCH AND RETRY',
              },
            ],
          },
        },
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

  it('addTravelers expiry at P. time rebuilds the workbench and retries to success', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb('WB-1')) // sell: first workbench
      .mockResolvedValueOnce(ok()) // sell: addOffer
      .mockResolvedValueOnce(expiredResp()) // P.: addTravelers → EXPIRED
      .mockResolvedValueOnce(createWb('WB-2')) // rebuild: fresh workbench
      .mockResolvedValueOnce(ok()) // rebuild: replay addOffer (saved segment)
      .mockResolvedValueOnce(travelerListResp(['uuid-1', 'uuid-2'])) // retry: addTravelers
      .mockResolvedValueOnce(ok()); // retry: addPrimaryContact

    await host.process('A27JUNDENFRA', wa);
    await host.process('N2Y1', wa);
    await host.process('N.SMITH/JOHN MR/JANE MRS', wa);
    const resp = await host.process('P.LON*02012345678', wa);

    // Recovery succeeded — operator sees a clean OK, not LIVE BACKEND ERROR.
    expect(resp).not.toContain('ERROR');
    expect(resp).not.toContain('EXPIRED');

    // Two workbenches created (original + rebuild); the WA now points at
    // the fresh one and holds the travelers posted on the retry.
    const createCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).endsWith('/reservationworkbench')
    );
    expect(createCalls).toHaveLength(2);
    expect(wa.liveWorkbenchId).toBe('WB-2');
    expect(wa.liveTravelerIds).toEqual(['uuid-1', 'uuid-2']);

    // The rebuild replayed the sold offer onto WB-2 before the retry.
    const offerCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/airoffer/'));
    expect(offerCalls).toHaveLength(2);
    expect(String(offerCalls[1][0])).toContain('WB-2');

    // 9 calls total: token, search, createWb, addOffer, addTravelers(EXPIRED),
    // createWb(rebuild), addOffer(rebuild), addTravelers(retry), addPrimaryContact.
    expect(fetchSpy).toHaveBeenCalledTimes(9);
  });

  it('a second expiry on the retry stops (no loop) and surfaces LIVE BACKEND ERROR', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb('WB-1'))
      .mockResolvedValueOnce(ok()) // sell addOffer
      .mockResolvedValueOnce(expiredResp()) // addTravelers → EXPIRED
      .mockResolvedValueOnce(createWb('WB-2')) // rebuild
      .mockResolvedValueOnce(ok()) // rebuild addOffer
      .mockResolvedValueOnce(expiredResp()) // retry addTravelers → EXPIRED again
      .mockResolvedValue(ok()); // belt-and-braces: no further expected calls

    await host.process('A27JUNDENFRA', wa);
    await host.process('N2Y1', wa);
    await host.process('N.SMITH/JOHN MR/JANE MRS', wa);
    const resp = await host.process('P.LON*02012345678', wa);

    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('HOST SESSION HAS EXPIRED');
    // We retried exactly once — two createWb calls, not an unbounded loop.
    const createCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).endsWith('/reservationworkbench')
    );
    expect(createCalls).toHaveLength(2);
  });

  it('non-expiry errors propagate unchanged (no rebuild attempted)', async () => {
    const validationErr = () =>
      new Response(
        JSON.stringify({
          TravelerListResponse: {
            Result: { Error: [{ category: 'VALIDATION', StatusCode: 200, Message: 'TELEPHONE IS A REQUIRED FIELD' }] },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb('WB-1'))
      .mockResolvedValueOnce(ok()) // sell addOffer
      .mockResolvedValueOnce(validationErr()) // addTravelers → non-expiry error
      .mockResolvedValue(ok());

    await host.process('A27JUNDENFRA', wa);
    await host.process('N2Y1', wa);
    await host.process('N.SMITH/JOHN MR/JANE MRS', wa);
    const resp = await host.process('P.LON*02012345678', wa);

    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('TELEPHONE IS A REQUIRED FIELD');
    // Only the original workbench was created — no rebuild on a non-expiry error.
    const createCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).endsWith('/reservationworkbench')
    );
    expect(createCalls).toHaveLength(1);
  });
});
