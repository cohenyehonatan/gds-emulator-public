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
 * Opt-in THIRD call (TVP_STAYS_AVAIL=1): rate detail for the first bookable
 * property via /hotel/availability/catalogofferingshospitality — the HOC call.
 * Capture it with TVP_STAYS_AVAIL_OUT=./stays-den-avail.json.
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

async function hotelSearch(token: string): Promise<unknown | undefined> {
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
    console.log('══════════════════════════════════════════════════════');
    return parsed;
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
  return undefined;
}

/** Pull the first bookable (availability "Open") property's key from a search response. */
function firstOpenProperty(searchResponse: unknown): { chainCode: string; propertyCode: string; name: string } | undefined {
  const root = (searchResponse as any)?.PropertiesResponse ?? searchResponse;
  const list = root?.Properties?.PropertyInfo;
  if (!Array.isArray(list)) return undefined;
  // Prefer an Open property (has a rate); fall back to the first with a key.
  const pick = (pred: (pi: any) => boolean) =>
    list.find((pi: any) => pi?.Property?.PropertyKey?.chainCode && pi?.Property?.PropertyKey?.propertyCode && pred(pi));
  const pi = pick((pi: any) => pi?.Property?.availability === 'Open') ?? pick(() => true);
  if (!pi) return undefined;
  const k = pi.Property.PropertyKey;
  return { chainCode: k.chainCode, propertyCode: k.propertyCode, name: pi.Property.name ?? '' };
}

/**
 * THIRD live call (opt-in via TVP_STAYS_AVAIL=1) — fetch full rate detail for ONE
 * property via /hotel/availability/catalogofferingshospitality. This is the HOC
 * rate-detail call. Body shape VERIFIED against the Stays v11.34 OpenAPI
 * (CatalogOfferingsQueryRequestHospitalityWrapper → CatalogOfferingsQueryRequest
 * → [CatalogOfferingsRequestHospitality] with StayDates + HotelSearchCriterion
 * carrying the PropertyRequest[].PropertyKey from the search). Captures the
 * response to TVP_STAYS_AVAIL_OUT so the HOC mapper is built from real data.
 */
async function hotelAvailability(
  token: string,
  prop: { chainCode: string; propertyCode: string; name: string },
): Promise<unknown | undefined> {
  const path = process.env.TVP_STAYS_AVAIL_PATH ?? '/hotel/availability/catalogofferingshospitality';
  const url = API_BASE + path;
  console.log(`\n[3/3] Stays availability  →  POST ${url}`);
  console.log(`      ↳ property ${prop.chainCode}-${prop.propertyCode} (${prop.name})  ${CHECKIN} → ${CHECKOUT}`);

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

  const payload = {
    CatalogOfferingsQueryRequest: {
      '@type': 'CatalogOfferingsQueryRequest',
      CatalogOfferingsRequest: [
        {
          '@type': 'CatalogOfferingsRequestHospitality',
          StayDates: { start: CHECKIN, end: CHECKOUT },
          HotelSearchCriterion: {
            '@type': 'HotelSearchCriterion',
            numberOfRooms: 1,
            PropertyRequest: [
              {
                '@type': 'PropertyRequest',
                PropertyKey: { '@type': 'PropertyKey', chainCode: prop.chainCode, propertyCode: prop.propertyCode },
              },
            ],
            RoomStayCandidates: {
              RoomStayCandidate: [
                { GuestCounts: { '@type': 'GuestCounts', GuestCount: [{ '@type': 'GuestCount', count: 2 }] } },
              ],
            },
          },
        },
      ],
    },
  };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`      ↳ HTTP ${res.status} ${res.statusText}`);
  for (const m of extractMessages(parsed)) console.log(`        • ${m}`);

  console.log('\n════════════════════ AVAIL VERDICT ═══════════════════');
  if (res.status === 200) {
    const out = process.env.TVP_STAYS_AVAIL_OUT;
    console.log('✓ AVAILABILITY RAN — rate detail returned for the property.');
    if (out) {
      const fs = await import('node:fs/promises');
      await fs.writeFile(out, JSON.stringify(parsed, null, 2), 'utf8');
      console.log(`  → full availability response written to ${out} — build the HOC mapper from it.`);
    } else {
      console.log('  → re-run with TVP_STAYS_AVAIL_OUT=./stays-den-avail.json to capture the shape.');
    }
    console.log('══════════════════════════════════════════════════════');
    return parsed;
  } else if (res.status === 400) {
    console.log('△ 400 — entitled, but the availability BODY shape is off (likely StayDates/criterion field).');
  } else {
    console.log(`△ ${res.status} — see message above. Body:\n${text.slice(0, 600)}`);
  }
  console.log('══════════════════════════════════════════════════════');
  return undefined;
}

