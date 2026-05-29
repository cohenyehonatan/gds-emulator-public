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
      'TVP-PCC-CORE': `${this.opts.pcc}_${this.opts.gds}`,
    };
  }

  /**
   * Shared POST helper: same headers, same error handling. `label` is
   * surfaced in the error message so call sites get clear failure
   * attribution without each having to redo the boilerplate.
   */
  private async postJson(url: string, body: unknown, label: string): Promise<unknown> {
    const headers = await this.tripServicesHeaders();
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `LiveTravelportBackend ${label} failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`
      );
    }
    return JSON.parse(text);
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
    return JSON.parse(text);
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
    return text ? JSON.parse(text) : {};
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
  async createWorkbench(): Promise<string> {
    const url = `${this.opts.apiBase}/air/book/session/reservationworkbench`;
    // Minimal payload per the spec; the workbench is created empty and
    // populated via subsequent endpoints.
    const json = (await this.postJson(url, {}, 'createWorkbench')) as any;
    // The response shape isn't precisely documented in the spec —
    // defensive extraction tries the documented Identifier path plus
    // a flat `workbenchID` fallback some pre-prod tenants return.
    const id =
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
   * /offers/buildfromcatalogofferings — request shape `OfferQueryRef`
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
   * The body shape mirrors addOffer's `OfferQueryRef` form (the
   * reference-payload pattern is documented as shared across endpoints
   * that accept catalog offer IDs).
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

  async addOffer(
    workbenchId: string,
    offerId: string,
    adults = 1
  ): Promise<unknown> {
    const url =
      `${this.opts.apiBase}/air/book/airoffer/reservationworkbench/${encodeURIComponent(workbenchId)}` +
      `/offers/buildfromcatalogofferings`;
    const body = {
      OfferQueryRef: {
        SearchOfferId: offerId,
        PassengerCriteria: [{ number: adults, passengerTypeCode: 'ADT' }],
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
    fop: { kind: 'cash' } = { kind: 'cash' }
  ): Promise<unknown> {
    const url =
      `${this.opts.apiBase}/air/payment/reservationworkbench/${encodeURIComponent(workbenchId)}` +
      `/formofpayment`;
    // Defensive body shape — the spec endpoints list documents the URL but
    // not the JSON exactly. Cash is the simplest; the documented field
    // names live under FormOfPayment in adjacent endpoints (addaccounting
    // etc. share a similar `Type: "Cash"` convention).
    const body = { FormOfPayment: [{ Type: fop.kind === 'cash' ? 'Cash' : 'Cash' }] };
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

  async addTraveler(
    workbenchId: string,
    traveler: { givenName: string; surname: string; phone?: string; email?: string }
  ): Promise<unknown> {
    const url =
      `${this.opts.apiBase}/air/book/traveler/reservationworkbench/${encodeURIComponent(workbenchId)}` +
      `/travelers`;
    const t: Record<string, unknown> = {
      passengerTypeCode: 'ADT',
      PersonName: { Given: traveler.givenName, Surname: traveler.surname },
    };
    if (traveler.phone) {
      t.Telephone = [{ phoneNumber: traveler.phone, role: 'Mobile' }];
    }
    if (traveler.email) {
      t.Email = [{ value: traveler.email }];
    }
    return this.postJson(url, { Traveler: [t] }, 'addTraveler');
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
  async placeOnQueue(locator: string, queue: string): Promise<unknown> {
    const url = `${this.opts.apiBase}/air/queue/queue`;
    return this.postJson(
      url,
      {
        QueuePlaceQuery: {
          LocatorCode: locator,
          QueueNumber: queue,
        },
      },
      'placeOnQueue'
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
    const locator =
      json?.Receipt?.[0]?.Confirmation?.Locator?.value ??
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
