/**
 * LiveTravelportBackend — Backend implementation that translates cryptic
 * verbs into Travelport TripServices REST calls against the 7K9S pre-
 * production tenant.
 *
 * **Status: skeleton.** This commit lands the class with its OAuth client
 * and a working air-search method (`airSearch`) that mirrors the
 * already-validated flow from `validate-travelport-creds.ts`. The
 * Backend interface methods that DON'T have a live equivalent yet
 * (PNR persistence, queues, ticket-serial allocation) fall back to a
 * private in-memory shadow — good enough to keep the type system happy
 * while the dispatch wiring catches up.
 *
 * The integration into the Galileo `availability` handler lands in a
 * follow-up commit. Until then, calling `new GdsHost({ backend: new
 * LiveTravelportBackend(creds) })` produces a host that processes
 * everything against the local Inventory but exposes `host.backend
 * .airSearch(...)` for direct use.
 *
 * **Security note** (CLAUDE.md): the OAuth call sends credentials to
 * auth.pp.travelport.net only when an instance is constructed AND a
 * method that requires a token is invoked. The class never sends data
 * on import. `fetchToken` caches the token on the instance and refreshes
 * it before expiry. Credentials are accepted via the constructor (or
 * env vars at the factory) — never written to disk or echoed in logs
 * (we mask tokens the same way validate-travelport-creds.ts does).
 *
 * Sources:
 *   - validate-travelport-creds.ts (in-tree spike, OAuth + search
 *     proven against pre-prod, 2026-05-27)
 *   - https://support.travelport.com/webhelp/jsonair/11 (JSON Air v11
 *     CatalogProductOfferings schema)
 *   - https://developer.travelport.com (developer portal, OAuth flow)
 */

import { Inventory } from '../store/inventory.js';
import { PnrStore } from '../store/pnr-store.js';
import type { Backend } from './backend.js';

export interface LiveTravelportCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

export interface LiveTravelportBackendOptions {
  /** Pre-prod by default; override for production once trial is upgraded. */
  oauthUrl?: string;
  /** API base e.g. "https://api.pp.travelport.net/11" (pre-prod). */
  apiBase?: string;
  /** Pseudo City Code (e.g. "7K9S"). */
  pcc?: string;
  /** Two-letter GDS code (e.g. "1G" for Galileo). */
  gds?: string;
  /** OAuth grant type. Default "password" — Travelport docs disagree on which trials use which. */
  grantType?: string;
  /** Optional `Accept-Version: <n>` header. */
  acceptVersion?: string;
  /** Initial ticket serial — only used for the local stub path, never sent live. */
  initialTicketSerial?: number;
}

interface ResolvedOpts {
  oauthUrl: string;
  apiBase: string;
  pcc: string;
  gds: string;
  grantType: string;
  acceptVersion: string;
}

const DEFAULT_OPTS: ResolvedOpts = {
  oauthUrl: 'https://auth.pp.travelport.net/oauth/token',
  apiBase: 'https://api.pp.travelport.net/11',
  pcc: '7K9S',
  gds: '1G',
  grantType: 'password',
  acceptVersion: '11',
};

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}

/**
 * One air-search call mirrors the validate-travelport-creds spike: a
 * CatalogProductOfferings POST with one one-way ADT slice. The response
 * is returned verbatim — callers (the future Galileo `availability`
 * handler) map it to AvailabilityLine[].
 */
export interface AirSearchRequest {
  origin: string;
  destination: string;
  /** ISO 8601 date (YYYY-MM-DD) — Travelport's CatalogProductOfferings format. */
  departureDate: string;
  /** Default 1 adult; multi-pax pricing arrives with FQ live in a later commit. */
  adults?: number;
}

export class LiveTravelportBackend implements Backend {
  readonly id = 'travelport-1g';
  readonly displayName: string;
  /** Local shadow — only used when the handler doesn't go through the live path. */
  readonly inventory = new Inventory();
  readonly pnrs = new PnrStore();
  readonly queues = new Map<string, string[]>();

  private serial: number;
  private token: TokenCache | undefined;
  private readonly opts: ResolvedOpts;

