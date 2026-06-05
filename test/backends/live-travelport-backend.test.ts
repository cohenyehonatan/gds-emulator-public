import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LiveTravelportBackend,
  liveTravelportFromEnv,
} from '../../src/backends/live-travelport-backend.js';

describe('LiveTravelportBackend — class wiring', () => {
  const creds = {
    clientId: 'test-id',
    clientSecret: 'test-secret',
    username: 'test-user',
    password: 'test-pw',
  };

  it('exposes a Backend-compatible interface (id / displayName / inventory / pnrs / queues)', () => {
    const b = new LiveTravelportBackend(creds);
    expect(b.id).toBe('travelport-1g');
    expect(b.displayName).toContain('Travelport TripServices');
    expect(b.displayName).toContain('1G');
    expect(b.displayName).toContain('7K9S');
    expect(b.inventory).toBeDefined();
    expect(b.pnrs).toBeDefined();
    expect(b.queues).toBeInstanceOf(Map);
  });

  it('does not send any network requests at construction time', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    new LiveTravelportBackend(creds);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('nextTicketSerial increments monotonically (local stub)', () => {
    const b = new LiveTravelportBackend(creds, { initialTicketSerial: 100 });
    expect(b.nextTicketSerial()).toBe(100);
    expect(b.nextTicketSerial()).toBe(101);
  });

  it('uses pre-prod defaults for oauthUrl/apiBase/pcc/gds', () => {
    const b = new LiveTravelportBackend(creds);
    // Not exposed directly — assert via displayName
    expect(b.displayName).toMatch(/7K9S pre-prod/);
  });
});

describe('LiveTravelportBackend — OAuth token caching (mocked fetch)', () => {
  const creds = {
    clientId: 'test-id',
    clientSecret: 'test-secret',
    username: 'test-user',
    password: 'test-pw',
  };
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function tokenResponse(token: string, expiresIn = 3600): Response {
    return new Response(
      JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: expiresIn }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  it('ensureToken caches the access_token across calls', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse('AAA-token'));
    const b = new LiveTravelportBackend(creds);
    const t1 = await b.ensureToken();
    const t2 = await b.ensureToken();
    expect(t1).toBe('AAA-token');
    expect(t2).toBe('AAA-token');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('ensureToken refetches when the cached token is about to expire', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse('first', 30)) // expires in 30s
      .mockResolvedValueOnce(tokenResponse('second', 3600));
    const b = new LiveTravelportBackend(creds);
    const t1 = await b.ensureToken();
    const t2 = await b.ensureToken(); // 30s < 60s buffer → refetch
    expect(t1).toBe('first');
    expect(t2).toBe('second');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('ensureToken throws with the upstream status on auth failure', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"error":"invalid_client"}', { status: 401, statusText: 'Unauthorized' })
    );
    const b = new LiveTravelportBackend(creds);
    await expect(b.ensureToken()).rejects.toThrow(/HTTP 401/);
  });

  it('airSearch posts to the catalog endpoint with the bearer token + PCC header', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse('search-token'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ CatalogProductOfferingsResponse: { offers: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    const b = new LiveTravelportBackend(creds);
    const json = (await b.airSearch({
      origin: 'DEN',
      destination: 'FRA',
      departureDate: '2026-06-27',
    })) as { CatalogProductOfferingsResponse: { offers: unknown[] } };
    expect(json.CatalogProductOfferingsResponse).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [searchUrl, searchInit] = fetchSpy.mock.calls[1];
    expect(searchUrl).toContain('/air/catalog/search/catalogproductofferings');
    const headers = searchInit?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe('Bearer search-token');
    expect(headers?.['TVP-PCC-CORE']).toBe('7K9S_1G');
  });
});

describe('liveTravelportFromEnv factory', () => {
  it('returns undefined when required env vars are absent', () => {
    const saved = {
      id: process.env.TVP_CLIENT_ID,
      secret: process.env.TVP_CLIENT_SECRET,
      user: process.env.TVP_USERNAME,
      pw: process.env.TVP_PASSWORD,
    };
    delete process.env.TVP_CLIENT_ID;
    delete process.env.TVP_CLIENT_SECRET;
    delete process.env.TVP_USERNAME;
    delete process.env.TVP_PASSWORD;
    expect(liveTravelportFromEnv()).toBeUndefined();
    if (saved.id) process.env.TVP_CLIENT_ID = saved.id;
    if (saved.secret) process.env.TVP_CLIENT_SECRET = saved.secret;
    if (saved.user) process.env.TVP_USERNAME = saved.user;
    if (saved.pw) process.env.TVP_PASSWORD = saved.pw;
  });

  it('returns a LiveTravelportBackend when all four env vars are present', () => {
    const saved = {
      id: process.env.TVP_CLIENT_ID,
      secret: process.env.TVP_CLIENT_SECRET,
      user: process.env.TVP_USERNAME,
      pw: process.env.TVP_PASSWORD,
    };
    process.env.TVP_CLIENT_ID = 'x';
    process.env.TVP_CLIENT_SECRET = 'y';
    process.env.TVP_USERNAME = 'z';
    process.env.TVP_PASSWORD = 'w';
    const b = liveTravelportFromEnv();
    expect(b).toBeDefined();
    expect(b?.id).toBe('travelport-1g');
    if (saved.id !== undefined) process.env.TVP_CLIENT_ID = saved.id;
    else delete process.env.TVP_CLIENT_ID;
    if (saved.secret !== undefined) process.env.TVP_CLIENT_SECRET = saved.secret;
    else delete process.env.TVP_CLIENT_SECRET;
    if (saved.user !== undefined) process.env.TVP_USERNAME = saved.user;
    else delete process.env.TVP_USERNAME;
    if (saved.pw !== undefined) process.env.TVP_PASSWORD = saved.pw;
    else delete process.env.TVP_PASSWORD;
  });
});

describe('LiveTravelportBackend — GdsHost wiring', () => {
  it('plugs into GdsHost.backend just like EmulatedBackend does', async () => {
    const { GdsHost } = await import('../../src/session/gds-host.js');
    const backend = new LiveTravelportBackend({
      clientId: 'x', clientSecret: 'y', username: 'z', password: 'w',
    });
    const host = new GdsHost({ port: 0, logLevel: 'error', backend });
    expect(host.backend).toBe(backend);
    expect(host.backend.id).toBe('travelport-1g');
  });
});

describe('LiveTravelportBackend — createWorkbench response shapes', () => {
  const creds = {
    clientId: 'x',
    clientSecret: 'y',
    username: 'z',
    password: 'w',
  };
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchSpy.mockRestore());

  it('extracts wbId from ReservationResponse.Reservation.Identifier (verified pre-prod shape)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ReservationResponse: {
              '@type': 'ReservationResponse',
              Reservation: {
                '@type': 'Reservation',
                Identifier: { authority: 'Travelport', value: 'WB-CANONICAL' },
              },
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      );
    const b = new LiveTravelportBackend(creds);
    expect(await b.createWorkbench()).toBe('WB-CANONICAL');
  });

  it('still accepts legacy ReservationWorkbench.Identifier shape (defensive fallback)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-LEGACY' } } }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      );
    const b = new LiveTravelportBackend(creds);
    expect(await b.createWorkbench()).toBe('WB-LEGACY');
  });

  it('throws when no recognized Identifier path is present', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ Unrelated: {} }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    const b = new LiveTravelportBackend(creds);
    await expect(b.createWorkbench()).rejects.toThrow(/missing workbenchID/);
  });
});
