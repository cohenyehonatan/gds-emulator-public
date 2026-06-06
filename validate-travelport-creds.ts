/**
 * validate-travelport-creds.ts — pre-prod validation harness.
 *
 * Purpose: prove the 7K9S trial creds are alive against Travelport TripServices
 * (pre-production), confirm a live Galileo (1G) air search returns real JSON,
 * AND exercise every body shape the emulator's LiveTravelportBackend uses so
 * the open pre-prod questions get settled with real evidence. Touches none of
 * src/.
 *
 * Phases (skip any via TVP_SKIP_PHASES="1,2,3,4,5"):
 *   1. OAuth token  — POST /oauth/token
 *   2. Air search   — POST /air/catalog/search/catalogproductofferings
 *   3. Workbench    — create → add offer → add singular traveler →
 *                     SSR with TravelerIdentifier → SSR without (does
 *                     pre-prod reject whole-BF scope?) → NP. comment →
 *                     cash FOP (FormOfPaymentCash discriminator) →
 *                     commit → retrieve → cancel committed → DELETE wb
 *   4. Multi-pax    — fresh workbench → /travelers/list batch (verifies
 *                     TravelerListRequest envelope) → DELETE wb
 *   5. Fare lookup  — POST /faredisplay/fares → GET /fromfaredisplay
 *                     (verifies Identifier capture + line FareID flow)
 *
 * What this validates beyond "creds work":
 *   - Workbench-side offer ref vs search-side vendorRef.offerId drift
 *     (Phase 3, addOffer; 4xx body would tell us)
 *   - Whether TravelerIdentifier is required for whole-BF SSRs
 *     (Phase 3, "SSR without traveler" sub-step)
 *   - Whether server accepts client-generated Identifier.value UUIDs
 *     (Phase 3, SSR + commit; 4xx on Identifier rejection would tell us)
 *   - Canonical body shapes for: FormOfPaymentCash, Traveler (object,
 *     not array), TravelerListRequest (array), CancelRequest
 *     (cancelAllInd), specialservices SpecialServiceListRequest,
 *     reservationcomments commentSource: Agency, FareDisplayQueryRequest,
 *     FareRules /fromfaredisplay query params.
 *
 * Each phase makes a small, bounded set of calls (Phase 3 is heaviest at ~10
 * round-trips). Total ~15-20 calls per full run. Phases 3 + 4 create
 * server-side workbenches; both try to DELETE on exit even after failure to
 * avoid leaking 30-min TTL stragglers.
 *
 * ── WHAT THIS SENDS OVER THE NETWORK (read before running) ─────────────────
 * Every endpoint hit is documented in references/galileo/Travelport-JSON-Air-
 * v11-API-Spec.md "Canonical schemas". Bearer token on every API call after
 * Phase 1. Body shapes are byte-for-byte the same as LiveTravelportBackend's.
 * Nothing is sent to any non-Travelport host. Pre-prod base URL only.
 *
 * ── SECRET HANDLING ────────────────────────────────────────────────────────
 * Creds are read ONLY from environment variables you set in your own shell.
 * Nothing is hardcoded. The access token is masked in logs (first 6 + last 4
 * chars); secrets are never echoed. Response bodies of Phase 3 / 4 / 5 are
 * NOT written to disk by default — only the Phase 2 search result is (the
 * sandbox is the lowest-sensitivity surface). Set TVP_DUMP_ALL=1 to write
 * every phase's responses for offline inspection.
 *
 * ── RUN ────────────────────────────────────────────────────────────────────
 *   # set creds without leaving them in shell history (note the leading space):
 *    export TVP_CLIENT_ID=...   TVP_CLIENT_SECRET=...
 *    export TVP_USERNAME=...    TVP_PASSWORD=...
 *   npx tsx validate-travelport-creds.ts
 *
 *   # Only run Phase 1+2 (OAuth + search) — original spike behavior:
 *    TVP_SKIP_PHASES=3,4,5 npx tsx validate-travelport-creds.ts
 *
 *   # Phase 3 only (skip everything else):
 *    TVP_SKIP_PHASES=4,5 npx tsx validate-travelport-creds.ts
 *
 * Single legitimate call per endpoint — no retry storms, no limit probing
 * (per the capture-then-replay vendor-pacing rule). Re-runs hit the live API
 * again, so don't loop it.
 */

