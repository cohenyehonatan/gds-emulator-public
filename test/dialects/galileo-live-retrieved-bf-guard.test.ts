/**
 * Live guard: the on-screen BF is a RETRIEVED committed one
 * (wa.pnr.locator set). Building against it used to open a BLANK
 * workbench (createWorkbench, not buildfromlocator) — and ER would
 * then commit that workbench as a phantom NEW BF duplicating fields.
 *
 * Dogfooding find (2026-06-12 session log): the operator queue-
 * retrieved GZWF93, added R., and ER'd — walking straight into the
 * stray-workbench path. Until the buildfromlocator modify flow
 * lands, every such entry refuses honestly instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

const REFUSAL = 'BF GZWF93 IS COMMITTED - LIVE MODIFY NOT SUPPORTED - USE I TO RELEASE';

describe('Galileo live retrieved-BF modify guard', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const backend = new LiveTravelportBackend({ clientId: 'x', clientSecret: 'y', username: 'z', password: 'w' });
    host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend });
    wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    // Simulate a queue-/locator-retrieved committed BF on screen.
    wa.pnr.locator = 'GZWF93';
    wa.pnr.names.push({ count: 1, surname: 'COHEN', passengers: [{ firstName: 'YEHONATAN' }] } as never);
    wa.pnr.phones.push({ number: '1-9293177108' });
    wa.pnr.ticketing = 'TAU/29JUN';
    wa.pnr.segments.push({
      segmentNumber: 1, carrier: 'B6', flightNumber: '1873', bookingClass: 'O',
      date: '01JUL', dayOfWeek: 'W', dayOfWeekNum: 3, origin: 'EWR', destination: 'LAX',
      status: 'HK', seats: 1, departTime: '700A', arriveTime: '1015A',
    });
  });

  afterEach(() => fetchSpy.mockRestore());

  it('N. refuses — no blank workbench is created', async () => {
    const calls = fetchSpy.mock.calls.length;
    expect(await host.process('N.SMITH/AMSTR', wa)).toBe(REFUSAL);
    expect(wa.liveWorkbenchId).toBeUndefined();
    expect(fetchSpy.mock.calls.length).toBe(calls); // not even a token fetch
  });

  it('P. refuses — no blank workbench is created', async () => {
    expect(await host.process('P.1-5550000', wa)).toBe(REFUSAL);
    expect(wa.liveWorkbenchId).toBeUndefined();
  });

  it('R. stays local (audit posture), but ER then refuses to commit', async () => {
    expect(await host.process('R.PASSENGER', wa)).toBe('OK');
    const calls = fetchSpy.mock.calls.length;
    expect(await host.process('ER', wa)).toBe(REFUSAL);
    expect(fetchSpy.mock.calls.length).toBe(calls); // no commit POST
  });

  it('ER refuses even with a stray workbench open (never commits it)', async () => {
    wa.liveWorkbenchId = 'WB-STRAY';
    await host.process('R.PASSENGER', wa);
    expect(await host.process('ER', wa)).toBe(REFUSAL);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/reservationworkbench'))).toBe(false);
  });
});
