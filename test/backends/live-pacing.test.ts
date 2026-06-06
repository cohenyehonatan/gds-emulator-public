/**
 * Vendor-pacing discipline test.
 *
 * Per CLAUDE.md project rule: "Never probe for limits ... single-worker
 * + 2-5s jitter delays default for hostile targets." Travelport pre-prod
 * doesn't get probed — we pace conservatively regardless of what it'd
 * tolerate. This suite verifies the pacing mechanism behaves as
 * specified:
 *  - Two concurrent requests serialize (single-worker), not parallel.
 *  - Inter-request delay falls in [minMs, maxMs].
 *  - The wall-clock duration of N requests is at least (N-1) × minMs.
 *  - Pacing 0/0 disables the wait (verifies the test default works).
 *
 * Tests explicitly construct backends with `pacing: { minMs, maxMs }`
 * so they bypass the VITEST-detection default.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';

const creds = { clientId: 'x', clientSecret: 'y', username: 'z', password: 'w' };

describe('LiveTravelportBackend vendor pacing', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => fetchSpy?.mockRestore());

  it('serializes concurrent requests (single-worker)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    let inflight = 0;
    let maxInflight = 0;
    const tokenResp = () =>
      new Response(JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/oauth/')) return tokenResp();
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight--;
      return new Response('{"ok":true}', { status: 200 });
    });

    const b = new LiveTravelportBackend(creds, { pacing: { minMs: 10, maxMs: 10 } });
    // Three parallel airSearches — without serialization they'd burst
    // through fetch concurrently; with single-worker each one waits.
    await Promise.all([
      b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-01' }),
      b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-02' }),
      b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-03' }),
    ]);
    expect(maxInflight).toBe(1);
  });

  it('respects minMs between requests', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const tokenResp = () =>
      new Response(JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/oauth/')) return tokenResp();
      return new Response('{"ok":true}', { status: 200 });
    });

    const b = new LiveTravelportBackend(creds, { pacing: { minMs: 50, maxMs: 50 } });
    const start = Date.now();
    await b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-01' });
    await b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-02' });
    await b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-03' });
    const elapsed = Date.now() - start;
    // 3 requests with 50ms minimum delay → at least ~100ms (2 inter-
    // request waits). Allow some slack for setTimeout precision.
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  it('disables pacing entirely when minMs=0 and maxMs=0', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const tokenResp = () =>
      new Response(JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/oauth/')) return tokenResp();
      return new Response('{"ok":true}', { status: 200 });
    });

    const b = new LiveTravelportBackend(creds, { pacing: { minMs: 0, maxMs: 0 } });
    const start = Date.now();
    await Promise.all([
      b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-01' }),
      b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-02' }),
      b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-03' }),
    ]);
    const elapsed = Date.now() - start;
    // With pacing disabled, three parallel mocked requests should finish
    // very quickly. We don't lock down an exact number (CI jitter) but
    // anything beyond ~50ms means pacing fired.
    expect(elapsed).toBeLessThan(50);
  });

  it('failures DO consume a slot — no burst-retry on a stuck endpoint', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue(new Response('"Internal Server Error"', { status: 500 }));

    const b = new LiveTravelportBackend(creds, { pacing: { minMs: 30, maxMs: 30 } });
    const start = Date.now();
    // Two failures back-to-back — should still pace, not burst-retry.
    await b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-01' }).catch(() => {});
    await b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-02' }).catch(() => {});
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25);
  });
});