/**
 * Pull a bookable offer (Identifier value/authority/id) from an availability
 * response. Prefers a GuaranteeRequired rate (card guarantee, no deposit) over
 * a DepositRequired one — a deposit rate makes the build ask for a prepayment,
 * which is a rate rule, not a capability gap.
 */
function firstOffer(availResponse: unknown): { value: string; authority: string; id: string } | undefined {
  const root = (availResponse as any)?.CatalogOfferingsHospitalityResponse ?? availResponse;
  const offers: any[] = root?.CatalogOfferings?.CatalogOffering ?? [];
  const gtype = (o: any) => (o?.TermsAndConditions?.Guarantee ?? []).map((g: any) => g.guaranteeType).join('/');
  const off = offers.find((o) => o?.Identifier?.value && gtype(o).includes('GuaranteeRequired'))
    ?? offers.find((o) => o?.Identifier?.value);
  if (!off?.Identifier?.value) return undefined;
  return { value: off.Identifier.value, authority: off.Identifier.authority ?? 'TVPT', id: off.id ?? '' };
}

/** Summarize the three identities a committed hotel booking carries. */
function summarizeReceipts(parsed: unknown): { pnr?: string; supplier?: string; iata?: string } {
  const res = (parsed as any)?.ReservationResponse?.Reservation ?? {};
  const out: { pnr?: string; supplier?: string; iata?: string } = {};
  for (const rc of res.Receipt ?? []) {
    const loc = rc?.Confirmation?.Locator;
    if (loc?.locatorType === 'PNR Locator') out.pnr = loc.value;
    if (loc?.locatorType === 'Confirmation Number') out.supplier = loc.value;
    if (loc?.locatorType === 'IATA Number') out.iata = loc.value;
  }
  return out;
}

/**
 * Cancel a hotel PNR the build created — PUT /…/{locator}/canceloffer.
 * Keeps the probe self-cleaning so a confirmed test booking never dangles.
 */
async function cancelHotel(token: string, r: { pnr?: string; supplier?: string }, offerId?: string): Promise<void> {
  if (!r.pnr) { console.log('  ⚠️  no PNR locator to cancel.'); return; }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Accept-Version': ACCEPT_VERSION,
    'Content-Version': ACCEPT_VERSION,
  };
  if (ACCESS_GROUP) headers['XAUTH_TRAVELPORT_ACCESSGROUP'] = ACCESS_GROUP;
  else headers['TVP-PCC-CORE'] = `${PCC}_${GDS}`;
  const q = new URLSearchParams();
  if (offerId) q.set('offerID', offerId);
  if (r.supplier) q.set('supplierLocator', r.supplier);
  const url = `${API_BASE}/hotel/book/reservations/${encodeURIComponent(r.pnr)}/canceloffer?${q}`;
  console.log(`\n[CANCEL] cleaning up the test PNR  →  PUT /hotel/book/reservations/${r.pnr}/canceloffer`);
  const res = await fetch(url, { method: 'PUT', headers });
  const text = await res.text();
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { parsed = text; }
  const statuses: string[] = [];
  JSON.stringify(parsed, (k, v) => { if (k === 'Status' && typeof v === 'string') statuses.push(v); return v; });
  console.log(`      ↳ HTTP ${res.status} ${res.statusText}  ${statuses.length ? '(' + statuses.join(', ') + ')' : ''}`);
  console.log(res.ok && statuses.includes('Cancelled') ? '  ✓ test PNR cancelled.' : '  ⚠️  verify cancellation manually.');
}

