import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo QEB/<queue> parsing', () => {
  it('parses QEB/<n> as queue place', () => {
    const r = parseGalileoEntry('QEB/43');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.op).toBe('place');
      expect(r.queue).toBe('43');
    }
  });

  it('rejects malformed QEB', () => {
    expect(() => parseGalileoEntry('QEB')).toThrow();
    expect(() => parseGalileoEntry('QEB/')).toThrow();
    expect(() => parseGalileoEntry('QEB/abc-def')).toThrow();  // dash not allowed
  });
});

describe('Galileo live QEB/<queue> — end-tx + queue place', () => {
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
  const createWb = () =>
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-Q' } } }), {
      status: 201, headers: { 'Content-Type': 'application/json' },
    });
  const searchResp = () =>
    new Response(JSON.stringify({
      CatalogProductOfferingsResponse: {
        CatalogProductOfferings: {
          CatalogProductOffering: [{
            Identifier: { value: 'OFF-001' },
            ProductBrandOptions: [{
              Flight: [{
                carrier: 'UA', number: 1234,
                Departure: { location: 'DEN', time: '2026-06-27T08:00:00Z' },
                Arrival: { location: 'FRA', time: '2026-06-28T07:30:00Z' },
              }],
              ProductBrandOffering: [{ FareDetail: [{ BookingCode: { code: 'Y', count: 9 } }] }],
            }],
          }],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const commitResp = (loc: string) =>
    new Response(JSON.stringify({
      Receipt: [{ Confirmation: { Locator: { value: loc, authority: 'Travelport' } } }],
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

  it('QEB/<n> during build commits then POSTs /queue/queue with locator + queue number', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                  // addOffer
      .mockResolvedValueOnce(ok())                  // addTraveler
      .mockResolvedValueOnce(ok())                  // addPrimaryContact
      .mockResolvedValueOnce(commitResp('QBF001')) // commit (from QEB)
      .mockResolvedValueOnce(ok());                 // placeOnQueue

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    const resp = await host.process('QEB/43', wa);

    expect(resp).toBe('OK-QUEUE 43');
    expect(wa.pnr.locator).toBe('QBF001');

    // Inspect the queue-place POST:
    const [queueUrl, queueInit] = fetchSpy.mock.calls[7];
    expect(queueUrl).toContain('/air/queue/queue');
    const body = JSON.parse((queueInit?.body as string) ?? '{}');
    expect(body.QueuePlaceQuery?.LocatorCode).toBe('QBF001');
    expect(body.QueuePlaceQuery?.QueueNumber).toBe('43');
  });

  it('QEB/<n> without any built BF rejects via the mandatory-field check (no commit attempted)', async () => {
    const resp = await host.process('QEB/43', wa);
    // Empty PNR fails the PHONE check first (Pnr.missingMandatory order).
    expect(resp).toMatch(/USE [PRINT.\s]/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('5xx from /queue/queue surfaces as LIVE BACKEND ERROR; locator stamped, queue NOT added', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                  // addOffer
      .mockResolvedValueOnce(ok())                  // addTraveler
      .mockResolvedValueOnce(ok())                  // addPrimaryContact
      .mockResolvedValueOnce(commitResp('QBF002')) // commit succeeds
      .mockResolvedValueOnce(new Response('"down"', { status: 503, statusText: 'Service Unavailable' }));

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    const resp = await host.process('QEB/43', wa);

    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(wa.pnr.locator).toBe('QBF002');  // commit DID happen
    // The shared queues map should NOT have an entry (since live placement failed)
    expect(host.backend.queues.get('43') ?? []).not.toContain('QBF002');
  });

  it('emulated QEB places locally without any fetch', async () => {
    const emulatedHost = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);
    await emulatedHost.process('A15JUNJFKLAX', ewa);
    await emulatedHost.process('N1Y1', ewa);
    await emulatedHost.process('N.SMITH/JOHN MR', ewa);
    await emulatedHost.process('P.LON*02012345678', ewa);
    await emulatedHost.process('T.TAU/10JUN', ewa);
    await emulatedHost.process('R.AGT', ewa);
    const resp = await emulatedHost.process('QEB/43', ewa);
    expect(resp).toBe('OK-QUEUE 43');
    expect(ewa.pnr.locator).toMatch(/^[A-Z0-9]{6}$/);
    expect(emulatedHost.backend.queues.get('43')).toContain(ewa.pnr.locator);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
