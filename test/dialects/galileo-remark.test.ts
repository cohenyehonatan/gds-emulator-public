import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo NP. cryptic parsing', () => {
  it('NP.HELLO WORLD — plain notepad with internal whitespace', () => {
    const r = parseGalileoEntry('NP.HELLO WORLD');
    expect(r.kind).toBe('remark');
    if (r.kind === 'remark') {
      expect(r.remarkType).toBe('general');
      expect(r.text).toBe('HELLO WORLD');
    }
  });

  it('NP.H**SAVED IN HISTORY — historical qualifier', () => {
    const r = parseGalileoEntry('NP.H**SAVED IN HISTORY');
    expect(r.kind).toBe('remark');
    if (r.kind === 'remark') {
      expect(r.remarkType).toBe('historical');
      expect(r.text).toBe('SAVED IN HISTORY');
    }
  });

  it('NP.C**CONFIDENTIAL TEXT — confidential maps to general (visibility deferred)', () => {
    const r = parseGalileoEntry('NP.C**CONFIDENTIAL TEXT');
    expect(r.kind).toBe('remark');
    if (r.kind === 'remark') {
      expect(r.remarkType).toBe('general');
      expect(r.text).toBe('CONFIDENTIAL TEXT');
    }
  });

  it('rejects NP. with no text', () => {
    expect(() => parseGalileoEntry('NP.')).toThrow();
    expect(() => parseGalileoEntry('NP.H**')).toThrow();
  });

  it('rejects unsupported qualifier', () => {
    expect(() => parseGalileoEntry('NP.F**4111111111111111')).toThrow();
    expect(() => parseGalileoEntry('NP.HX**deferred')).toThrow();
  });
});

describe('Galileo NP. dispatch — emulated path', () => {
  let host: GdsHost;
  let wa: ReturnType<GdsHost['newWorkArea']>;

  beforeEach(async () => {
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });

  it('NP.<text> pushes a general remark onto wa.pnr.remarks', async () => {
    const resp = await host.process('NP.HOLD UNTIL FRIDAY', wa);
    expect(wa.pnr.remarks).toHaveLength(1);
    expect(wa.pnr.remarks[0].type).toBe('general');
    expect(wa.pnr.remarks[0].text).toBe('HOLD UNTIL FRIDAY');
    expect(resp).toContain('HOLD UNTIL FRIDAY');
  });

  it('NP.H**<text> pushes a historical remark', async () => {
    await host.process('NP.H**WAS ON HOLD', wa);
    expect(wa.pnr.remarks).toHaveLength(1);
    expect(wa.pnr.remarks[0].type).toBe('historical');
    expect(wa.pnr.remarks[0].text).toBe('WAS ON HOLD');
  });

  it('NP. flips queue dirty flag when in queue context', async () => {
    wa.currentQueue = '43';
    expect(wa.queueCurrentDirty).toBeFalsy();
    await host.process('NP.A REMARK', wa);
    expect(wa.queueCurrentDirty).toBe(true);
  });
});

describe('Galileo NP. — live wiring via /reservationcomments/list', () => {
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
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-NP' } } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
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

  it('NP. inside an in-flight workbench POSTs canonical ReservationCommentListRequest', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())  // addOffer
      .mockResolvedValueOnce(ok()); // addReservationComment

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    expect(wa.liveWorkbenchId).toBe('WB-NP');

    const resp = await host.process('NP.HOLD CONTACT REQUIRED', wa);
    expect(resp).toContain('HOLD CONTACT REQUIRED');

    const [url, init] = fetchSpy.mock.calls[4];
    expect(url).toContain('/reservationcomments/list');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.ReservationCommentListRequest?.ReservationCommentID?.[0]?.commentSource).toBe('Agency');
    expect(body.ReservationCommentListRequest?.ReservationCommentID?.[0]?.Comment?.[0]).toEqual({
      name: 'Notepad',
      value: 'HOLD CONTACT REQUIRED',
    });
  });

  it('NP.H** uses Historical Notepad label in the live body', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('NP.H**KEEP THIS', wa);

    const [, init] = fetchSpy.mock.calls[4];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.ReservationCommentListRequest?.ReservationCommentID?.[0]?.Comment?.[0]).toEqual({
      name: 'Historical Notepad',
      value: 'KEEP THIS',
    });
  });

  it('NP. outside a workbench (no live build started) stays local-only', async () => {
    // No fetch mocking — if dispatch tried to call REST, the test would
    // throw on undefined mock. Expects pure local handling.
    expect(wa.liveWorkbenchId).toBeUndefined();
    const resp = await host.process('NP.FREE FLOATING REMARK', wa);
    expect(resp).toContain('FREE FLOATING REMARK');
    expect(wa.pnr.remarks).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('live failure surfaces LIVE BACKEND ERROR; local remark NOT pushed', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(new Response('"down"', { status: 503, statusText: 'Service Unavailable' }));

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    const resp = await host.process('NP.IGNORED', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(wa.pnr.remarks).toHaveLength(0);
  });
});