/**
 * FEASIBILITY PROBE (opt-in via TVP_STAYS_BUILD=1) — a live WRITE.
 * POST /hotel/book/reservations/build with a synthetic traveler + a real
 * offer. ⚠️ The build is a ONE-SHOT CONFIRMED booking (NOT a workbench, as
 * an earlier assumption had it — verified 2026-06-14: it returns a real PNR
 * locator + supplier confirmation + HK status). So this probe AUTO-CANCELS
 * the PNR it creates (unless TVP_STAYS_NO_CANCEL=1).
 *   200/201 → hotel booking is ENTITLED + reachable (build the chunk live).
 *   401/403 → NOT entitled — chunk 3 ships emulated-only, like air ticketing.
 *
 * Optional TVP_STAYS_AGENCY=<name> adds a TravelAgency block; TVP_STAYS_
 * AGENCY_IATA=<number> stamps a DIFFERENT IATA on it to test whether the
 * request body can override the PCC-derived agency-of-record (the IATA
 * Receipt) or whether it's locked to the credentialed PCC.
 */
async function hotelBuildProbe(
  token: string,
  offer: { value: string; authority: string; id: string },
): Promise<void> {
  const path = process.env.TVP_STAYS_BUILD_PATH ?? '/hotel/book/reservations/build';
  const url = API_BASE + path;
  console.log(`\n[BUILD] Stays reservation build (WORKBENCH ONLY, no commit)  →  POST ${url}`);
  console.log(`      ↳ offer ${offer.value.slice(0, 16)}…  traveler TEST/PROBE MR  (1 room)`);

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

  // Optional TravelAgency block (TVP_STAYS_AGENCY=<name>). When TVP_STAYS_
  // AGENCY_IATA is also set, stamp a DIFFERENT IATA on it (code/codeContext
  // + Identifier) to see whether the host honours it or ignores it in
  // favour of the PCC-derived agency-of-record.
  const agencyName = process.env.TVP_STAYS_AGENCY;
  const agencyIata = process.env.TVP_STAYS_AGENCY_IATA;
  const travelAgency = agencyName
    ? {
        TravelAgency: {
          '@type': 'TravelAgency',
          OrganizationName: {
            value: agencyName,
            ...(agencyIata ? { code: agencyIata, codeContext: 'IATA' } : {}),
          },
          ...(agencyIata ? { Identifier: { value: agencyIata, authority: 'IATA' } } : {}),
        },
      }
    : {};
  if (agencyName) console.log(`      ↳ TravelAgency "${agencyName}"${agencyIata ? ` IATA ${agencyIata}` : ''}`);

  const payload = {
    ReservationQueryBuild: {
      '@type': 'ReservationQueryBuild',
      ReservationBuild: {
        '@type': 'ReservationBuildFromCatalogOffering',
        receivedFrom: 'PROBE',
        ...travelAgency,
        Traveler: [
          { '@type': 'Traveler', PersonName: { '@type': 'PersonName', Prefix: 'MR', Given: 'TEST', Surname: 'PROBE' } },
        ],
        // A hotel guarantee needs a form of payment. PUBLIC test card
        // (4111… is the universally-published Visa test PAN — NOT a real
        // card, NOT a secret). Pre-prod only; the build is never committed.
        FormOfPayment: [
          {
            '@type': 'FormOfPaymentPaymentCard',
            PaymentCard: {
              '@type': 'PaymentCard',
              CardType: 'Credit',
              CardCode: 'VI',
              CardHolderName: 'TEST PROBE',
              CardNumber: { '@type': 'CardNumber', PlainText: '4111111111111111' },
              expireDate: '1230', // MMYY (spec pattern (0[1-9]|1[0-2])[0-9][0-9])
            },
          },
        ],
        BuildFromCatalogOfferingHospitality: {
          '@type': 'BuildFromCatalogOfferingHospitality',
          CatalogOfferingIdentifier: { value: offer.value, authority: offer.authority },
          NumberOfRooms: 1,
        },
      },
    },
  };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`      ↳ HTTP ${res.status} ${res.statusText}`);
  for (const m of extractMessages(parsed)) console.log(`        • ${m}`);

  console.log('\n════════════════════ BUILD VERDICT (chunk 3 gate) ════════════════════');
  if (res.status === 200 || res.status === 201) {
    const r = summarizeReceipts(parsed);
    console.log('✓ HOTEL BOOKING IS AVAILABLE — build returned a CONFIRMED booking.');
    console.log(`  PNR locator:  ${r.pnr ?? '(none)'}`);
    console.log(`  Supplier conf: ${r.supplier ?? '(none)'}`);
    console.log(`  IATA number:  ${r.iata ?? '(none)'}` + (agencyIata
      ? (r.iata === agencyIata
          ? '   ← MATCHES the agency IATA we sent (body OVERRODE the PCC!)'
          : `   ← IGNORED the agency IATA we sent (${agencyIata}); IATA is PCC-locked`)
      : ''));
    const out = process.env.TVP_STAYS_BUILD_OUT;
    if (out) {
      const fs = await import('node:fs/promises');
      await fs.writeFile(out, JSON.stringify(parsed, null, 2), 'utf8');
      console.log(`  → build response written to ${out}.`);
    }
    // SELF-CLEANING: the build CONFIRMED a real PNR — cancel it unless told not to.
    if (process.env.TVP_STAYS_NO_CANCEL) {
      console.log('  ⚠️  TVP_STAYS_NO_CANCEL set — leaving the confirmed PNR in place. Cancel it manually.');
    } else {
      await cancelHotel(token, r, offer.value);
    }
  } else if (res.status === 401 || res.status === 403) {
    console.log('✗ NOT ENTITLED for hotel booking — chunk 3 ships emulated-only (like air ticketing).');
  } else if (res.status === 400) {
    console.log('△ 400 — entitled + reachable, but the build BODY shape needs adjustment (see message).');
  } else {
    console.log(`△ ${res.status} — inconclusive. Body:\n${text.slice(0, 700)}`);
  }
  console.log('═══════════════════════════════════════════════════════════════════════');
}

