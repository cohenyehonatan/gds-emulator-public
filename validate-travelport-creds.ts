/**
 * validate-travelport-creds.ts — THROWAWAY SPIKE, not part of the emulator.
 *
 * Purpose: prove the 7K9S trial creds are alive against Travelport TripServices
 * (pre-production) and that a live Galileo (1G) air search returns real JSON.
 * This is step 1 of the "live Galileo backend" question — it must pass before
 * any Dialect/Backend refactor is justified. It touches none of src/.
 *
 * ── WHAT THIS SENDS OVER THE NETWORK (read before running) ─────────────────
 *   1. POST https://auth.pp.travelport.net/oauth/token
 *        Body (x-www-form-urlencoded): grant_type, username, password,
 *        client_id, client_secret. → your trial credentials are transmitted to
 *        Travelport's pre-prod auth server over HTTPS to obtain a Bearer token.
 *   2. POST https://api.pp.travelport.net/11/air/catalog/search/catalogproductofferings
 *        Body (JSON): one one-way air search (1 ADT, origin→dest on a date).
 *        Headers include the Bearer token + TVP-PCC-CORE: <PCC>_<GDS> (e.g. 7K9S_1G).
 * Nothing is sent anywhere else. Endpoints/headers are sourced from
 * support.travelport.com (JSON Air v11) and developer.travelport.com.
 *
 * ── SECRET HANDLING ────────────────────────────────────────────────────────
 * Creds are read ONLY from environment variables you set in your own shell.
 * Nothing is hardcoded. The access token and your secrets are NEVER printed in
 * full (token is masked; secrets are never echoed). The full search response is
 * written to a local file (synthetic sandbox data) for inspection, not dumped.
 *
 * ── RUN ────────────────────────────────────────────────────────────────────
 *   # set creds without leaving them in shell history (note the leading space):
 *    export TVP_CLIENT_ID=...   TVP_CLIENT_SECRET=...
 *    export TVP_USERNAME=...    TVP_PASSWORD=...
 *   npx tsx validate-travelport-creds.ts
 *
 * Single legitimate call to each endpoint — no retry storms, no limit probing
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

const CLIENT_ID = process.env.TVP_CLIENT_ID;
const CLIENT_SECRET = process.env.TVP_CLIENT_SECRET;
const USERNAME = process.env.TVP_USERNAME;
const PASSWORD = process.env.TVP_PASSWORD;

function defaultDate(): string {
  const d = new Date(Date.now() + 30 * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function mask(token: string): string {
  if (token.length <= 10) return `***(${token.length} chars)`;
  return `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)`;
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

async function search(token: string): Promise<void> {
  const url = API_BASE + SEARCH_PATH;
  console.log(`\n[2/2] Live ${GDS} air search  →  POST ${url}`);
  console.log(`      ↳ ${FROM} → ${TO}  on ${DEPART}  (1 ADT)`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate', // mandatory per Travelport docs
    'Cache-Control': 'no-cache',
    'Accept-Version': ACCEPT_VERSION, // required for Air Search
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
    return;
  }
  if (res.status === 401 || res.status === 403) {
    console.error(`△ ${res.status} — token works for auth but the search call was rejected (scope/PCC/access-group).`);
    console.error('  Check TVP-PCC-CORE (' + `${PCC}_${GDS}` + ') vs an issued XAUTH_TRAVELPORT_ACCESSGROUP.');
    console.error('  Body:\n' + text.slice(0, 1000));
    return;
  }
  if (!res.ok) {
    console.error('△ Search failed. Body:\n' + text.slice(0, 1500));
    return;
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    console.error('△ Search returned non-JSON:\n' + text.slice(0, 600));
    return;
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
}

async function main(): Promise<void> {
  console.log('Travelport TripServices creds + live-search validation (pre-prod sandbox)');
  console.log(`PCC=${PCC}  GDS=${GDS}  API_BASE=${API_BASE}`);
  requireCreds();
  const token = await getToken();
  await search(token);
  console.log('\nDone. (Single call per endpoint — re-running hits the live API again.)');
}

main().catch((err) => {
  console.error('✗ Unexpected error:', err?.message ?? err);
  process.exit(1);
});
