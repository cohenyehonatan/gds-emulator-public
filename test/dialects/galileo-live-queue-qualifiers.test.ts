import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo queue qualifier parsing — *C<cat>*D<n>', () => {
  it('Q/37*CDM → queue 37, category DM', () => {
    const r = parseGalileoEntry('Q/37*CDM');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.op).toBe('access');
      expect(r.queue).toBe('37');
      expect(r.category).toBe('DM');
      expect(r.dateRange).toBeUndefined();
    }
  });

  it('Q/37*CBA*D3 → queue 37, category BA, date range 3', () => {
    const r = parseGalileoEntry('Q/37*CBA*D3');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.queue).toBe('37');
      expect(r.category).toBe('BA');
      expect(r.dateRange).toBe(3);
    }
  });

  it('QEB/42*CAB*D4 → queue 42, category AB, date range 4', () => {
    const r = parseGalileoEntry('QEB/42*CAB*D4');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.op).toBe('place');
      expect(r.queue).toBe('42');
      expect(r.category).toBe('AB');
      expect(r.dateRange).toBe(4);
    }
  });

  it('Q/18F/27 → branch-PCC 18F, queue 27, no qualifiers', () => {
    const r = parseGalileoEntry('Q/18F/27');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.queue).toBe('27');
      expect(r.pic).toBe('18F');
      expect(r.category).toBeUndefined();
      expect(r.dateRange).toBeUndefined();
    }
  });

  it('Q/GK5/77*CDL*D2 → branch-PCC GK5, queue 77, category DL, date range 2', () => {
    const r = parseGalileoEntry('Q/GK5/77*CDL*D2');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.queue).toBe('77');
      expect(r.pic).toBe('GK5');
      expect(r.category).toBe('DL');
      expect(r.dateRange).toBe(2);
    }
  });

  it('QEB/71MG/50*CAB*D1 → branch-PCC + queue + cat + date', () => {
    const r = parseGalileoEntry('QEB/71MG/50*CAB*D1');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.queue).toBe('50');
      expect(r.pic).toBe('71MG');
      expect(r.category).toBe('AB');
      expect(r.dateRange).toBe(1);
    }
  });

  it('rejects date range > 4 (only D1-D4 valid per Travelport docs)', () => {
    expect(() => parseGalileoEntry('Q/37*CBA*D5')).toThrow();
    expect(() => parseGalileoEntry('Q/37*CBA*D0')).toThrow();
  });

  it('rejects single-char category (must be 2 alphanumeric)', () => {
    expect(() => parseGalileoEntry('Q/37*CA')).toThrow();
  });
});

describe('Galileo live queue qualifiers — pass-through to v11 body', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const listResp = () =>
    new Response(
      JSON.stringify({
        AgencyQueueResponse: {
          AgencyQueue: {
            QueueList: [{ Locator: 'ABC123', Name: 'SMITH/J', TravelDate: '27JUN' }],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
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
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-Q' } } }), {
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

  it('Q/37*CBA*D3 POSTs Queue[0] with category + dateOffset', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(listResp());

    await host.process('Q/37*CBA*D3', wa);
    const [, init] = fetchSpy.mock.calls[1];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.Queue).toEqual([
      { value: '37', category: 'BA', dateOffset: 3 },
    ]);
  });

  it('Q/18F/27 POSTs Queue[0] with pccOverride only', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(listResp());

    await host.process('Q/18F/27', wa);
    const [, init] = fetchSpy.mock.calls[1];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.Queue).toEqual([{ value: '27', pccOverride: '18F' }]);
  });

  it('Q/GK5/77*CDL*D2 POSTs Queue[0] with branch + category + dateOffset', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(listResp());

    await host.process('Q/GK5/77*CDL*D2', wa);
    const [, init] = fetchSpy.mock.calls[1];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.Queue).toEqual([
      { value: '77', pccOverride: 'GK5', category: 'DL', dateOffset: 2 },
    ]);
  });

  it('QEB/42*CAB*D4 places with category + dateOffset on the Queue[] element', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(commitResp('QC001'))
      .mockResolvedValueOnce(ok());

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);

    const resp = await host.process('QEB/42*CAB*D4', wa);
    expect(resp).toBe('OK-QUEUE 42');

    const [, init] = fetchSpy.mock.calls[7];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.AgencyQueue?.Queue).toEqual([
      { value: '42', category: 'AB', dateOffset: 4 },
    ]);
  });

  it('QEB/71MG/50+60*CAB*D1 applies branch + qualifiers uniformly across multi-queue chain', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(commitResp('QC002'))
      .mockResolvedValueOnce(ok());

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);

    await host.process('QEB/71MG/50+60*CAB*D1', wa);

    const [, init] = fetchSpy.mock.calls[7];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.AgencyQueue?.Queue).toEqual([
      { value: '50', pccOverride: '71MG', category: 'AB', dateOffset: 1 },
      { value: '60', pccOverride: '71MG', category: 'AB', dateOffset: 1 },
    ]);
  });
});
