/**
 * validate-stays-creds.ts — Travelport Stays API v11 entitlement probe.
 *
 * PURPOSE: settle the ONE gating question from docs/live-stays-wiring.md —
 * does the 7K9S trial tenant have STAYS (hotel) entitlement? The Stays API
 * is GA REST on the SAME host/auth as the Flights wire we already run, so if
 * the tenant can see it, live hotel (HOA/HOC/sell) becomes wireable the way
 * air was.
 *
 * It makes at most TWO live calls: OAuth, then ONE hotel property search.
 * The answer is read from the HTTP status:
 *   200       → entitled AND our body shape is accepted (response dumped).
 *   400       → ENTITLED, but the request body needs the verified envelope
 *               (expected — the public docs only show a `SearchBy` fragment,
 *               not where dates/guests nest). Still a GO for the integration.
 *   401 / 403 → NOT entitled (scope/PCC/access-group) — live hotel is blocked
 *               on the trial tenant; stays emulated until an entitled tenant.
 *   404       → path/version wrong (adjust TVP_STAYS_SEARCH_PATH / version).
 *
 * ── WHAT THIS SENDS OVER THE NETWORK (read before running) ─────────────────
 * 1. OAuth: POST auth.pp.travelport.net/oauth/token (creds from env only).
 * 2. ONE POST api.pp.travelport.net/11/hotel/search/properties/search with a
 *    synthetic airport search (default CDG, ~30 days out, 1 room / 2 guests).
 * No personal data. No booking. Nothing written server-side. Single call —
 * no retries, no limit probing (the vendor-pacing rule). Bearer token on the
 * search call; token masked in logs; secrets never echoed.
 *
 * ── RUN (creds already exported in your shell) ─────────────────────────────
 *   npx tsx validate-stays-creds.ts
 *   # dump the response shape for the hospitality mapper:
 *   TVP_STAYS_OUT=./stays-search-response.json npx tsx validate-stays-creds.ts
 *   # if the air PCC isn't entitled for hotel, try an issued hotel access group:
 *   TVP_STAYS_ACCESS_GROUP=<group> npx tsx validate-stays-creds.ts
 */

const OAUTH_URL = process.env.TVP_OAUTH_URL ?? 'https://auth.pp.travelport.net/oauth/token';
const API_BASE = process.env.TVP_API_BASE ?? 'https://api.pp.travelport.net/11';
const SEARCH_PATH = process.env.TVP_STAYS_SEARCH_PATH ?? '/hotel/search/properties/search';
const GRANT_TYPE = process.env.TVP_GRANT_TYPE ?? 'password';
const PCC = process.env.TVP_PCC ?? '7K9S';
const GDS = process.env.TVP_GDS ?? '1G';
// Hotel may need a different access group than the air PCC-core; override here.
const ACCESS_GROUP = process.env.TVP_STAYS_ACCESS_GROUP ?? process.env.TVP_ACCESS_GROUP;
const ACCEPT_VERSION = process.env.TVP_ACCEPT_VERSION ?? '11';
const AIRPORT = process.env.TVP_STAYS_AIRPORT ?? 'CDG';
const OUT_FILE = process.env.TVP_STAYS_OUT; // only written on 2xx, opt-in

const CLIENT_ID = process.env.TVP_CLIENT_ID;
const CLIENT_SECRET = process.env.TVP_CLIENT_SECRET;
const USERNAME = process.env.TVP_USERNAME;
const PASSWORD = process.env.TVP_PASSWORD;

function isoPlusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
const CHECKIN = process.env.TVP_STAYS_CHECKIN ?? isoPlusDays(30);
const CHECKOUT = process.env.TVP_STAYS_CHECKOUT ?? isoPlusDays(32);

function mask(token: string): string {
  return token.length <= 10 ? `***(${token.length} chars)` : `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)`;
}