// ── Config (all overridable via env; defaults target pre-prod + Galileo 1G) ──
const OAUTH_URL = process.env.TVP_OAUTH_URL ?? 'https://auth.pp.travelport.net/oauth/token';
const API_BASE = process.env.TVP_API_BASE ?? 'https://api.pp.travelport.net/11';
const SEARCH_PATH = process.env.TVP_SEARCH_PATH ?? '/air/catalog/search/catalogproductofferings';
const GRANT_TYPE = process.env.TVP_GRANT_TYPE ?? 'password'; // docs conflict (password vs client_credentials); flip via env if 400
const PCC = process.env.TVP_PCC ?? '7K9S';
const GDS = process.env.TVP_GDS ?? '1G';
const ACCESS_GROUP = process.env.TVP_ACCESS_GROUP; // alternative to TVP-PCC-CORE, if you were issued one
const ACCEPT_VERSION = process.env.TVP_ACCEPT_VERSION ?? '11';
const FROM = process.env.TVP_FROM ?? 'DEN';
const TO = process.env.TVP_TO ?? 'FRA';
const DEPART = process.env.TVP_DATE ?? defaultDate(); // ~30 days out
const OUT_FILE = process.env.TVP_OUT ?? './travelport-response.json';
const SKIP_PHASES = new Set(
  (process.env.TVP_SKIP_PHASES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
);
const DUMP_ALL = process.env.TVP_DUMP_ALL === '1';

const CLIENT_ID = process.env.TVP_CLIENT_ID;
const CLIENT_SECRET = process.env.TVP_CLIENT_SECRET;
const USERNAME = process.env.TVP_USERNAME;
const PASSWORD = process.env.TVP_PASSWORD;

/** Track resources we created so the cleanup pass can DELETE them. */
const cleanup: { workbenches: string[] } = { workbenches: [] };

function defaultDate(): string {
  const d = new Date(Date.now() + 30 * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function mask(token: string): string {
  if (token.length <= 10) return `***(${token.length} chars)`;
  return `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)`;
}

function commonHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Cache-Control': 'no-cache',
    'Accept-Version': ACCEPT_VERSION,
    // Canonical Postman devkit sets BOTH Accept-Version AND Content-Version.
    // addOffer required both; omitting Content-Version 400s with bare
    // INVALID INPUT FORMAT.
    'Content-Version': ACCEPT_VERSION,
  };
  if (ACCESS_GROUP) headers['XAUTH_TRAVELPORT_ACCESSGROUP'] = ACCESS_GROUP;
  else headers['TVP-PCC-CORE'] = `${PCC}_${GDS}`;
  return headers;
}

interface CallResult {
  status: number;
  statusText: string;
  ok: boolean;
  body: unknown;
  rawText: string;
}

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  token: string,
  body: unknown | undefined,
  label: string
): Promise<CallResult> {
  const init: RequestInit = {
    method,
    headers: commonHeaders(token),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  // VERIFIED PRE-PROD 2026-06-06: Travelport returns HTTP 200 on
  // endpoints that fail server-side validation, with the actual error
  // buried inside `<Endpoint>Response.Result.Error[]`. The commit
  // endpoint specifically returned 200 with
  // `ReservationResponse.Result.Error[0].Message = "TELEPHONE IS A
  // REQUIRED FIELD"` even though the booking didn't commit. Treat
  // presence of any Result.Error[] as failure.
  const semanticErrors = extractTravelportErrors(parsed);
  const semanticOk = res.ok && semanticErrors.length === 0;
  const result: CallResult = {
    status: res.status,
    statusText: res.statusText,
    ok: semanticOk,
    body: parsed,
    rawText: text,
  };
  const tag = semanticOk ? '✓' : res.status >= 500 ? '✗' : '△';
  const note =
    res.ok && !semanticOk
      ? `  (HTTP 200 but ${semanticErrors.length} Result.Error[])`
      : '';
  console.log(`      ${tag} ${method} ${urlShort(url)}  →  ${res.status} ${res.statusText}${note}  [${label}]`);
  if (DUMP_ALL && text) {
    const fs = await import('node:fs/promises');
    const safeLabel = label.replace(/[^a-z0-9-]/gi, '_');
    await fs.writeFile(`./tvp-${safeLabel}.json`, text, 'utf8');
  }
  return result;
}

function urlShort(url: string): string {
  return url.replace(API_BASE, '…').replace(OAUTH_URL, '…(oauth)');
}

/**
 * Force-dump a response body for offline shape mapping. Called from
 * extraction-failure paths so we always get a re-runnable diagnostic
 * artifact even when TVP_DUMP_ALL is off. Returns the dump file path
 * (or undefined if the body was empty / unwritable).
 */
async function dumpForDiagnostics(label: string, body: unknown): Promise<string | undefined> {
  try {
    const fs = await import('node:fs/promises');
    const safeLabel = label.replace(/[^a-z0-9-]/gi, '_');
    const path = `./tvp-diag-${safeLabel}.json`;
    const text =
      typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    if (!text) return undefined;
    await fs.writeFile(path, text, 'utf8');
    return path;
  } catch {
    return undefined;
  }
}

/**
 * Recursively walk an object looking for the first string value at any
 * key matching the given regex. Used when our nominal extractor paths
 * miss — gives us a "found at path X" hint rather than just silence.
 */
function findFirstByKey(
  node: unknown,
  keyMatcher: RegExp,
  path: string[] = [],
  depth = 0
): { path: string; value: string } | undefined {
  if (depth > 8 || node == null || typeof node !== 'object') return undefined;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (keyMatcher.test(k) && typeof v === 'string' && v.length > 0) {
      return { path: [...path, k].join('.'), value: v };
    }
    if (v && typeof v === 'object') {
      const hit = findFirstByKey(v, keyMatcher, [...path, k], depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

function previewBody(body: unknown): string {
  if (body == null) return '(empty)';
  if (typeof body === 'string') return body.slice(0, 280);
  try {
    return JSON.stringify(body).slice(0, 280);
  } catch {
    return '(unserializable)';
  }
}

/**
 * Travelport wraps validation failures in `<...Response>.Result.Error[]`
 * with a structured `category` / `Message` (often quite long). Walk the
 * body and surface every Message we find so the truncated "INVALID
 * INPUT FORMA…" preview becomes the full diagnostic.
 */
function extractTravelportErrors(body: unknown): string[] {
  const messages: string[] = [];
  function walk(node: unknown, depth = 0): void {
    if (depth > 8 || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    // Direct Message field (Travelport error nodes).
    if (typeof record.Message === 'string' && record.Message.length > 0) {
      const category = typeof record.category === 'string' ? record.category : '?';
      const status = typeof record.StatusCode === 'number' ? record.StatusCode : '?';
      messages.push(`[${category}/${status}] ${record.Message}`);
    }
    for (const v of Object.values(record)) walk(v, depth + 1);
  }
  walk(body);
  return messages;
}

/**
 * Log a full error diagnostic for a non-OK CallResult: surface every
 * Travelport Result.Error[].Message and dump the body to disk.
 * Also dumps the REQUEST body so you can diff against a known-good
 * sample (e.g. the GDS reference-payload devkit's Postman collection).
 */
async function diagnoseError(
  label: string,
  result: { body: unknown; rawText: string },
  requestBody?: unknown
): Promise<void> {
  const messages = extractTravelportErrors(result.body);
  if (messages.length > 0) {
    console.error(`      ↳ Travelport errors (${messages.length}):`);
    for (const m of messages) console.error(`        • ${m}`);
  } else {
    console.error(`      ↳ no structured Result.Error[] in body`);
  }
  const file = await dumpForDiagnostics(`error-${label}`, result.body ?? result.rawText);
  if (file) console.error(`      ↳ full error body written to ${file}`);
  if (requestBody !== undefined) {
    const reqFile = await dumpForDiagnostics(`request-${label}`, requestBody);
    if (reqFile) console.error(`      ↳ request body we sent written to ${reqFile}`);
  }
}

function requireCreds(): void {
  const missing = (
    [
      ['TVP_CLIENT_ID', CLIENT_ID],
      ['TVP_CLIENT_SECRET', CLIENT_SECRET],
      ['TVP_USERNAME', USERNAME],
      ['TVP_PASSWORD', PASSWORD],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    console.error('✗ Missing required env vars:', missing.join(', '));
    console.error('  Set them in your shell (lead with a space to keep them out of history):');
    console.error('    export TVP_CLIENT_ID=... TVP_CLIENT_SECRET=... TVP_USERNAME=... TVP_PASSWORD=...');
    process.exit(2);
  }
}

async function getToken(): Promise<string> {
  console.log(`\n[1/5] OAuth token  →  POST ${OAUTH_URL}  (grant_type=${GRANT_TYPE})`);
  const body = new URLSearchParams({
    grant_type: GRANT_TYPE,
    username: USERNAME!,
    password: PASSWORD!,
    client_id: CLIENT_ID!,
    client_secret: CLIENT_SECRET!,
  });
  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  const text = await res.text();
  console.log(`      ↳ HTTP ${res.status} ${res.statusText}`);
  if (!res.ok) {
    // Error body is Travelport's, not our secrets — safe to surface for debugging.
    console.error('✗ Auth failed. Response body:\n' + text.slice(0, 1200));
    if (res.status === 400) {
      console.error('  Hint: try TVP_GRANT_TYPE=client_credentials (docs disagree on which 1G trials use).');
    }
    if (res.status === 401) console.error('  Hint: 401 → client_id/secret or username/password rejected (creds dead/expired).');
    process.exit(1);
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    console.error('✗ Token endpoint returned non-JSON:\n' + text.slice(0, 600));
    process.exit(1);
  }
  const token = json.access_token;
  if (!token) {
    console.error('✗ No access_token in response. Keys present:', Object.keys(json).join(', '));
    process.exit(1);
  }
  console.log(`      ↳ access_token: ${mask(token)}`);
  console.log(`      ↳ token_type: ${json.token_type ?? '(none)'}  expires_in: ${json.expires_in ?? '(none)'}s`);
  console.log('✓ CREDS ARE ALIVE — OAuth succeeded.');
  return token;
}

async function search(token: string): Promise<any | undefined> {
  const url = API_BASE + SEARCH_PATH;
  console.log(`\n[2/5] Live ${GDS} air search  →  POST ${url}`);
  console.log(`      ↳ ${FROM} → ${TO}  on ${DEPART}  (1 ADT)`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate', // mandatory per Travelport docs
    'Cache-Control': 'no-cache',
    'Accept-Version': ACCEPT_VERSION, // required for Air Search
    'Content-Version': ACCEPT_VERSION, // canonical devkit sets both
  };
  if (ACCESS_GROUP) headers['XAUTH_TRAVELPORT_ACCESSGROUP'] = ACCESS_GROUP;
  else headers['TVP-PCC-CORE'] = `${PCC}_${GDS}`; // e.g. 7K9S_1G

  // Body shape sourced verbatim from JSON Air v11 Search API reference.
  const payload = {
    CatalogProductOfferingsQueryRequest: {
      CatalogProductOfferingsRequest: {
        '@type': 'CatalogProductOfferingsRequestAir',
        offersPerPage: 10,
        PassengerCriteria: [{ '@type': 'PassengerCriteria', passengerTypeCode: 'ADT', number: 1 }],
        SearchCriteriaFlight: [
          {
            '@type': 'SearchCriteriaFlight',
            departureDate: DEPART,
            From: { value: FROM },
            To: { value: TO },
          },
        ],
      },
    },
  };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await res.text();
  console.log(`      ↳ HTTP ${res.status} ${res.statusText}`);

  if (res.status === 404) {
    console.error('△ 404 — auth proved good, but the search PATH/VERSION is off.');
    console.error(`  Adjust TVP_SEARCH_PATH (current: ${SEARCH_PATH}) or TVP_ACCEPT_VERSION (current: ${ACCEPT_VERSION}).`);
    return undefined;
  }
  if (res.status === 401 || res.status === 403) {
    console.error(`△ ${res.status} — token works for auth but the search call was rejected (scope/PCC/access-group).`);
    console.error('  Check TVP-PCC-CORE (' + `${PCC}_${GDS}` + ') vs an issued XAUTH_TRAVELPORT_ACCESSGROUP.');
    console.error('  Body:\n' + text.slice(0, 1000));
    return undefined;
  }
  if (!res.ok) {
    console.error('△ Search failed. Body:\n' + text.slice(0, 1500));
    return undefined;
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    console.error('△ Search returned non-JSON:\n' + text.slice(0, 600));
    return undefined;
  }

  // Report structure defensively — schema nesting can vary across provisioning.
  const resp = json.CatalogProductOfferingsResponse ?? json;
  const offerings =
    resp?.CatalogProductOfferings?.CatalogProductOffering ??
    resp?.CatalogProductOfferings ??
    [];
  const count = Array.isArray(offerings) ? offerings.length : 'unknown';
  console.log(`✓ LIVE DATA RETURNED — top-level keys: ${Object.keys(json).join(', ')}`);
  console.log(`      ↳ product offerings found: ${count}`);

  const fs = await import('node:fs/promises');
  await fs.writeFile(OUT_FILE, JSON.stringify(json, null, 2), 'utf8');
  console.log(`      ↳ full response written to ${OUT_FILE} (inspect the JSON shape you'd map cryptic onto)`);
  return json;
}

interface SearchRefs {
  searchIdentifier: string;
  offerId: string;
  productId: string;
}

/**
 * Extract the three identifiers `addOffer` needs (VERIFIED 2026-06-05):
 * - searchIdentifier: `CatalogProductOfferingsResponse.CatalogProductOfferings.Identifier.value`
 * - offerId: first `CatalogProductOffering.id` (short ref like "o1")
 * - productId: first `ProductBrandOffering[].Product[].productRef` (short ref like "p0")
 */
function extractSearchRefs(searchResponse: any): SearchRefs | undefined {
  const root = searchResponse?.CatalogProductOfferingsResponse ?? searchResponse;
  const searchIdentifier = root?.CatalogProductOfferings?.Identifier?.value;
  const offerings =
    root?.CatalogProductOfferings?.CatalogProductOffering ??
    root?.CatalogProductOfferings ??
    [];
  const arr = Array.isArray(offerings) ? offerings : [offerings];
  for (const o of arr) {
    const offerId: string | undefined = o?.id ?? o?.Identifier?.value;
    if (!offerId) continue;
    const pbo = (Array.isArray(o?.ProductBrandOptions) ? o.ProductBrandOptions : [])[0];
    const firstBrand = (Array.isArray(pbo?.ProductBrandOffering) ? pbo.ProductBrandOffering : [])[0];
    const firstProduct = (Array.isArray(firstBrand?.Product) ? firstBrand.Product : [])[0];
    const productId: string | undefined = firstProduct?.productRef;
    if (typeof searchIdentifier === 'string' && typeof productId === 'string') {
      return { searchIdentifier, offerId, productId };
    }
  }
  return undefined;
}

function extractFirstLocator(commitResp: any): string | undefined {
  // VERIFIED PRE-PROD via GDS reference-payload devkit's Postman:
  // `ReservationResponse.Reservation.Receipt[]` is an array — for a 1G
  // booking we want the entry whose `Confirmation.Locator.source === "1G"`.
  const receipts: any[] = Array.isArray(commitResp?.ReservationResponse?.Reservation?.Receipt)
    ? commitResp.ReservationResponse.Reservation.Receipt
    : Array.isArray(commitResp?.Receipt)
    ? commitResp.Receipt
    : [];
  const gds = receipts.find((r) => r?.Confirmation?.Locator?.source === '1G');
  const fallback = receipts.find((r) => r?.Confirmation?.Locator?.value);
  return (
    gds?.Confirmation?.Locator?.value ??
    fallback?.Confirmation?.Locator?.value ??
    commitResp?.Confirmation?.Locator?.value ??
    commitResp?.Locator?.value ??
    commitResp?.locator
  );
}

function extractFirstWbId(wbResp: any): string | undefined {
  return (
    // VERIFIED PRE-PROD 2026-06-05: ReservationResponse.Reservation.Identifier.
    wbResp?.ReservationResponse?.Reservation?.Identifier?.value ??
    wbResp?.ReservationWorkbench?.Identifier?.value ??
    wbResp?.Workbench?.Identifier?.value ??
    wbResp?.Identifier?.value ??
    wbResp?.workbenchID ??
    wbResp?.workbenchId
  );
}

/** Diagnostic: dump response + scan for any plausible workbench-id field. */
async function diagnoseWorkbenchShape(label: string, wbBody: unknown): Promise<void> {
  const file = await dumpForDiagnostics(label, wbBody);
  if (file) console.error(`      ↳ full response written to ${file}`);
  if (wbBody && typeof wbBody === 'object') {
    console.error(`      ↳ top-level keys: ${Object.keys(wbBody as object).join(', ')}`);
    // Heuristic search: any key matching /Identifier|workbench/i with a string value.
    const id = findFirstByKey(wbBody, /^(Identifier|workbench|id)$/i);
    if (id) console.error(`      ↳ heuristic hit: ${id.path} = ${id.value}`);
  } else {
    console.error(`      ↳ body preview: ${previewBody(wbBody)}`);
  }
}

function extractTravelerIds(travResp: any): string[] {
  // VERIFIED PRE-PROD 2026-06-06 from actual response dumps.
  // Singular addTraveler:
  //   { TravelerResponse: { Traveler: { Identifier: { value } } } }
  // Batch /travelers/list:
  //   { TravelerListResponse: { ReferenceList: [{ Traveler: [...] }] } }
  //   — there's a ReferenceList[] wrapper level we missed before, with
  //   each entry holding its own Traveler[] (typed
  //   ReferenceListTraveler).
  const batchRefs = travResp?.TravelerListResponse?.ReferenceList;
  if (Array.isArray(batchRefs)) {
    const ids: string[] = [];
    for (const ref of batchRefs) {
      const list = Array.isArray(ref?.Traveler) ? ref.Traveler : [];
      for (const t of list) {
        const id = t?.Identifier?.value ?? t?.id ?? '';
        if (typeof id === 'string' && id.length > 0) ids.push(id);
      }
    }
    if (ids.length > 0) return ids;
  }
  // Fallbacks: singular response + legacy flat shapes.
  const arr =
    travResp?.TravelerResponse?.Traveler ??
    travResp?.TravelerListResponse?.Traveler ??
    travResp?.Traveler ??
    [];
  const nodes = Array.isArray(arr) ? arr : [arr];
  return nodes
    .map((n: any) => n?.Identifier?.value ?? n?.id ?? '')
    .filter((s: string) => typeof s === 'string' && s.length > 0);
}

/**
 * Phase 3 — Workbench lifecycle. Builds end-to-end with the exact body
 * shapes LiveTravelportBackend emits, then tears down. The script
 * stops at the first hard error so we don't keep poking after a 4xx
 * tells us the shape is wrong.
 */
async function phaseWorkbench(token: string, refs: SearchRefs): Promise<void> {
  console.log('\n[3/5] Workbench lifecycle');

  // Step 1: create workbench
  const wb = await call(
    'POST',
    `${API_BASE}/air/book/session/reservationworkbench`,
    token,
    {},
    'createWorkbench'
  );
  if (!wb.ok) {
    console.error('△ createWorkbench failed');
    await diagnoseError('createwb-phase3', wb);
    return;
  }
  const wbId = extractFirstWbId(wb.body as any);
  if (!wbId) {
    console.error('△ createWorkbench: no workbenchID in any nominal path');
    await diagnoseWorkbenchShape('workbench-create-phase3', wb.body);
    console.error('      → Phase 3 cannot proceed; map this shape into LiveTravelportBackend');
    return;
  }
  cleanup.workbenches.push(wbId);
  console.log(`      workbenchID = ${wbId}`);

  // Step 2: add offer — canonical body verified pre-prod 2026-06-05.
  // Uses the three IDs from search response: searchIdentifier (the
  // transaction-level UUID), offerId (the short ref `o<n>`), and
  // productId (the short ref `p<n>` from the first ProductBrandOffering).
  const addOfferBody = {
    OfferQueryBuildFromCatalogProductOfferings: {
      BuildFromCatalogProductOfferingsRequest: {
        '@type': 'BuildFromCatalogProductOfferingsRequestAir',
        CatalogProductOfferingsIdentifier: { Identifier: { value: refs.searchIdentifier } },
        CatalogProductOfferingSelection: [
          {
            CatalogProductOfferingIdentifier: { Identifier: { value: refs.offerId } },
            ProductIdentifier: [{ Identifier: { value: refs.productId } }],
          },
        ],
      },
    },
  };
  const addOffer = await call(
    'POST',
    `${API_BASE}/air/book/airoffer/reservationworkbench/${encodeURIComponent(wbId)}/offers/buildfromcatalogproductofferings`,
    token,
    addOfferBody,
    'addOffer'
  );
  if (!addOffer.ok) {
    console.error('△ addOffer rejected.');
    await diagnoseError('addoffer-phase3', addOffer, addOfferBody);
    return;
  }

  // Step 3: add singular traveler. The canonical devkit body embeds
  // Telephone[] (and optionally Email[]) directly on the Traveler.
  // Without Telephone, commitWorkbench returns 200 OK with
  // ReservationResponse.Result.Error[].Message = "TELEPHONE IS A
  // REQUIRED FIELD" — a separate addPrimaryContact call doesn't
  // satisfy the requirement.
  const trav = await call(
    'POST',
    `${API_BASE}/air/book/traveler/reservationworkbench/${encodeURIComponent(wbId)}/travelers`,
    token,
    {
      Traveler: {
        '@type': 'Traveler',
        passengerTypeCode: 'ADT',
        PersonName: { '@type': 'PersonNameDetail', Given: 'JOHN', Surname: 'SMITH' },
        Telephone: [
          { '@type': 'Telephone', phoneNumber: '02012345678', role: 'Mobile' },
        ],
      },
    },
    'addTraveler (singular, object body)'
  );
  if (!trav.ok) {
    console.error('△ addTraveler rejected — Traveler body shape may need adjustment');
    await diagnoseError('addtraveler', trav);
    return;
  }
  const travelerId = extractTravelerIds(trav.body)[0];
  console.log(
    `      travelerId = ${travelerId || '(not surfaced — defensive fallback would push empty)'}`
  );

  // Step 4: SSR with TravelerIdentifier (the safe case)
  await call(
    'POST',
    `${API_BASE}/air/book/specialservices/reservationworkbench/${encodeURIComponent(wbId)}/specialservices/list`,
    token,
    {
      SpecialServiceListRequest: {
        SpecialServiceID: [
          {
            '@type': 'SpecialService',
            id: 'specialService_1',
            Identifier: { authority: 'Travelport', value: crypto.randomUUID() },
            SSRCode: 'VGML',
            ...(travelerId
              ? {
                  TravelerIdentifier: {
                    id: 'trav_1',
                    Identifier: { value: travelerId },
                  },
                }
              : {}),
            AppliesTo: {
              '@type': 'AppliesToOffer',
              OfferIdentifier: [
                {
                  id: 'o0',
                  offerRef: 'o0',
                  Identifier: { authority: 'Travelport', value: refs.offerId },
                },
              ],
            },
          },
        ],
      },
    },
    'addSpecialService (with TravelerIdentifier)'
  );

  // Step 5: SSR WITHOUT TravelerIdentifier (answers open question)
  const ssrWhole = await call(
    'POST',
    `${API_BASE}/air/book/specialservices/reservationworkbench/${encodeURIComponent(wbId)}/specialservices/list`,
    token,
    {
      SpecialServiceListRequest: {
        SpecialServiceID: [
          {
            '@type': 'SpecialService',
            id: 'specialService_2',
            Identifier: { authority: 'Travelport', value: crypto.randomUUID() },
            SSRCode: 'WCHR',
            AppliesTo: {
              '@type': 'AppliesToOffer',
              OfferIdentifier: [
                {
                  id: 'o0',
                  offerRef: 'o0',
                  Identifier: { authority: 'Travelport', value: refs.offerId },
                },
              ],
            },
          },
        ],
      },
    },
    'addSpecialService (WHOLE-BF — no TravelerIdentifier)'
  );
  if (ssrWhole.ok) {
    console.log('      → OPEN QUESTION ANSWERED: server accepts SSR without TravelerIdentifier (whole-BF scope OK).');
  } else if (ssrWhole.status === 400 || ssrWhole.status === 422) {
    console.log('      → OPEN QUESTION ANSWERED: server REJECTS SSR without TravelerIdentifier.');
    await diagnoseError('ssr-no-traveler', ssrWhole);
  } else {
    console.log('      → SSR without traveler returned non-validation error; inconclusive.');
    await diagnoseError('ssr-no-traveler', ssrWhole);
  }

  // Step 6: NP. reservation comment
  await call(
    'POST',
    `${API_BASE}/air/book/remarks/reservationworkbench/${encodeURIComponent(wbId)}/reservationcomments/list`,
    token,
    {
      ReservationCommentListRequest: {
        ReservationCommentID: [
          {
            '@type': 'ReservationComment',
            id: 'ReservationComment_1',
            commentSource: 'Agency',
            Comment: [{ name: 'Notepad', value: 'PRE-PROD VALIDATION RUN' }],
          },
        ],
      },
    },
    'addReservationComment (notepad)'
  );

  // Step 7: cash form-of-payment with canonical FormOfPaymentCash discriminator
  await call(
    'POST',
    `${API_BASE}/air/payment/reservationworkbench/${encodeURIComponent(wbId)}/formofpayment`,
    token,
    {
      FormOfPaymentCash: {
        id: 'formOfPayment_1',
        FormOfPaymentRef: 'formOfPayment_1',
      },
    },
    'addFormOfPayment (FormOfPaymentCash)'
  );

  // Step 8: add primary contact (phone) — required for commit
  await call(
    'POST',
    `${API_BASE}/air/book/primarycontact/reservationworkbench/${encodeURIComponent(wbId)}/primarycontacts`,
    token,
    { PrimaryContact: { Telephone: [{ phoneNumber: '02012345678', role: 'Mobile' }] } },
    'addPrimaryContact'
  );

  // Step 9: commit → locator
  const commit = await call(
    'POST',
    `${API_BASE}/air/book/reservation/reservations/${encodeURIComponent(wbId)}`,
    token,
    {
      ReservationQueryCommitReservation: {
        enableTwoStepCommitInd: false,
      },
    },
    'commitWorkbench'
  );
  if (!commit.ok) {
    console.error('△ commit failed');
    await diagnoseError('commit', commit);
    return;
  }
  const locator = extractFirstLocator(commit.body as any);
  console.log(`      → locator = ${locator ?? '(not surfaced)'}`);
  if (!locator) {
    // Diagnostic: dump the commit response so we can map the actual
    // Receipt-array shape. The Postman test assumes
    // ReservationResponse.Reservation.Receipt[] but pre-prod may put
    // it elsewhere or use a different `source` enum than "1G".
    const f = await dumpForDiagnostics('commit-response', commit.body);
    if (f) console.error(`      ↳ commit response dumped to ${f}`);
    // Surface a heuristic hit for any value-looking field — the
    // 6-char alphanumeric PNR locator is recognizable.
    const hit = findFirstByKey(commit.body, /^(value|Locator|PNR|RecordLocator)$/);
    if (hit) console.error(`      ↳ heuristic locator-ish hit: ${hit.path} = ${hit.value}`);
  }
  // After commit the workbench is consumed server-side; clear from cleanup
  // so the DELETE pass doesn't hit a 404.
  cleanup.workbenches = cleanup.workbenches.filter((id) => id !== wbId);
  if (!locator) return;

  // Step 10: retrieve by locator
  await call(
    'GET',
    `${API_BASE}/air/book/reservation/reservations/${encodeURIComponent(locator)}`,
    token,
    undefined,
    'retrieveReservation'
  );

  // Step 11: cancel committed BF with canonical CancelRequest body
  await call(
    'POST',
    `${API_BASE}/air/receipt/reservations/${encodeURIComponent(locator)}/receipts`,
    token,
    { '@type': 'CancelRequest', cancelAllInd: true },
    'cancelReservation (canonical CancelRequest)'
  );
}

/**
 * Phase 4 — Multi-pax `/travelers/list` batch envelope.
 */
async function phaseMultiPax(token: string, refs: SearchRefs): Promise<void> {
  console.log('\n[4/5] Multi-pax /travelers/list');

  const wb = await call(
    'POST',
    `${API_BASE}/air/book/session/reservationworkbench`,
    token,
    {},
    'createWorkbench (multi-pax test)'
  );
  if (!wb.ok) return;
  const wbId = extractFirstWbId(wb.body as any);
  if (!wbId) {
    console.error('△ createWorkbench (multi-pax): no workbenchID in any nominal path');
    await diagnoseWorkbenchShape('workbench-create-phase4', wb.body);
    console.error('      → Phase 4 cannot proceed without a wbId');
    return;
  }
  cleanup.workbenches.push(wbId);

  // Add offer using the canonical body. The 1-ADT search response carries
  // a 1-ADT offer; Phase 4's "2 ADT" framing reflects the post-addOffer
  // traveler-list batch, not the offer's pax count. (If pre-prod requires
  // a 2-pax-sized offer at this step, the search call needs to be reissued
  // with `number: 2` — but that's a Phase 4 limitation we surface later.)
  const addOfferBody = {
    OfferQueryBuildFromCatalogProductOfferings: {
      BuildFromCatalogProductOfferingsRequest: {
        '@type': 'BuildFromCatalogProductOfferingsRequestAir',
        CatalogProductOfferingsIdentifier: { Identifier: { value: refs.searchIdentifier } },
        CatalogProductOfferingSelection: [
          {
            CatalogProductOfferingIdentifier: { Identifier: { value: refs.offerId } },
            ProductIdentifier: [{ Identifier: { value: refs.productId } }],
          },
        ],
      },
    },
  };
  const addOffer = await call(
    'POST',
    `${API_BASE}/air/book/airoffer/reservationworkbench/${encodeURIComponent(wbId)}/offers/buildfromcatalogproductofferings`,
    token,
    addOfferBody,
    'addOffer (canonical body)'
  );
  if (!addOffer.ok) {
    console.log('      addOffer for 2 ADT failed — multi-pax batch skipped.');
    await diagnoseError('addoffer-phase4', addOffer, addOfferBody);
    return;
  }

  const batch = await call(
    'POST',
    `${API_BASE}/air/book/traveler/reservationworkbench/${encodeURIComponent(wbId)}/travelers/list`,
    token,
    {
      TravelerListRequest: {
        '@type': 'TravelerListRequest',
        Traveler: [
          {
            '@type': 'Traveler',
            passengerTypeCode: 'ADT',
            PersonName: { '@type': 'PersonNameDetail', Given: 'JOHN', Surname: 'SMITH' },
            Telephone: [{ '@type': 'Telephone', phoneNumber: '02012345678', role: 'Mobile' }],
          },
          {
            '@type': 'Traveler',
            passengerTypeCode: 'ADT',
            PersonName: { '@type': 'PersonNameDetail', Given: 'JANE', Surname: 'SMITH' },
            Telephone: [{ '@type': 'Telephone', phoneNumber: '02012345679', role: 'Mobile' }],
          },
        ],
      },
    },
    'addTravelers (batch /travelers/list)'
  );
  if (batch.ok) {
    const ids = extractTravelerIds(batch.body);
    console.log(`      → travelerIds (${ids.length}): ${ids.join(', ') || '(none surfaced)'}`);
    if (ids.length === 0) {
      // Singular addTraveler returns TravelerResponse.Traveler.Identifier;
      // batch /travelers/list shape is undocumented in the devkit's
      // example responses. Dump it so we can map the envelope.
      const f = await dumpForDiagnostics('travelers-list-response', batch.body);
      if (f) console.error(`      ↳ batch response dumped to ${f}`);
      if (batch.body && typeof batch.body === 'object') {
        console.error(`      ↳ top-level keys: ${Object.keys(batch.body as object).join(', ')}`);
      }
    }
  } else {
    console.log('      → batch /travelers/list rejected');
    await diagnoseError('travelers-list', batch);
  }
}

/**
 * Phase 5 — Fare display + fare-rules-from-fare-display chain.
 */
async function phaseFareLookup(token: string): Promise<void> {
  console.log('\n[5/5] Fare display + fare rules');
  const fd = await call(
    'POST',
    `${API_BASE}/air/faredisplay/fares`,
    token,
    {
      FareDisplayQueryRequest: {
        from: { value: FROM },
        to: { value: TO },
        departureDate: DEPART,
      },
    },
    'fareDisplay'
  );
  if (!fd.ok) return;
  const root = (fd.body as any)?.FareDisplayResponse ?? fd.body;
  const identifier = root?.Identifier?.value;
  // VERIFIED PRE-PROD 2026-06-05: `fareDisplay` is a SINGULAR object
  // containing `fare[]`, each with a numeric `sequence` (the per-line
  // FareID for /fromfaredisplay). Earlier guess assumed `fareDisplay`
  // was an array, off by one bracket pair.
  const firstFare =
    root?.fareDisplay?.fare?.[0]?.sequence ??
    root?.FareDisplay?.fare?.[0]?.sequence ??
    root?.fareDisplay?.[0]?.fare?.[0]?.sequence ??
    root?.FareDisplay?.[0]?.fare?.[0]?.sequence;
  console.log(`      → Identifier.value = ${identifier ?? '(not surfaced)'}`);
  console.log(`      → first fare sequence = ${firstFare ?? '(not surfaced)'}`);

  if (firstFare == null) {
    // Dump shape so the next iteration of the script can encode the
    // canonical path and we can fix `mapFareDisplay` accordingly.
    const file = await dumpForDiagnostics('fareDisplay', fd.body);
    if (file) console.error(`      ↳ fareDisplay full response written to ${file}`);
    if (root && typeof root === 'object') {
      console.error(`      ↳ FareDisplayResponse keys: ${Object.keys(root).join(', ')}`);
      const hit = findFirstByKey(root, /^(FareID|fareId|sequence|fareSequence)$/);
      if (hit) console.error(`      ↳ heuristic hit: ${hit.path} = ${hit.value}`);
    }
  }

  if (identifier && firstFare != null) {
    // VERIFIED 2026-06-05 against APIRef_FareRules.htm: /fromfaredisplay
    // accepts ShortText OR LongText. Pre-prod previously rejected LongText
    // with "INVALID INPUT FORMAT" — the docs' example uses ShortText, so
    // start there. If ShortText also 400s, the issue is the identifier
    // shape (possibly needs the same _PC suffix the /fromoffer variant uses).
    const params = new URLSearchParams({
      fareRuleIdentifier: identifier,
      FareID: String(firstFare),
      fareRuleType: 'ShortText',
    });
    const rules = await call(
      'GET',
      `${API_BASE}/air/farerule/farerules/fromfaredisplay?${params.toString()}`,
      token,
      undefined,
      'fareRulesFromFareDisplay'
    );
    if (!rules.ok) {
      console.error('      △ /fromfaredisplay rejected');
      await diagnoseError('farerules-fromfaredisplay', rules);
    }
  } else {
    console.log('      Skipping /fromfaredisplay — no identifier or sequence to chain against.');
  }
}

async function cleanupWorkbenches(token: string): Promise<void> {
  if (cleanup.workbenches.length === 0) return;
  console.log(`\n[cleanup] DELETE ${cleanup.workbenches.length} stray workbench(es)`);
  for (const wbId of cleanup.workbenches) {
    await call(
      'DELETE',
      `${API_BASE}/air/book/session/reservationworkbench/${encodeURIComponent(wbId)}`,
      token,
      undefined,
      `deleteWorkbench ${wbId}`
    );
  }
}

async function main(): Promise<void> {
  console.log('Travelport TripServices validation (pre-prod sandbox)');
  console.log(`PCC=${PCC}  GDS=${GDS}  API_BASE=${API_BASE}`);
  if (SKIP_PHASES.size > 0) {
    console.log(`Skipping phases: ${[...SKIP_PHASES].join(', ')}`);
  }
  requireCreds();

  let token = '';
  if (!SKIP_PHASES.has('1')) {
    token = await getToken();
  } else {
    console.log('Phase 1 skipped — no token; remaining phases will be skipped too.');
    return;
  }

  let searchBody: any = undefined;
  if (!SKIP_PHASES.has('2')) {
    searchBody = await search(token);
  }

  // Phase 3 + 4 need the search-transaction Identifier plus per-offer
  // and per-product short refs — see extractSearchRefs() for the
  // verified pre-prod paths.
  let refs: SearchRefs | undefined;
  if (searchBody) {
    refs = extractSearchRefs(searchBody);
    if (refs) {
      console.log(
        `      ↳ addOffer refs: search=${refs.searchIdentifier.slice(0, 8)}…  offer=${refs.offerId}  product=${refs.productId}`
      );
    }
  }

  try {
    if (!SKIP_PHASES.has('3')) {
      if (!refs) {
        console.log('\n[3/5] Skipped — could not extract search/offer/product IDs from search response.');
      } else {
        await phaseWorkbench(token, refs);
      }
    }
    if (!SKIP_PHASES.has('4')) {
      if (!refs) {
        console.log('\n[4/5] Skipped — could not extract search/offer/product IDs.');
      } else {
        await phaseMultiPax(token, refs);
      }
    }
    if (!SKIP_PHASES.has('5')) {
      await phaseFareLookup(token);
    }
  } finally {
    if (token) await cleanupWorkbenches(token).catch(() => undefined);
  }

  console.log('\nDone. (Re-running hits the live API again.)');
}

main().catch((err) => {
  console.error('✗ Unexpected error:', err?.message ?? err);
  process.exit(1);
});
