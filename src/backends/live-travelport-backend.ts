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
  /**
   * Polite-citizen flag: when true, Galileo `R.<initials>` posts the
   * agent identifier to the workbench via `/reservationcomments/list`
   * with `commentSource: "Agency"`. The server's OAuth token already
   * identifies the agent for audit purposes; this opt-in mirrors the
   * identifier into the BF body where other agents reviewing the file
   * see it.
   *
   * Off by default — R. stays local-only without it (matching the
   * spec doc's ⛔ posture).
   */
  politeReceivedFromAudit?: boolean;
}

interface ResolvedOpts {
  oauthUrl: string;
  apiBase: string;
  pcc: string;
  gds: string;
  grantType: string;
  acceptVersion: string;
  politeReceivedFromAudit: boolean;
}

const DEFAULT_OPTS: ResolvedOpts = {
  oauthUrl: 'https://auth.pp.travelport.net/oauth/token',
  apiBase: 'https://api.pp.travelport.net/11',
  pcc: '7K9S',
  gds: '1G',
  grantType: 'password',
  acceptVersion: '11',
  politeReceivedFromAudit: false,
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

/**
 * Options for cancelWorkbenchItems. Either `all: true` (full cancel
 * → `cancelAllInd: true` body) OR supply `offerIds` (offer-targeted
 * cancel). Setting both with `all: true` wins.
 */
export interface CancelWorkbenchOpts {
  /** `cancelAllInd: true` — cancel everything in the workbench. */
  all?: boolean;
  /** Travelport offer IDs to cancel; one entry per offer. */
  offerIds?: string[];
  /** `sendPassiveNotificationInd: true` — passive cancel (no airline message). */
  passive?: boolean;
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
  /** Surface the polite-citizen flag so handlers can branch on it. */
  get politeReceivedFromAudit(): boolean {
    return this.opts.politeReceivedFromAudit;
  }

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
   * The full TripServices header set, verbatim from
   * references/galileo/Travelport-JSON-Air-v11-API-Spec.md. Required
   * on every endpoint; centralized so each new live-op method just
   * spreads it. gzip/deflate + no-cache are not optional — without
   * them the server sporadically returns 415 instead of 200.
   */
  private async tripServicesHeaders(): Promise<Record<string, string>> {
    const token = await this.ensureToken();
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Cache-Control': 'no-cache',
      'Accept-Version': this.opts.acceptVersion,
      // The canonical Postman devkit sets BOTH Accept-Version and
      // Content-Version on every call. Omitting Content-Version is what
      // caused addOffer to 400 with generic INVALID INPUT FORMAT —
      // search/createWorkbench/fareDisplay coincidentally accept the
      // single Accept-Version header but the body-validating endpoints
      // gate on Content-Version too.
      'Content-Version': this.opts.acceptVersion,
      'TVP-PCC-CORE': `${this.opts.pcc}_${this.opts.gds}`,
    };
  }

  /**
   * Shared POST helper: same headers, same error handling. `label` is
   * surfaced in the error message so call sites get clear failure
   * attribution without each having to redo the boilerplate.
   */
  /**
   * Walk a response body looking for Travelport's standard error
   * envelope: `<Endpoint>Response.Result.Error[].Message`. Pre-prod
   * returns HTTP 200 with these errors buried inside the body on
   * server-side validation failures (commit returned 200 with
   * "TELEPHONE IS A REQUIRED FIELD" inside ReservationResponse.Result.
   * Error[0].Message), so a bare `res.ok` check silently misses them.
   * Throws if any Error[] node carries a Message string.
   */
  private assertNoSemanticErrors(parsed: unknown, label: string): void {
    const messages: string[] = [];
    const walk = (node: unknown, depth = 0): void => {
      if (depth > 8 || node == null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, depth + 1);
        return;
      }
      const record = node as Record<string, unknown>;
      if (typeof record.Message === 'string' && record.Message.length > 0) {
        const category = typeof record.category === 'string' ? record.category : '?';
        const status = typeof record.StatusCode === 'number' ? record.StatusCode : '?';
        messages.push(`[${category}/${status}] ${record.Message}`);
      }
      for (const v of Object.values(record)) walk(v, depth + 1);
    };
    walk(parsed);
    if (messages.length > 0) {
      throw new Error(
        `LiveTravelportBackend ${label} server-side validation failure: ${messages.join('; ')}`
      );
    }
  }

  private async postJson(url: string, body: unknown, label: string): Promise<unknown> {
    const headers = await this.tripServicesHeaders();
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `LiveTravelportBackend ${label} failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`
      );
    }
    const parsed = JSON.parse(text);
    this.assertNoSemanticErrors(parsed, label);
    return parsed;
  }

  /** Shared GET helper with the same header/error treatment as postJson. */
  private async getJson(url: string, label: string): Promise<unknown> {
    const headers = await this.tripServicesHeaders();
    const res = await fetch(url, { method: 'GET', headers });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `LiveTravelportBackend ${label} failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`
      );
    }
    const parsed = JSON.parse(text);
    this.assertNoSemanticErrors(parsed, label);
    return parsed;
  }

  /** Shared PUT helper for status-update endpoints (e.g. void). */
  private async putJson(url: string, body: unknown, label: string): Promise<unknown> {
    const headers = await this.tripServicesHeaders();
    const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `LiveTravelportBackend ${label} failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`
      );
    }
    const parsed = text ? JSON.parse(text) : {};
    this.assertNoSemanticErrors(parsed, label);
    return parsed;
  }

  /**
   * Shared DELETE helper. Many DELETE endpoints respond 204 No Content
   * or an empty body — tolerate both.
   */
  private async deleteJson(url: string, label: string): Promise<unknown> {
    const headers = await this.tripServicesHeaders();
    const res = await fetch(url, { method: 'DELETE', headers });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `LiveTravelportBackend ${label} failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`
      );
    }
    const parsed = text ? JSON.parse(text) : {};
    this.assertNoSemanticErrors(parsed, label);
    return parsed;
  }

  /**
   * Air search against TripServices CatalogProductOfferings. Returns the
   * raw JSON response; the Galileo `availability` handler maps
   * `CatalogProductOfferingsResponse` to the dialect-shared
   * AvailabilityLine[] shape via `mapCatalogProductOfferings`.
   */
  async airSearch(req: AirSearchRequest): Promise<unknown> {
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
    return this.postJson(url, body, 'airSearch');
  }

  /**
   * Create a new Travelport reservation workbench. Returns the
   * workbenchID; callers stash it on `wa.liveWorkbenchId` so subsequent
   * cryptic entries (sell of another offer, add traveler, commit) all
   * target the same workspace.
   *
   * Source: references/galileo/Travelport-JSON-Air-v11-API-Spec.md
   * (POST /11/air/book/session/reservationworkbench).
   *
   * Workbench TTL is 30 minutes server-side; we don't track expiry
   * locally — if a follow-on call comes back with a 404/410, the
   * Galileo handler treats it as "workbench gone" and creates a fresh
   * one. (Not implemented in this commit; for now the agent has to
   * IG to clear state.)
   */
  /**
   * Discard an open reservation workbench server-side. Polite-citizen
   * call from `I` / `IR` — the workbench would otherwise sit until its
   * 30-minute TTL expires. Failures are non-fatal at the dispatch layer
   * (cryptic users still see `IGNORED` even if the server returned 5xx)
   * but we surface the rejection here so callers can log.
   *
   * Source: DELETE /11/air/book/session/reservationworkbench/{workbenchID}
   */
  async deleteWorkbench(workbenchId: string): Promise<void> {
    const url =
      `${this.opts.apiBase}/air/book/session/reservationworkbench/${encodeURIComponent(workbenchId)}`;
    await this.deleteJson(url, 'deleteWorkbench');
  }

  async createWorkbench(): Promise<string> {
    const url = `${this.opts.apiBase}/air/book/session/reservationworkbench`;
    // Minimal payload per the spec; the workbench is created empty and
    // populated via subsequent endpoints.
    const json = (await this.postJson(url, {}, 'createWorkbench')) as any;
    // VERIFIED PRE-PROD 2026-06-05: pre-prod returns a Reservation
    // envelope (the workbench IS the in-progress reservation), NOT the
    // ReservationWorkbench envelope the docs imply — see
    // references/galileo/Travelport-JSON-Air-v11-API-Spec.md "Verified
    // response shapes". Other paths kept as defensive fallbacks against
    // tenant/version drift.
    const id =
      json?.ReservationResponse?.Reservation?.Identifier?.value ??
      json?.ReservationWorkbench?.Identifier?.value ??
      json?.Workbench?.Identifier?.value ??
      json?.Identifier?.value ??
      json?.workbenchID ??
      json?.workbenchId;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('LiveTravelportBackend createWorkbench: response missing workbenchID');
    }
    return id;
  }

  /**
   * Add a CatalogProductOffering to an existing workbench by reference.
   * `offerId` is the `Identifier.value` captured by the mapper as
   * `AvailabilityLine.vendorRef.offerId` during the preceding search.
   *
   * Source: POST /11/air/book/airoffer/reservationworkbench/{workbenchID}
   * /offers/buildfromcatalogproductofferings — request shape `OfferQueryRef`
   * with `SearchOfferId` and `PassengerCriteria`.
   *
   * Returns the raw response so a Galileo serializer can map it to a
   * sold-segment echo. Multi-pax sells are supported by passing
   * `adults > 1` (matches `N<seats>...` cryptic semantics).
   */
  /**
   * Standalone price-an-offer call (no workbench needed).
   *
   * Source: POST /11/air/price/offers/buildfromcatalogproductofferings —
   * "Price offers using reference payload". Used by Galileo `FQ`'s
   * live path: pull a `vendorRef.offerId` from cached availability,
   * post it, get back a priced offer that maps to FareQuote.
   *
   * ⚠️ NOT YET VALIDATED LIVE. Body shape inherited from the
   * pre-2026-06-05 addOffer envelope (`OfferQueryRef`/`SearchOfferId`).
   * That envelope was proven WRONG for addOffer (pre-prod returns
   * "INVALID INPUT FORMAT"); priceOffer almost certainly needs the
   * same three-ID canonical body (`OfferQueryBuildFromCatalogProduct-
   * Offerings` with searchIdentifier + offerId + productId). Fix when
   * the FQ-live validation pass runs.
   */
  async priceOffer(offerId: string, adults = 1): Promise<unknown> {
    const url =
      `${this.opts.apiBase}/air/price/offers/buildfromcatalogproductofferings`;
    const body = {
      OfferQueryRef: {
        SearchOfferId: offerId,
        PassengerCriteria: [{ number: adults, passengerTypeCode: 'ADT' }],
      },
    };
    return this.postJson(url, body, 'priceOffer');
  }

  /**
   * Add a CatalogProductOffering to a workbench by reference. The
   * canonical body (VERIFIED PRE-PROD 2026-06-05 against
   * `APIRef_AddOfferRefPayload.htm`) needs THREE identifiers:
   * - `searchIdentifier` — the search-transaction UUID from
   *   `CatalogProductOfferingsResponse.CatalogProductOfferings.Identifier.value`
   * - `offerId` — the per-offer short ref (`o1`/`o2`/...) from
   *   `CatalogProductOffering.id`
   * - `productId` — the per-product short ref (`p0`/`p1`/...) from
   *   `ProductBrandOffering[].Product[].productRef`
   *
   * Earlier code sent `{ OfferQueryRef: { SearchOfferId } }` which
   * pre-prod rejected with bare "INVALID INPUT FORMAT" (no field-level
   * detail, because the entire envelope was wrong). The PassengerCriteria
   * field that used to be on the request body isn't part of the canonical
   * shape — passenger count is implicit in the search context.
   */
  async addOffer(
    workbenchId: string,
    opts: { searchIdentifier: string; offerId: string; productId: string }
  ): Promise<unknown> {
    const url =
      `${this.opts.apiBase}/air/book/airoffer/reservationworkbench/${encodeURIComponent(workbenchId)}` +
      `/offers/buildfromcatalogproductofferings`;
    const body = {
      OfferQueryBuildFromCatalogProductOfferings: {
        BuildFromCatalogProductOfferingsRequest: {
          '@type': 'BuildFromCatalogProductOfferingsRequestAir',
          CatalogProductOfferingsIdentifier: {
            Identifier: { value: opts.searchIdentifier },
          },
          CatalogProductOfferingSelection: [
            {
              CatalogProductOfferingIdentifier: {
                Identifier: { value: opts.offerId },
              },
              ProductIdentifier: [
                { Identifier: { value: opts.productId } },
              ],
            },
          ],
        },
      },
    };
    return this.postJson(url, body, 'addOffer');
  }

  /**
   * Add one ADT traveler to an existing workbench.
   *
   * Source: POST /11/air/book/traveler/reservationworkbench/{workbenchID}
   * /travelers — body `{ Traveler: [{ passengerTypeCode, PersonName:
   * { Given, Surname }, Telephone?, Email? }] }`.
   *
   * Multi-traveler entries (`N.3SMITH/JOHN MR/JANE MRS/...`) post one
   * Traveler element per passenger; this v1 emits exactly one and the
   * caller is responsible for one-name-per-call sequencing. Multi-pax
   * Travelport batching deferred (the multi-traveler endpoint is
   * `/travelers/list`).
   */
  /**
   * Add a primary-contact phone to a workbench.
   *
   * Source: POST /11/air/book/primarycontact/reservationworkbench/{wbID}
   * /primarycontacts. The exact body shape isn't pinned down in the
   * spec endpoint list; we use the documented `PrimaryContact.Telephone`
   * shape (mirrors what `addTraveler` posts for inline telephones).
   *
   * The Galileo P. field carries broader payloads than a phone number
   * (agency T*, hotel A*, business B*, email E*). We pass `phone` as
   * the raw text and let TripServices validate it server-side — the
   * cryptic surface doesn't pre-parse the role.
   */
  /**
   * Add a form of payment to a workbench.
   *
   * Source: POST /11/air/payment/reservationworkbench/{wbID}/formofpayment.
   * Without a FOP set on the workbench, the commit can't issue tickets —
   * it just creates a held reservation (BF without TE/TK lines). For the
   * Galileo live-TKP flow, this is the missing prerequisite: post a FOP,
   * then commit, and the response carries the issued tickets in the
   * Receipt block.
   *
   * v1 only emits cash FOPs. The full Mini Guide v2 TMU<n>F<form> grammar
   * (cash, nonref, credit cards, government warrants) hasn't been wired
   * yet on the cryptic side; when it is, the live handler can map TMU
   * payloads through this method by extending the `fop` parameter.
   */
  async addFormOfPayment(
    workbenchId: string,
    fop:
      | { kind: 'cash'; nonRefundable?: boolean }
      | {
          kind: 'credit_card';
          brand: string;
          pan: string;
          expiry: string; // MMYY
          holderName?: string;
        } = { kind: 'cash' }
  ): Promise<unknown> {
    const url =
      `${this.opts.apiBase}/air/payment/reservationworkbench/${encodeURIComponent(workbenchId)}` +
      `/formofpayment`;
    // Canonical bodies verified from `APIRef_AddFOP.htm` (2026-05-29).
    // Top-level discriminator: `FormOfPaymentCash` vs
    // `FormOfPaymentPaymentCard`. Replaces the previous best-guess
    // `{ FormOfPayment: [{ Type: "Cash" }] }` body — same bug class
    // as the cancel/queue-place body fixes earlier.
    let body: Record<string, unknown>;
    if (fop.kind === 'cash') {
      body = {
        FormOfPaymentCash: {
          id: 'formOfPayment_1',
          FormOfPaymentRef: 'formOfPayment_1',
          ...(fop.nonRefundable ? { agentNonRefundableInd: true } : {}),
        },
      };
    } else {
      body = {
        FormOfPaymentPaymentCard: {
          id: 'formOfPayment_1',
          FormOfPaymentRef: 'formOfPayment_1',
          PaymentCard: {
            '@type': 'PaymentCardDetail',
            id: 'paymentCard_1',
            CardType: 'Credit',
            CardCode: fop.brand,
            CardNumber: { '@type': 'CardNumber', PlainText: fop.pan },
            expireDate: fop.expiry,
            ...(fop.holderName ? { CardHolderName: fop.holderName } : {}),
          },
        },
      };
    }
    return this.postJson(url, body, 'addFormOfPayment');
  }

  async addPrimaryContact(workbenchId: string, phone: string): Promise<unknown> {
    const url =
      `${this.opts.apiBase}/air/book/primarycontact/reservationworkbench/${encodeURIComponent(workbenchId)}` +
      `/primarycontacts`;
    const body = {
      PrimaryContact: [{ Telephone: [{ phoneNumber: phone, role: 'Mobile' }] }],
    };
    return this.postJson(url, body, 'addPrimaryContact');
  }

  /**
   * Add one or more SSRs to a workbench. Source: canonical body from
   * `Book/RemarksGuide.htm` (verified 2026-05-29).
   *
   * Each request item carries:
   *  - `ssrCode`: 4-char IATA SSR code (VGML, WCHR, INFT, ...)
   *  - `travelerId`: server-assigned UUID from a prior addTraveler
   *    (omit / pass `undefined` for whole-BF scope; the body emits an
   *    empty TravelerIdentifier and pre-prod will surface whether
   *    that's accepted)
   *  - `offerId`: workbench / search-side offer identifier the SSR
   *    applies to (similar v1-omit behaviour)
   *  - `freeText`: optional ≤127-char free text
   *
   * The Identifier.value field is required by the schema; we generate
   * a client-side UUID via `crypto.randomUUID()`. Pre-prod will say
   * whether the server accepts client-generated values or rewrites
   * them.
   */
  async addSpecialServices(
    workbenchId: string,
    requests: Array<{
      ssrCode: string;
      travelerId?: string;
      offerId?: string;
      freeText?: string;
    }>
  ): Promise<unknown> {
    const url =
      `${this.opts.apiBase}/air/book/specialservices/reservationworkbench/${encodeURIComponent(workbenchId)}` +
      `/specialservices/list`;
    const body = {
      SpecialServiceListRequest: {
        SpecialServiceID: requests.map((r, i) => {
          const entry: Record<string, unknown> = {
            '@type': 'SpecialService',
            id: `specialService_${i + 1}`,
            Identifier: { authority: 'Travelport', value: crypto.randomUUID() },
            SSRCode: r.ssrCode,
          };
          if (r.travelerId) {
            entry.TravelerIdentifier = {
              id: `trav_${i + 1}`,
              Identifier: { value: r.travelerId },
            };
          }
          if (r.offerId) {
            entry.AppliesTo = {
              '@type': 'AppliesToOffer',
              OfferIdentifier: [
                {
                  id: `o${i}`,
                  offerRef: `o${i}`,
                  Identifier: { authority: 'Travelport', value: r.offerId },
                },
              ],
            };
          }
          if (r.freeText) entry.FreeText = r.freeText;
          return entry;
        }),
      },
    };
    return this.postJson(url, body, 'addSpecialServices');
  }

  /**
   * Fare rules from a prior fare-display result. Source:
   * `APIRef_FareRules.htm` "After Fare Display (GDS Only)" variant
   * (verified 2026-06-03). GET, query-only — no body.
   *
   * Used by Galileo `FN<...>` after a successful `FD<...>` cached
   * its `Identifier.value` + per-line sequence on the WA.
   *
   * `fareRuleType` is `ShortText` or `LongText` only — the
   * `/fromfaredisplay` variant doesn't support `Structured`. v1 uses
   * `LongText` by default (gives the agent the readable narrative
   * the cryptic `FN*<line>/ALL` is meant to render).
   */
  async fareRulesFromFareDisplay(opts: {
    fareRuleIdentifier: string;
    FareID: number | string;
    fareRuleType?: 'ShortText' | 'LongText';
  }): Promise<unknown> {
    const type = opts.fareRuleType ?? 'LongText';
    const params = new URLSearchParams({
      fareRuleIdentifier: opts.fareRuleIdentifier,
      FareID: String(opts.FareID),
      fareRuleType: type,
    });
    const url = `${this.opts.apiBase}/air/farerule/farerules/fromfaredisplay?${params.toString()}`;
    return this.getJson(url, 'fareRulesFromFareDisplay');
  }

  /**
   * Fare display — list published fares for an O&D pair. Source:
   * `APIRef_FareDisplay.htm` (verbatim 2026-06-03). Endpoint is
   * standalone (no workbench required) — used by Galileo `FD<...>`.
   *
   * Request body:
   *   {
   *     "FareDisplayQueryRequest": {
   *       "from": { "value": "<IATA>" },
   *       "to":   { "value": "<IATA>" },
   *       "departureDate": "YYYY-MM-DD"?,
   *       "returnDate":    "YYYY-MM-DD"?,
   *       "carrier": ["<IATA>"]?
   *     }
   *   }
   *
   * Journey type is determined server-side by presence/absence of
   * `returnDate` (no explicit RT/OW flag in the body). Up to 3
   * carriers per docs.
   */
  async fareDisplay(opts: {
    from: string;
    to: string;
    departureDate?: string; // YYYY-MM-DD
    returnDate?: string; // YYYY-MM-DD
    carriers?: string[];
  }): Promise<unknown> {
    const url = `${this.opts.apiBase}/air/faredisplay/fares`;
    const request: Record<string, unknown> = {
      from: { value: opts.from },
      to: { value: opts.to },
    };
    if (opts.departureDate) request.departureDate = opts.departureDate;
    if (opts.returnDate) request.returnDate = opts.returnDate;
    if (opts.carriers && opts.carriers.length > 0) request.carrier = opts.carriers;
    return this.postJson(url, { FareDisplayQueryRequest: request }, 'fareDisplay');
  }

  /**
   * Add a notepad / remark / OSI to a workbench via
   * `/reservationcomments/list`. Source: canonical schema verified
   * in the v11 spec doc (`Book/RemarksGuide.htm`).
   *
   * `kind` distinguishes the comment role:
   *  - 'notepad'    → `commentSource: "Agency"`, Comment label
   *                   `"Notepad"` (Galileo `NP.<text>`)
   *  - 'historical' → `commentSource: "Agency"`, Comment label
   *                   `"Historical Notepad"` (Galileo `NP.H**<text>`)
   *  - 'osi'        → `commentSource: "Supplier"` +
   *                   `shareWithSupplier: [<carrier>]`, Comment label
   *                   `"OSI Remarks"` (Galileo `SI.<carrier>*<text>`).
   *                   Requires `carrier` in opts.
   *
   * OSI text constraint per the spec: 1-99 chars, only period,
   * forward slash, and dash allowed as special chars. We don't
   * enforce client-side — the server's 4xx will surface violations.
   */
  async addReservationComment(
    workbenchId: string,
    text: string,
    opts?:
      | { kind?: 'notepad' | 'historical' }
      | { kind: 'osi'; carrier: string }
  ): Promise<unknown> {
    const url =
      `${this.opts.apiBase}/air/book/remarks/reservationworkbench/${encodeURIComponent(workbenchId)}` +
      `/reservationcomments/list`;
    let entry: Record<string, unknown>;
    if (opts && opts.kind === 'osi') {
      entry = {
        '@type': 'ReservationComment',
        id: 'ReservationComment_1',
        commentSource: 'Supplier',
        shareWithSupplier: [opts.carrier],
        Comment: [{ name: 'OSI Remarks', value: text }],
      };
    } else {
      const label = opts?.kind === 'historical' ? 'Historical Notepad' : 'Notepad';
      entry = {
        '@type': 'ReservationComment',
        id: 'ReservationComment_1',
        commentSource: 'Agency',
        Comment: [{ name: label, value: text }],
      };
    }
    const body = {
      ReservationCommentListRequest: {
        ReservationCommentID: [entry],
      },
    };
    return this.postJson(url, body, 'addReservationComment');
  }

  /**
   * Add a single traveler to a workbench. Returns the response plus
   * the server-assigned traveler UUID extracted from
   * `Traveler[0].Identifier.value` (or common defensive fallbacks).
   * The UUID is what SSR / remarks / FOP payloads use to reference
   * this passenger via `TravelerIdentifier.id` / `.Identifier.value`.
   */
  /** Build a single Traveler payload shared by singular + list endpoints. */
  private buildTravelerPayload(traveler: {
    givenName: string;
    surname: string;
    phone?: string;
    email?: string;
  }): Record<string, unknown> {
    const t: Record<string, unknown> = {
      '@type': 'Traveler',
      passengerTypeCode: 'ADT',
      PersonName: {
        '@type': 'PersonNameDetail',
        Given: traveler.givenName,
        Surname: traveler.surname,
      },
    };
    if (traveler.phone) {
      t.Telephone = [{ phoneNumber: traveler.phone, role: 'Mobile' }];
    }
    if (traveler.email) {
      t.Email = [{ value: traveler.email }];
    }
    return t;
  }

  /**
   * Extract the server-assigned traveler UUID from a Traveler-shaped
   * node. Tries the documented `Identifier.value` first plus a few
   * defensive fallbacks for pre-prod shape drift.
   */
  private extractTravelerId(node: any): string | undefined {
    const id =
      node?.Identifier?.value ?? node?.id ?? node?.travelerId ?? undefined;
    return typeof id === 'string' ? id : undefined;
  }

  /**
   * Add a single ADT traveler to a workbench. Body shape per
   * `APIRef_TravelerAdd.htm` (verified): `{ Traveler: { ... } }` —
   * single object, NOT array. (Our prior body posted `{ Traveler:
   * [t] }`, which mocked tests accepted but is wrong against the
   * documented shape; same bug class as the cancel/queue-place/FOP
   * body fixes.)
   *
   * Returns `{ travelerId, raw }` so callers can index travellers by
   * the server-assigned UUID for SSR / FOP / remarks references.
   */
  async addTraveler(
    workbenchId: string,
    traveler: { givenName: string; surname: string; phone?: string; email?: string }
  ): Promise<{ travelerId?: string; raw: unknown }> {
    const url =
      `${this.opts.apiBase}/air/book/traveler/reservationworkbench/${encodeURIComponent(workbenchId)}` +
      `/travelers`;
    const t = this.buildTravelerPayload(traveler);
    const raw = (await this.postJson(url, { Traveler: t }, 'addTraveler')) as any;
    // VERIFIED PRE-PROD via GDS reference-payload devkit: response shape
    // is `{ TravelerResponse: { Traveler: { Identifier: { value }}}}` —
    // singular Traveler object wrapped in a TravelerResponse envelope.
    // Legacy paths kept as defensive fallbacks for mocked-fixture drift.
    const node =
      raw?.TravelerResponse?.Traveler ??
      (Array.isArray(raw?.Traveler) ? raw.Traveler[0] : raw?.Traveler) ??
      raw;
    const travelerId = this.extractTravelerId(node);
    return { travelerId, raw };
  }

  /**
   * Add multiple travelers in one round-trip via `/travelers/list`.
   * Body per `APIRef_TravelerAdd.htm` (verified):
   *
   *   {
   *     "TravelerListRequest": {
   *       "@type": "TravelerListRequest",
   *       "Traveler": [{...}, {...}, ...]
   *     }
   *   }
   *
   * Limit: 9 travelers per request (documented). We don't enforce
   * client-side — server 4xx will surface.
   *
   * Returns `travelerIds` in the same order as the request (with
   * empty string placeholders for any traveler whose response node
   * didn't carry an Identifier, so the index alignment with the
   * input array is preserved).
   */
  async addTravelers(
    workbenchId: string,
    travelers: Array<{ givenName: string; surname: string; phone?: string; email?: string }>
  ): Promise<{ travelerIds: string[]; raw: unknown }> {
    const url =
      `${this.opts.apiBase}/air/book/traveler/reservationworkbench/${encodeURIComponent(workbenchId)}` +
      `/travelers/list`;
    const body = {
      TravelerListRequest: {
        '@type': 'TravelerListRequest',
        Traveler: travelers.map((t) => this.buildTravelerPayload(t)),
      },
    };
    const raw = (await this.postJson(url, body, 'addTravelers')) as any;
    // VERIFIED PRE-PROD 2026-06-06 from a response dump:
    //   { TravelerListResponse: { ReferenceList: [{ Traveler: [...] }] } }
    // There's a ReferenceList[] wrapper level holding ReferenceListTraveler
    // entries; flatten before pulling each Identifier.value.
    const batchRefs = raw?.TravelerListResponse?.ReferenceList;
    let nodes: any[] = [];
    if (Array.isArray(batchRefs)) {
      for (const ref of batchRefs) {
        const list = Array.isArray(ref?.Traveler) ? ref.Traveler : [];
        nodes.push(...list);
      }
    }
    if (nodes.length === 0) {
      // Legacy fallbacks: flat envelope variants observed on some mocks.
      const list =
        raw?.TravelerListResponse?.Traveler ??
        raw?.TravelerResponse?.Traveler ??
        raw?.Traveler ??
        [];
      nodes = Array.isArray(list) ? list : [list];
    }
    const travelerIds = travelers.map(
      (_, i) => this.extractTravelerId(nodes[i]) ?? ''
    );
    return { travelerIds, raw };
  }

  /**
   * Commit a workbench — materialize the reservation, return the
   * locator. After this call the workbench is gone server-side and
   * the caller should clear `wa.liveWorkbenchId` and (separately)
   * stamp the locator on the in-memory PNR.
   *
   * Source: POST /11/air/book/reservation/reservations/{workbenchID}
   * — body `{ ReservationQueryCommitReservation: {
   *      enableTwoStepCommitInd: false,
   *      autoDeleteDate?: "YYYY-MM-DD"
   * } }` — response `{ Receipt: [{ Confirmation: { Locator: {
   *      value: "<6-char>", authority: "Travelport"
   * } } }] }`.
   *
   * Defensive extraction tolerates the documented Receipt-array shape
   * plus a flat `Locator.value` fallback some pre-prod tenants return.
   * Throws if the server's response is missing a locator entirely —
   * we'd rather the agent see a clear error than a fake commit.
   */
  /**
   * Retrieve a reservation by record locator.
   *
   * Source: GET /11/air/book/reservation/reservations/{LocatorCode}.
   * Returns the raw JSON; the dispatch handler maps it to the
   * dialect-shared Pnr model via `mapReservation`. Throws on a
   * 404 / 410 so the dialect can surface NO BOOKING FILE.
   */
  async retrieveReservation(locator: string): Promise<unknown> {
    const url =
      `${this.opts.apiBase}/air/book/reservation/reservations/${encodeURIComponent(locator)}`;
    return this.getJson(url, 'retrieveReservation');
  }

  /**
   * List all tickets issued on a reservation.
   *
   * Source: GET /11/air/receipt/reservations/{LocatorCode}/receipts.
   * Used by Galileo *HTI / *HTE — the agent has a committed BF and
   * wants to see what tickets exist on it (number / status / passenger).
   * The response carries a Receipt[] with each ticket's number, status
   * code, and passenger reference.
   */
  async listReceipts(locator: string): Promise<unknown> {
    const url =
      `${this.opts.apiBase}/air/receipt/reservations/${encodeURIComponent(locator)}/receipts`;
    return this.getJson(url, 'listReceipts');
  }

  /**
   * Void a single ticket.
   *
   * Source: PUT /11/air/ticket/tickets/updatestatus/{ticketID}. Used by
   * Galileo `TRV/<13-digit>` (Mini Guide v2 p.53). Same-day window
   * (BSP) / next-business-day (ARC) is enforced server-side; the
   * emulator doesn't model wall-clock cutoffs.
   *
   * Body is minimal — `{ status: 'VOIDED' }`. The exact request shape
   * isn't deeply documented in the v11 endpoint list; if pre-prod
   * returns a 4xx, we adjust.
   */
  async voidTicket(ticketNumber: string): Promise<unknown> {
    const url =
      `${this.opts.apiBase}/air/ticket/tickets/updatestatus/${encodeURIComponent(ticketNumber)}`;
    return this.putJson(url, { status: 'VOIDED' }, 'voidTicket');
  }

  /**
   * Place a booking on a queue.
   *
   * Source: POST /11/air/queue/queue. Used by Galileo `QEB/<n>` (Pocket
   * Guide p.3: "End transaction and place BF on queue <n>"). v1 takes
   * the queue id only; queue PCC and category code (QP/100/75 PIC)
   * forms aren't wired on the Galileo cryptic side yet.
   */
  /**
   * Place a booking on one or more agency queues. Used by Galileo
   * `QEB/<n>` and `QP/<n>` (plus their `+`-list and branch-PCC forms).
   *
   * Source: POST /11/air/queue/queue — body shape verified verbatim
   * from `APIRef_Queue.htm` 2026-05-29:
   *
   *   {
   *     "AgencyQueue": {
   *       "ReservationIdentifier": { "value": "<locator>" },
   *       "Queue": [{ "value": "<queue>", "pccOverride"?, ... }]
   *     }
   *   }
   *
   * Each `Queue[]` element supports per-queue `pccOverride`,
   * `category`, `dateOffset`, `date` — `pccOverride` is what makes
   * branch-PCC placement (`QEB/<PCC>/<n>`) a single call.
   *
   * v1 in this commit: the cryptic surface drives `value` and
   * `pccOverride`. The other Queue[] options are accepted as opts
   * for forward-compat; no cryptic form exposes them yet.
   *
   * NOTE: this replaces the old single-queue `QueuePlaceQuery` body
   * we'd been posting since `bdb6146` — that shape was a guess that
   * mocked tests accepted but pre-prod would reject. Same class of
   * bug as the cancel-body fix in `c2fc1a1`.
   */
  async placeOnQueue(
    locator: string,
    queues: Array<{
      value: string;
      pccOverride?: string;
      category?: string;
      dateOffset?: number;
      date?: string;
    }>
  ): Promise<unknown> {
    const url = `${this.opts.apiBase}/air/queue/queue`;
    return this.postJson(
      url,
      {
        AgencyQueue: {
          ReservationIdentifier: { value: locator },
          Queue: queues.map((q) => {
            const out: Record<string, unknown> = { value: q.value };
            if (q.pccOverride) out.pccOverride = q.pccOverride;
            if (q.category) out.category = q.category;
            if (q.dateOffset != null) out.dateOffset = q.dateOffset;
            if (q.date) out.date = q.date;
            return out;
          }),
        },
      },
      'placeOnQueue'
    );
  }

  /**
   * List bookings sitting on an agency queue. Used by Galileo `Q/<n>`.
   *
   * Source: POST /11/air/queue/queue/list — body is `AgencyQueueSummary`
   * with one or more queues. Verbatim schema from `APIRef_QueueList.htm`
   * (verified 2026-05-29).
   *
   * v1: single queue, no per-queue qualifiers. Date-range (`dateOffset`),
   * branch-PCC override, and category filters are deferred — surface
   * via `opts` when the cryptic parser supports them.
   */
  async listQueue(
    queue: string,
    opts?: { dateOffset?: number; pccOverride?: string; category?: string }
  ): Promise<unknown> {
    const url = `${this.opts.apiBase}/air/queue/queue/list`;
    const q: Record<string, unknown> = { value: queue };
    if (opts?.dateOffset != null) q.dateOffset = opts.dateOffset;
    if (opts?.pccOverride) q.pccOverride = opts.pccOverride;
    if (opts?.category) q.category = opts.category;
    return this.postJson(
      url,
      { '@type': 'AgencyQueueSummary', Queue: [q] },
      'listQueue'
    );
  }

  /**
   * Remove a booking from one or more agency queues. Used by Galileo `QR`.
   *
   * Source: POST /11/air/queue/queue/remove — body shape verified
   * verbatim from `APIRef_QueueRemove.htm` (2026-05-29). The
   * `ReservationIdentifier.value` is the BF locator; `Queue[]` is the
   * list of queues to remove it from.
   *
   * Response is `BaseResponse.Result.status` ("Complete" on success);
   * we just verify the call succeeded and return the raw response.
   *
   * v1: single queue, no qualifiers. Multi-queue and per-queue
   * date/category/pcc filters surface via `opts` when the cryptic
   * parser supports them (`QRQ/ALL` etc.).
   */
  async removeFromQueue(
    locator: string,
    queue: string,
    opts?: { dateOffset?: number; pccOverride?: string; category?: string }
  ): Promise<unknown> {
    const url = `${this.opts.apiBase}/air/queue/queue/remove`;
    const q: Record<string, unknown> = { value: queue };
    if (opts?.dateOffset != null) q.dateOffset = opts.dateOffset;
    if (opts?.pccOverride) q.pccOverride = opts.pccOverride;
    if (opts?.category) q.category = opts.category;
    return this.postJson(
      url,
      {
        '@type': 'AgencyQueueSummary',
        ReservationIdentifier: { value: locator },
        Queue: [q],
      },
      'removeFromQueue'
    );
  }

  /**
   * Remove a booking from multiple agency queues in one call. Used by
   * Galileo `QRQ/ALL`. Same endpoint as `removeFromQueue`; the body's
   * `Queue[]` array carries every queue number in one shot.
   */
  async removeFromQueues(locator: string, queues: string[]): Promise<unknown> {
    const url = `${this.opts.apiBase}/air/queue/queue/remove`;
    return this.postJson(
      url,
      {
        '@type': 'AgencyQueueSummary',
        ReservationIdentifier: { value: locator },
        Queue: queues.map((q) => ({ value: q })),
      },
      'removeFromQueues'
    );
  }

  /**
   * Divide a reservation: split out one or more passengers into a new
   * reservation. Used by Galileo `DP<n>` (Mini Guide v2 p.39).
   *
   * Source: POST /11/air/book/reservation/reservations/divide. The exact
   * request shape isn't pinned in the spec endpoint list; we send
   * `{ DivideQuery: { SourceLocator, PassengerNumbers: [...] } }` which
   * mirrors the documented LocatorCode + entity-list pattern other
   * endpoints use. If pre-prod returns a 4xx with the real shape we
   * adjust.
   */
  async divideReservation(
    locator: string,
    passengerNumbers: number[]
  ): Promise<unknown> {
    const url = `${this.opts.apiBase}/air/book/reservation/reservations/divide`;
    return this.postJson(
      url,
      {
        DivideQuery: {
          SourceLocator: locator,
          PassengerNumbers: passengerNumbers,
        },
      },
      'divideReservation'
    );
  }

  /**
   * Cancel offers / segments inside a workbench. Works for both in-
   * flight workbenches (created via `createWorkbench()`) and post-
   * commit workbenches (created via `buildWorkbenchFromLocator()`).
   *
   * Source: POST /book/reservationworkbench/{workbenchID}/reservations
   * /cancelitems. The path is intentionally NOT under `/11/air` — the
   * v11 endpoints list documents it at the root.
   *
   * Canonical body schema verbatim from `APIRef_CancelWorkbenchItems.htm`:
   *
   *   Full cancel:
   *     { "@type": "CancelRequest", "cancelAllInd": true }
   *
   *   Cancel one or more offers (each offer-cancel implicitly cancels
   *   every segment inside the offer):
   *     { "@type": "CancelRequest",
   *       "cancelOffers": {
   *         "objectType": "CancelSelectedOffers",
   *         "offerProductSelection": [{
   *           "sendPassiveNotificationInd": false,
   *           "offerID": { "Identifier": { "authority": "Travelport",
   *                                        "value": "<offer-id>" } }
   *         }]
   *       } }
   *
   *   Segment-level cancel additionally populates `productSegmentSequence
   *   Array[].productID.Identifier.value` + `segmentSequenceArray` —
   *   not yet wired since we don't extract product IDs from search
   *   responses. Cryptic X<n> against a single offer falls back to
   *   offer-level cancel (cancelling the whole offer).
   *
   * Note: "Cancel Workbench Items must always be followed by a Workbench
   * Commit to commit the changes" — the caller is responsible for the
   * follow-up commit.
   */
  async cancelWorkbenchItems(
    workbenchId: string,
    opts: CancelWorkbenchOpts = { all: true }
  ): Promise<unknown> {
    const url =
      `${this.opts.apiBase.replace(/\/11$/, '')}/book/reservationworkbench/` +
      `${encodeURIComponent(workbenchId)}/reservations/cancelitems`;

    let body: Record<string, unknown>;
    if (opts.all) {
      body = { '@type': 'CancelRequest', cancelAllInd: true };
    } else if (opts.offerIds && opts.offerIds.length > 0) {
      body = {
        '@type': 'CancelRequest',
        cancelOffers: {
          objectType: 'CancelSelectedOffers',
          offerProductSelection: opts.offerIds.map((id) => ({
            sendPassiveNotificationInd: !!opts.passive,
            offerID: {
              Identifier: { authority: 'Travelport', value: id },
            },
          })),
        },
      };
    } else {
      // Caller asked for offer-targeted cancel without supplying IDs —
      // surface that as a programming error rather than silently sending
      // a malformed payload.
      throw new Error(
        'LiveTravelportBackend cancelWorkbenchItems: opts must set `all: true` or supply `offerIds`'
      );
    }
    return this.postJson(url, body, 'cancelWorkbenchItems');
  }

  /**
   * Cancel a committed GDS reservation (AFTER commit, by locator).
   * Used by Galileo `XI` / `XA` against a previously-retrieved BF.
   *
   * Source: POST /11/air/receipt/reservations/{LocatorCode}/receipts —
   * the same endpoint also handles cancel-with-refund for NDC, but
   * this v1 sticks to plain GDS cancel.
   *
   * Body: the canonical schema for this endpoint isn't surfaced in
   * the v11 endpoints list we fetched. We send the empty CancelRequest
   * shape that the workbench-side cancel uses (`{ "@type":
   * "CancelRequest", "cancelAllInd": true }`) on the bet that the
   * receipt-cancel endpoint accepts the same envelope. Pre-prod will
   * either accept it or surface a 4xx with the real schema.
   */
  async cancelReservation(locator: string): Promise<unknown> {
    const url =
      `${this.opts.apiBase}/air/receipt/reservations/${encodeURIComponent(locator)}/receipts`;
    return this.postJson(
      url,
      { '@type': 'CancelRequest', cancelAllInd: true },
      'cancelReservation'
    );
  }

  /**
   * Open a post-commit workbench from an existing locator so the
   * committed BF can be modified (in particular, partial-cancelled).
   *
   * Source: POST /11/air/book/session/reservationworkbench/
   * buildfromlocator?Locator={LocatorCode} — query param Locator, empty
   * body. Response includes the full Reservation plus the new
   * workbench `Identifier`.
   *
   * Returns `{ workbenchId, raw }` so callers can both (a) reference the
   * new workbench for `cancelitems`/`commit` and (b) inspect the
   * Reservation to resolve `offerID` per segment — the response is the
   * only authoritative source of offer IDs for a retrieved BF.
   */
  async openWorkbenchFromLocator(
    locator: string
  ): Promise<{ workbenchId: string; raw: unknown }> {
    const url =
      `${this.opts.apiBase}/air/book/session/reservationworkbench/buildfromlocator` +
      `?Locator=${encodeURIComponent(locator)}`;
    const json = (await this.postJson(url, {}, 'openWorkbenchFromLocator')) as any;
    // Mirror createWorkbench's verified shape: pre-prod returns a
    // Reservation envelope. See "Verified response shapes" in the spec.
    const id =
      json?.ReservationResponse?.Reservation?.Identifier?.value ??
      json?.Identifier?.value ??
      json?.ReservationWorkbench?.Identifier?.value ??
      json?.Workbench?.Identifier?.value ??
      json?.workbenchID ??
      json?.workbenchId;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        'LiveTravelportBackend openWorkbenchFromLocator: response missing workbenchID'
      );
    }
    return { workbenchId: id, raw: json };
  }

  async commitWorkbench(
    workbenchId: string,
    opts?: { autoDeleteDate?: string; ticketing?: string }
  ): Promise<string> {
    const url =
      `${this.opts.apiBase}/air/book/reservation/reservations/${encodeURIComponent(workbenchId)}`;
    const body = {
      ReservationQueryCommitReservation: {
        enableTwoStepCommitInd: false,
        ...(opts?.autoDeleteDate ? { autoDeleteDate: opts.autoDeleteDate } : {}),
        // Ticketing-on-commit per the v11 spec: a `Ticketing` field on
        // ReservationQueryCommitReservation. Raw text passes through —
        // Galileo's T. accepts forms like `T*` (minimum) and `TAU/10JUN`
        // (queue + date); the server validates. Field name not pinned
        // in the spec list we fetched; if pre-prod surfaces a 4xx
        // about unknown field, we adjust.
        ...(opts?.ticketing ? { Ticketing: { value: opts.ticketing } } : {}),
      },
    };
    const json = (await this.postJson(url, body, 'commitWorkbench')) as any;
    // VERIFIED PRE-PROD via GDS reference-payload devkit. Response is
    // `{ ReservationResponse: { Reservation: { Receipt: [{Confirmation: {Locator: { value, source }}}, ...] }}}`.
    // Receipt is an ARRAY — multiple receipts for combined GDS/NDC
    // bookings, ticket receipts, etc. For a GDS PNR we want the one
    // whose `Confirmation.Locator.source === "1G"`; if none matches,
    // fall through to the first locator-bearing receipt.
    const receipts: any[] = Array.isArray(json?.ReservationResponse?.Reservation?.Receipt)
      ? json.ReservationResponse.Reservation.Receipt
      : Array.isArray(json?.Receipt)
      ? json.Receipt
      : [];
    const gdsReceipt = receipts.find(
      (r) => r?.Confirmation?.Locator?.source === '1G'
    );
    const fallback = receipts.find((r) => r?.Confirmation?.Locator?.value);
    const locator =
      gdsReceipt?.Confirmation?.Locator?.value ??
      fallback?.Confirmation?.Locator?.value ??
      json?.Confirmation?.Locator?.value ??
      json?.Locator?.value ??
      json?.locator;
    if (typeof locator !== 'string' || locator.length === 0) {
      throw new Error('LiveTravelportBackend commitWorkbench: response missing locator');
    }
    return locator;
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