function requireCreds(): void {
  const missing = (
    [
      ['TVP_CLIENT_ID', CLIENT_ID],
      ['TVP_CLIENT_SECRET', CLIENT_SECRET],
      ['TVP_USERNAME', USERNAME],
      ['TVP_PASSWORD', PASSWORD],
    ] as const
  ).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    console.error('✗ Missing required env vars:', missing.join(', '));
    console.error('  Export them in your shell, then: npx tsx validate-stays-creds.ts');
    process.exit(2);
  }
}

async function getToken(): Promise<string> {
  console.log(`\n[1/2] OAuth token  →  POST ${OAUTH_URL}  (grant_type=${GRANT_TYPE})`);
  const body = new URLSearchParams({
    grant_type: GRANT_TYPE,
    username: USERNAME!,
    password: PASSWORD!,
    client_id: CLIENT_ID!,
    client_secret: CLIENT_SECRET!,
  });
  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const text = await res.text();
  console.log(`      ↳ HTTP ${res.status} ${res.statusText}`);
  if (!res.ok) {
    console.error('✗ Auth failed. Response body:\n' + text.slice(0, 1000));
    process.exit(1);
  }
  const token = (JSON.parse(text) as { access_token?: string }).access_token;
  if (!token) {
    console.error('✗ No access_token in response.');
    process.exit(1);
  }
  console.log(`      ↳ access_token: ${mask(token)}`);
  console.log('✓ CREDS ARE ALIVE — OAuth succeeded.');
  return token;
}

function extractMessages(body: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || body == null || typeof body !== 'object') return out;
  if (Array.isArray(body)) { for (const c of body) extractMessages(c, out, depth + 1); return out; }
  const r = body as Record<string, unknown>;
  if (typeof r.Message === 'string' && r.Message.length > 0) {
    const cat = typeof r.category === 'string' ? r.category : '?';
    const st = typeof r.StatusCode === 'number' ? r.StatusCode : '?';
    out.push(`[${cat}/${st}] ${r.Message}`);
  }
  for (const v of Object.values(r)) extractMessages(v, out, depth + 1);
  return out;
}