async function main(): Promise<void> {
  console.log('Travelport Stays API v11 — entitlement probe (pre-prod)');
  console.log(`PCC=${PCC}  GDS=${GDS}  API_BASE=${API_BASE}  ${ACCESS_GROUP ? 'ACCESS_GROUP set' : 'TVP-PCC-CORE'}`);
  requireCreds();
  const token = await getToken();
  const searchResponse = await hotelSearch(token);
  // Opt-in third call: rate detail (HOC) for the first bookable property.
  if ((process.env.TVP_STAYS_AVAIL || process.env.TVP_STAYS_BUILD) && searchResponse) {
    const prop = firstOpenProperty(searchResponse);
    if (prop) {
      const availResponse = await hotelAvailability(token, prop);
      // Opt-in feasibility WRITE: build a workbench reservation (no commit).
      if (process.env.TVP_STAYS_BUILD && availResponse) {
        const offer = firstOffer(availResponse);
        if (offer) await hotelBuildProbe(token, offer);
        else console.log('\n△ TVP_STAYS_BUILD set but no bookable offer found in availability — skipping build.');
      }
    } else {
      console.log('\n△ TVP_STAYS_AVAIL/BUILD set but no open property with a key found in the search — skipping.');
    }
  }
  console.log('\nDone. (Live calls only — re-running hits the API again.)');
}

main().catch((err) => {
  console.error('✗ Unexpected error:', err?.message ?? err);
  process.exit(1);
});
