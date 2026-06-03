import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo live FN — GET /farerule/farerules/fromfaredisplay', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const fareDisplayResp = () =>
    new Response(
      JSON.stringify({
        FareDisplayResponse: {
          Identifier: { value: 'fd-uuid-abc' },
          fareDisplay: [
            {
              listCurrency: { value: 'GBP' },
              fare: [
                {
                  sequence: 1,
                  carrier: 'BA',
                  amount: { value: 250 },
                  fareBasisCode: 'YEE3M',
                  bookingClass: 'Y',
                  oneWayInd: true,
                },
                {
                  sequence: 2,
                  carrier: 'BA',
                  amount: { value: 450 },
                  fareBasisCode: 'YEE6M',
                  bookingClass: 'Y',
                  roundTripInd: true,
                },
              ],
            },
          ],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  const fareRulesResp = () =>
    new Response(
      JSON.stringify({
        FareRuleListResponse: {
          FareRule: [
            {
              text: 'PARA 1 - MIN/MAX STAY 7 DAYS / 1 MONTH',
            },
            {
              LongText: 'PARA 8 - CANCELLATIONS NON-REFUNDABLE',
            },
          ],
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

  it('FN*1 after FD caches the identifier and GETs /fromfaredisplay', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(fareDisplayResp())   // FD14AUGLONPAR
      .mockResolvedValueOnce(fareRulesResp());    // FN*1

    await host.process('FD14AUGLONPAR', wa);
    expect(wa.lastFareDisplay?.identifier).toBe('fd-uuid-abc');
    expect(wa.lastFareDisplay?.lines).toHaveLength(2);

    const resp = await host.process('FN*1', wa);

    // The header reflects the targeted line's data:
    expect(resp).toContain('FARE NOTES LONPAR');
    expect(resp).toContain('BA YEE3M');
    expect(resp).toContain('L1');
    expect(resp).toContain('MIN/MAX STAY');
    expect(resp).toContain('NON-REFUNDABLE');

    const [url, init] = fetchSpy.mock.calls[2];
    expect(url).toContain('/farerule/farerules/fromfaredisplay');
    expect(url).toContain('fareRuleIdentifier=fd-uuid-abc');
    expect(url).toContain('FareID=1');
    expect(url).toContain('fareRuleType=LongText');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('FN*2/ALL targets line 2 of the cached fare display', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(fareDisplayResp())
      .mockResolvedValueOnce(fareRulesResp());

    await host.process('FD14AUGLONPAR', wa);
    await host.process('FN*2/ALL', wa);

    const [url] = fetchSpy.mock.calls[2];
    expect(url).toContain('FareID=2');
  });

  it('FN*1 with empty FareRule response returns NO FARE NOTES', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(fareDisplayResp())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ FareRuleListResponse: { FareRule: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    await host.process('FD14AUGLONPAR', wa);
    const resp = await host.process('FN*1', wa);
    expect(resp).toBe('NO FARE NOTES');
  });

  it('FN*1 with 5xx surfaces LIVE BACKEND ERROR', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(fareDisplayResp())
      .mockResolvedValueOnce(
        new Response('"down"', { status: 503, statusText: 'Service Unavailable' })
      );

    await host.process('FD14AUGLONPAR', wa);
    const resp = await host.process('FN*1', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
  });

  it('FN*<line> for a line not in the cached FD returns LINE <n> NOT IN FARE DISPLAY', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(fareDisplayResp());

    await host.process('FD14AUGLONPAR', wa);
    const callsBefore = fetchSpy.mock.calls.length;

    const resp = await host.process('FN*99', wa);
    expect(resp).toBe('LINE 99 NOT IN FARE DISPLAY');
    // No /fromfaredisplay call attempted.
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
  });
});