async function hotelSearch(token: string): Promise<void> {
  const url = API_BASE + SEARCH_PATH;
  console.log(`\n[2/2] Stays hotel search  →  POST ${url}`);
  console.log(`      ↳ airport ${AIRPORT}  ${CHECKIN} → ${CHECKOUT}  (1 room / 2 guests)`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Cache-Control': 'no-cache',
    'Accept-Version': ACCEPT_VERSION,
    'Content-Version': ACCEPT_VERSION,
  };
  if (ACCESS_GROUP) headers['XAUTH_TRAVELPORT_ACCESSGROUP'] = ACCESS_GROUP;
  else headers['TVP-PCC-CORE'] = `${PCC}_${GDS}`;

  // Best-effort body. The public use-case shows only the `SearchBy`
  // fragment (SearchByAirport / SearchAirport / SearchRadius) and says
  // check-in/out + guests are "required but not shown" — so a 400 here
  // means ENTITLED-but-body-shape, which is still a GO. The entitlement
  // gate (401/403) is evaluated before body validation, so this probe
  // answers the gating question regardless of body correctness.
  // Body VERIFIED against the Stays v11.34 OpenAPI spec (components.schemas
  // PropertiesQuerySearchWrapper → PropertiesQuerySearch). The earlier probe
  // runs found the answer: 7K9S IS entitled (400 VALIDATION, not 403), the
  // wrapper is PropertiesQuerySearch, and CheckInDate/CheckOutDate live at
  // the PropertiesQuerySearch ROOT (capital I/O) — not under a HotelStay
  // object (my first guess, which earned "CHECK IN DATE DATA IS INVALID").
  // Required: @type, CheckInDate, CheckOutDate, SearchBy.
  //
  // Run 3 (this verified body) → HTTP 500 INTERNAL SERVER ERROR. The body
  // PASSED field validation (400→500), so the schema is right; the 500 is
  // server-side. Most likely the 7K9S trial tenant has Stays API ACCESS
  // but no hotel CONTENT provisioning (mirrors the air ticketing gate) —
  // though one 500 could be transient. Did NOT re-run (pacing rule). Net:
  // chunk 2 can be built + unit-tested against the spec response schema;
  // a live end-to-end with real hotel data is gated on content provisioning.
  const payload = {
    PropertiesQuerySearch: {
      '@type': 'PropertiesQuerySearch',
      CheckInDate: CHECKIN,
      CheckOutDate: CHECKOUT,
      SearchBy: {
        '@type': 'SearchByAirport',
        SearchAirport: AIRPORT,
        SearchRadius: { value: 25, unitOfDistance: 'Miles' },
      },
      RoomStayCandidate: [
        { GuestCounts: { '@type': 'GuestCounts', GuestCount: [{ '@type': 'GuestCount', count: 2 }] } },
      ],
    },
  };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`      ↳ HTTP ${res.status} ${res.statusText}`);
  const msgs = extractMessages(parsed);
  for (const m of msgs) console.log(`        • ${m}`);

  console.log('\n══════════════════════ VERDICT ══════════════════════');
  if (res.status === 200) {
    // A 200 means the search RAN — even with informational Result
    // messages like "Rates unavailable for N properties" (DEN returns
    // ~56 properties alongside that). Capture it; the messages are not
    // errors.
    const root = (parsed as any)?.PropertiesResponse ?? parsed;
    const count = Array.isArray(root?.Properties?.PropertyInfo) ? root.Properties.PropertyInfo.length : 'unknown';
    console.log(`✓ ENTITLED + LIVE DATA — search ran, ${count} properties returned.`);
    if (msgs.length > 0) console.log(`  (informational, not errors: ${msgs.length} Result message(s) above.)`);
    if (OUT_FILE) {
      const fs = await import('node:fs/promises');
      await fs.writeFile(OUT_FILE, JSON.stringify(parsed, null, 2), 'utf8');
      console.log(`  → full response written to ${OUT_FILE} — verify mapHotelSearch against it.`);
    } else {
      console.log('  → re-run with TVP_STAYS_OUT=./stays-den-search.json to capture the shape.');
    }
  } else if (res.status === 400) {
    console.log('✓ ENTITLED — the tenant can reach Stays; only our REQUEST BODY shape is off.');
    console.log('  Body validation failed (see the message above). The entitlement gate is PASSED.');
  } else if (res.status === 401 || res.status === 403) {
    console.log('✗ NOT ENTITLED — auth works but Stays is rejected for this tenant/PCC/access-group.');
    console.log(`  (TVP-PCC-CORE ${PCC}_${GDS}.) Try an issued hotel access group via`);
    console.log('  TVP_STAYS_ACCESS_GROUP=<group>. If none exists, live hotel stays BLOCKED on the');
    console.log('  trial tenant — same posture as production ticketing — and hotel stays emulated.');
  } else if (res.status === 404) {
    console.log('△ 404 — auth fine, but the search PATH/VERSION is off.');
    console.log(`  Adjust TVP_STAYS_SEARCH_PATH (current ${SEARCH_PATH}) / TVP_ACCEPT_VERSION (${ACCEPT_VERSION}).`);
  } else {
    console.log(`△ Unexpected ${res.status}. Body:\n${text.slice(0, 800)}`);
  }
  console.log('══════════════════════════════════════════════════════');
}

async function main(): Promise<void> {
  console.log('Travelport Stays API v11 — entitlement probe (pre-prod)');
  console.log(`PCC=${PCC}  GDS=${GDS}  API_BASE=${API_BASE}  ${ACCESS_GROUP ? 'ACCESS_GROUP set' : 'TVP-PCC-CORE'}`);
  requireCreds();
  const token = await getToken();
  await hotelSearch(token);
  console.log('\nDone. (Single live call — re-running hits the API again.)');
}

main().catch((err) => {
  console.error('✗ Unexpected error:', err?.message ?? err);
  process.exit(1);
});