  constructor(
    private readonly creds: LiveTravelportCredentials,
    opts: LiveTravelportBackendOptions = {}
  ) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.displayName = `Travelport TripServices (${this.opts.gds}, ${this.opts.pcc} pre-prod)`;
    this.serial = opts.initialTicketSerial ?? 4_692_507_094;
  }

  nextTicketSerial(): number {
    // Local stub — real tickets carry vendor-issued numbers from a
    // future TicketIssue REST call.
    return this.serial++;
  }

  /**
   * Lazy OAuth password grant against auth.pp.travelport.net. Caches
   * the token in-memory and refreshes it ~60s before the documented
   * `expires_in`. Throws on auth failure with the upstream status code
   * surfaced so callers can distinguish bad creds (401) from a malformed
   * grant (400).
   */
  async ensureToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.accessToken;
    }
    const body = new URLSearchParams({
      grant_type: this.opts.grantType,
      username: this.creds.username,
      password: this.creds.password,
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
    });
    const res = await fetch(this.opts.oauthUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });
    if (!res.ok) {
      // Don't echo our creds; the upstream response body is theirs to leak.
      const text = await res.text();
      throw new Error(
        `LiveTravelportBackend OAuth failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`
      );
    }
    const json = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      throw new Error('LiveTravelportBackend OAuth: response missing access_token');
    }
    this.token = {
      accessToken: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 0) * 1000,
    };
    return this.token.accessToken;
  }

  /**
   * Air search against TripServices CatalogProductOfferings. Returns the
   * raw JSON response; the Galileo `availability` handler (future
   * commit) maps `CatalogProductOfferingsResponse` to the dialect-shared
   * AvailabilityLine[] shape.
   */
  async airSearch(req: AirSearchRequest): Promise<unknown> {
    const token = await this.ensureToken();
    const url = `${this.opts.apiBase}/air/catalog/search/catalogproductofferings`;
    const adults = req.adults ?? 1;
    // Payload structure sourced verbatim from validate-travelport-creds.ts
    // (proven against 7K9S pre-prod 2026-05-27 — returned 10 offers DEN→FRA).
    const body = {
      CatalogProductOfferingsQueryRequest: {
        CatalogProductOfferingsRequest: {
          '@type': 'CatalogProductOfferingsRequestAir',
          offersPerPage: 10,
          PassengerCriteria: [
            { '@type': 'PassengerCriteria', passengerTypeCode: 'ADT', number: adults },
          ],
          SearchCriteriaFlight: [
            {
              '@type': 'SearchCriteriaFlight',
              departureDate: req.departureDate,
              From: { value: req.origin },
              To: { value: req.destination },
            },
          ],
        },
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // gzip/deflate + no-cache are required by Travelport docs on
        // CatalogProductOfferings — without them the call sporadically
        // returns 415 instead of a 200.
        'Accept-Encoding': 'gzip, deflate',
        'Cache-Control': 'no-cache',
        'Accept-Version': this.opts.acceptVersion,
        'TVP-PCC-CORE': `${this.opts.pcc}_${this.opts.gds}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `LiveTravelportBackend airSearch failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`
      );
    }
    return JSON.parse(text);
  }
}

/**
 * Construct a LiveTravelportBackend from environment variables. Returns
 * undefined when the required creds aren't set — callers (CLI / tests)
 * can fall back to EmulatedBackend gracefully.
 */
export function liveTravelportFromEnv(
  opts?: LiveTravelportBackendOptions
): LiveTravelportBackend | undefined {
  const { TVP_CLIENT_ID, TVP_CLIENT_SECRET, TVP_USERNAME, TVP_PASSWORD } = process.env;
  if (!TVP_CLIENT_ID || !TVP_CLIENT_SECRET || !TVP_USERNAME || !TVP_PASSWORD) return undefined;
  return new LiveTravelportBackend(
    {
      clientId: TVP_CLIENT_ID,
      clientSecret: TVP_CLIENT_SECRET,
      username: TVP_USERNAME,
      password: TVP_PASSWORD,
    },
    opts
  );
}
