/**
 * Capture-then-replay cache tests.
 *
 * Per CLAUDE.md project rule and ROADMAP "Vendor-pacing discipline":
 * dev iteration shouldn't hammer pre-prod. When `TVP_CAPTURE=<file>`
 * is set, every request+response is appended to a JSONL log; when
 * `TVP_REPLAY=<file>` is set, the next exchange is returned without
 * going live.
 *
 * Auth headers are redacted in capture so the recording is shareable.
 * Replay throws when the file runs out (surfacing drift loudly rather
 * than silently re-running queries).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';

const creds = { clientId: 'x', clientSecret: 'y', username: 'z', password: 'w' };
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tvp-replay-test-'));
});

afterEach(() => {
  delete process.env.TVP_CAPTURE;
  delete process.env.TVP_REPLAY;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('LiveTravelportBackend capture-then-replay', () => {
  it('captures request+response to JSONL when TVP_CAPTURE is set', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    process.env.TVP_CAPTURE = capturePath;

    const tokenResp = () =>
      new Response(
        JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    const searchResp = () =>
      new Response(JSON.stringify({ CatalogProductOfferingsResponse: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/oauth/')) return tokenResp();
      return searchResp();
    });

    const b = new LiveTravelportBackend(creds, { pacing: { minMs: 0, maxMs: 0 } });
    await b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-01' });
    fetchSpy.mockRestore();

    expect(existsSync(capturePath)).toBe(true);
    const lines = readFileSync(capturePath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2); // OAuth + airSearch
    const oauth = JSON.parse(lines[0]);
    const search = JSON.parse(lines[1]);
    expect(oauth.request.url).toContain('/oauth/token');
    expect(search.request.url).toContain('/catalogproductofferings');
    expect(search.response.status).toBe(200);
  });

  it('redacts Authorization header in captured request', async () => {
    const capturePath = join(tmpDir, 'capture.jsonl');
    process.env.TVP_CAPTURE = capturePath;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/oauth/')) {
        return new Response(JSON.stringify({ access_token: 'SECRET-TOKEN', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    });

    const b = new LiveTravelportBackend(creds, { pacing: { minMs: 0, maxMs: 0 } });
    await b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-01' });
    fetchSpy.mockRestore();

    const lines = readFileSync(capturePath, 'utf8').trim().split('\n');
    const searchExchange = JSON.parse(lines[1]);
    // The Authorization header in the airSearch request should be redacted.
    const authValue = searchExchange.request.headers.Authorization ?? searchExchange.request.headers.authorization;
    expect(authValue).toBe('<redacted>');
    // But the OAuth POST body (which carries creds) is captured raw — that's
    // a separate consideration the user takes when sharing the file.
  });

  it('replays exchanges from JSONL without hitting fetch', async () => {
    const replayPath = join(tmpDir, 'replay.jsonl');
    const exchanges = [
      {
        request: { method: 'POST', url: 'https://auth.pp.travelport.net/oauth/token', headers: {}, body: 'grant=password' },
        response: { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: 'REPLAY-TOKEN', expires_in: 3600 }) },
      },
      {
        request: { method: 'POST', url: 'https://api.pp.travelport.net/11/air/catalog/search/catalogproductofferings', headers: {}, body: '{}' },
        response: { status: 200, statusText: 'OK', headers: {},
          body: JSON.stringify({ CatalogProductOfferingsResponse: { CatalogProductOfferings: { Identifier: { value: 'FROM-REPLAY' } } } }) },
      },
    ];
    writeFileSync(replayPath, exchanges.map((e) => JSON.stringify(e)).join('\n'));
    process.env.TVP_REPLAY = replayPath;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called in replay mode');
    });

    const b = new LiveTravelportBackend(creds);
    const result = (await b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-01' })) as any;
    fetchSpy.mockRestore();

    expect(result?.CatalogProductOfferingsResponse?.CatalogProductOfferings?.Identifier?.value).toBe('FROM-REPLAY');
  });

  it('throws clearly when replay file is exhausted', async () => {
    const replayPath = join(tmpDir, 'short.jsonl');
    writeFileSync(replayPath, JSON.stringify({
      request: { method: 'POST', url: 'https://auth.pp.travelport.net/oauth/token', headers: {}, body: '' },
      response: { status: 200, statusText: 'OK', headers: {},
        body: JSON.stringify({ access_token: 'TKN', expires_in: 3600 }) },
    }) + '\n');
    process.env.TVP_REPLAY = replayPath;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('replay should not call fetch');
    });

    const b = new LiveTravelportBackend(creds);
    // OAuth call consumes the one-and-only recording entry; the airSearch
    // POST that follows runs out.
    await expect(
      b.airSearch({ origin: 'DEN', destination: 'FRA', departureDate: '2026-07-01' })
    ).rejects.toThrow(/recording exhausted/);
    fetchSpy.mockRestore();
  });
});
