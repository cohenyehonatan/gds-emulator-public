/**
 * Per-request deadline on every live fetch.
 *
 * Dogfooding find (2026-06-12 session log): an ER whose live commit
 * stalled produced NO response for 5 minutes — undici's default
 * headers timeout — while the operator stared at a silent terminal
 * and eventually restarted the server. Worst case must be a fast
 * LIVE BACKEND ERROR, never silence.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';

const creds = { clientId: 'x', clientSecret: 'y', username: 'z', password: 'w' };

describe('LiveTravelportBackend request timeout', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => fetchSpy?.mockRestore());

  /** A fetch that never settles on its own — only the abort signal
   *  can end it, exactly like a stalled TCP connection. */
  function stalledFetch() {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit)?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new DOMException('timed out', 'TimeoutError')))
          );
        }) as Promise<Response>
    );
  }

  it('a stalled request rejects at requestTimeoutMs with a useful message', async () => {
    stalledFetch();
    const b = new LiveTravelportBackend(creds, { requestTimeoutMs: 50 });
    const started = Date.now();
    await expect(
      b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-01' })
    ).rejects.toThrow(/timed out after 50ms — POST .*oauth/);
    expect(Date.now() - started).toBeLessThan(2000); // seconds, not undici's 5 minutes
  });

  it('every request carries an abort signal even at the 30s default', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    let seenSignal: AbortSignal | null | undefined;
    fetchSpy.mockImplementation(async (_input, init) => {
      seenSignal = (init as RequestInit)?.signal;
      return new Response(JSON.stringify({ access_token: 'T', token_type: 'Bearer', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const b = new LiveTravelportBackend(creds);
    await b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-01' }).catch(() => {});
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });
});
