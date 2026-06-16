# Live hotel wiring — Travelport Stays API v11

**Status:** scoped, not started. **Created:** 2026-06-14.

## Why this doc exists (the correction)

Earlier work concluded "hotel/car has no v11 REST equivalent — local-only by
design." **That was wrong for hotel.** The Travelport **Stays API v11** is a GA,
RESTful JSON surface on the *same* TripServices platform as the Flights wire we
already run:

- Base URL: `https://api.pp.travelport.net/11` (pre-prod) / `https://api.travelport.net/11` (prod) — identical to `LiveTravelportBackend.opts.apiBase`.
- Same OAuth family (password grant against `auth.pp.travelport.net`) and almost
  certainly the same `TVP-PCC-CORE` header (possibly a hotel-specific access group).

So `HOA`/`HOC`/hotel-sell currently read the local seed on **both** backends not
because there's no API, but because **we never integrated the Stays API**. This
doc scopes that integration. (Cars are different — see *Out of scope*.)

## The Stays v11 endpoint surface (verified from the API explorer)

| Cryptic | Stays v11 endpoint |
|---|---|
| `HOA` availability | `POST /hotel/search/properties/search` then `POST /hotel/availability/catalogofferingshospitality` |
| `HOI` index | `POST /hotel/search/properties` / `GET /hotel/search/properties/{identifier}` |
| `HOC` rate detail | `POST /hotel/availability/catalogofferingshospitality` ✅ wired (`/rules/…buildfromcatalogoffering` is the deeper cancel-policy call, not used yet) |
| `N<rooms>A<rate>` active sell | `POST /hotel/book/reservations/build` ✅ wired — **one-shot CONFIRMED booking, not a workbench** |
| `0HTL…MK/CF-` passive sell | `POST /hotel/book/reservations/passive` ✅ wired — free-form `PropertyAddress`, confirmation via `ReceiptConfirmation/ConfirmationHold` |
| `*<locator>` retrieve | `GET /hotel/book/reservations/{Identifier}` — already mapped via `mapReservation` (`ProductHospitality`) |
| cancel | `PUT /hotel/book/reservations/{id}/canceloffer` |

v12 adds a `SearchComplete` that fuses search+details+availability; v11 (our target)
keeps them separate. Search-by-location body uses `SearchBy` with
`@type: SearchByAirport` + `SearchAirport` + `SearchRadius` + check-in/out + guests.

## Verified request/response schemas (Stays v11.34 OpenAPI)

The full OpenAPI spec is in-tree: **`references/galileo/Travelport-Stays-v11.34-OpenAPI.json`**
(16 paths, 421 schemas; `TripServices Stays 11.34.0`). Fetched 2026-06-14 from
`developer.travelport.com/page-data/shared/oas-apis/stays/@11.34/index.yaml.json`
and unwrapped from the Gatsby page-data envelope — kept in-tree so chunk 2 doesn't
depend on the live SPA docs. Resolve any `$ref` against `components.schemas` there.

The two read-path calls chunk 2 needs, distilled (verified, not guessed):

**Search** — `POST /11/hotel/search/properties/search`. Body =
`PropertiesQuerySearchWrapper`; `PropertiesQuerySearch` requires
`@type` + `CheckInDate` + `CheckOutDate` + `SearchBy` (dates at the ROOT,
not under a stay object — that was the probe's bug):
```json
{ "PropertiesQuerySearch": {
  "@type": "PropertiesQuerySearch",
  "CheckInDate": "2026-07-14", "CheckOutDate": "2026-07-16",
  "SearchBy": { "@type": "SearchByAirport", "SearchAirport": "CDG",
                "SearchRadius": { "value": 25, "unitOfDistance": "Miles" } },
  "RoomStayCandidate": [ { "GuestCounts": { "@type": "GuestCounts",
                "GuestCount": [ { "@type": "GuestCount", "count": 2 } ] } } ]
} }
```
`SearchBy` is a discriminated union: `SearchByAirport` / `SearchByCity` /
`SearchByAddress` / `SearchByGeoLocation`. Response = `PropertiesResponseWrapper`
→ `PropertiesResponse.Property[]` (`PropertyKey` chain/property codes, `name`,
`GeoLocation`, `Rating`, `Image[]`) → maps onto `HotelProperty[]`.

**Availability** — `POST /11/hotel/availability/catalogofferingshospitality`.
Body = `CatalogOfferingsQueryRequestHospitalityWrapper` →
`CatalogOfferingsQueryRequest.CatalogOfferingsRequest` with
`@type: CatalogOfferingsRequestHospitality`, required `StayDates`
(`DateOrDateWindows`) + `HotelSearchCriterion` (carries the property ref from
search). Response = `CatalogOfferingsHospitalityResponseWrapper` →
`CatalogOfferingsHospitalityResponse`, which carries the SAME
`ProductHospitality` / `PriceBreakdownHospitality` structures the multi-content
**retrieve** mapper already handles — so the rate-mapping half is largely done.

**Live status (probe, 2026-06-14):** the verified search body PASSED validation
(400→500) but the search returned **500 INTERNAL SERVER ERROR**. Read: 7K9S has
Stays API access + the body is correct, but likely no hotel *content*
provisioning on the trial tenant (mirrors the air ticketing gate); a lone 500
could also be transient. **Implication:** build + unit-test chunk 2 against this
spec response schema; a live end-to-end with real hotel data is gated on content
provisioning (production/entitled tenant), exactly like live ticketing.

## Integration shape — mirror the Flights wire

The seam already exists; this reuses every piece of the live-Travelport machinery:

1. **`LiveTravelportBackend` methods** (new): `hotelSearch()`, `hotelAvailability()`,
   `bookHotel()` (active), `bookHotelPassive()` (the `0HTL…MK` path),
   `cancelHotelOffer()`. They reuse `tripServicesHeaders()`, `ensureToken()`, the
   single-worker pacing chain, and `TVP_CAPTURE`/`TVP_REPLAY`.
2. **`hospitality-mapper.ts`** (new, or extend `travelport-mapper.ts`): map the
   search/availability responses → `HotelProperty[]` + a `lastHotelAvail`-shaped
   result; the reservation response → `HotelSegment` (the `ProductHospitality`
   half is already written for retrieve).
3. **Dispatch `instanceof` branches** in `handleGalileoHotel` / `handleGalileoAuxSell`
   / `handleGalileoHotelDirectSell`: `if (ctx.backend instanceof LiveTravelportBackend)
   { …await backend.hotelSearch()… } else { …local seed… }` — exactly the pattern
   `handleGalileoSell` uses for air.
4. **Mocked unit tests** for the wiring + a `validate-stays-handler-live` REPL
   verifier that proves the cryptic→REST chain end-to-end against pre-prod.

## Open questions

1. ~~**Does the 7K9S trial tenant have Stays entitlement?**~~ **RESOLVED 2026-06-14
   — YES.** `validate-stays-creds.ts` against pre-prod: OAuth 200, then
   `POST /hotel/search/properties/search` (with `TVP-PCC-CORE: 7K9S_1G`) returned
   **400 VALIDATION**, not 401/403 — the tenant reaches and validates Stays
   requests. The probe also surfaced the top-level request type: the search body
   wraps in a **`PropertiesQuerySearch`** object (run 1 → "REQUIRED TYPE:
   PropertiesQuerySearch OBJECT"; run 2 with the wrapper → "CHECK IN DATE DATA IS
   INVALID", i.e. now validating fields). So live hotel is a **GO**.
2. ~~**Exact request body field shapes**~~ **RESOLVED for search + availability**
   (2026-06-14/15). Search body (`PropertiesQuerySearch`, `CheckInDate`/
   `CheckOutDate` at root) and availability body
   (`CatalogOfferingsQueryRequest` → `[CatalogOfferingsRequestHospitality]` with
   `StayDates{start,end}` + `HotelSearchCriterion.PropertyRequest[].PropertyKey`)
   both verified live (HTTP 200, real DEN data). Still open: the **book** body
   (chunk 3). Do NOT fuzz pre-prod field-by-field (vendor-pacing rule).
3. **Workbench vs direct book** — `/hotel/book/reservations/build` implies a
   workbench like air; confirm whether the active-sell flow needs the build step or
   the direct `POST /reservations` suffices.

## Chunk plan

1. ~~**Probe + entitlement check**~~ **DONE** — `validate-stays-creds.ts`
   (`npm run validate:stays-creds`) confirmed 7K9S is entitled (400 VALIDATION, not
   403) and that the search wrapper is `PropertiesQuerySearch`. Gate passed.
2. **Read path (`HOA`)** — **DONE (search half).** `LiveTravelportBackend.hotelSearch()`
   (verified `PropertiesQuerySearch` body) + `mapHotelSearch` (PropertiesResponse →
   `HotelProperty[]`, spec-derived) + an `instanceof` branch in `handleGalileoHotel`
   so live `HOA` lists real properties (with `LowestAvailableRate`) and caches
   `lastHotelAvail` for sell, exactly like emulated. DDMON→ISO date conversion;
   empty-rate properties render `RQ`. **HOI vs HOA are kept distinct** (real
   Galileo: index vs priced availability): v11 has no dateless city index, so
   both use the search, but HOI sends `returnOnlyAvailablePropertiesInd:false`
   (full directory, rendered with NO rate column) and HOA sends `true`
   (bookable only, rendered with rates). **Codeless-town search:**
   `HOA<dates>/GEO-<lat>,<lng>` (extension) → Stays `SearchByGeoLocation` — the
   only code-free `SearchBy` member. (NOT `SearchByCity`: verified 2026-06-15
   that its `SearchCity` is a 3-letter IATA city code, not a name — pre-prod
   400 "IATA CITY CODE IS MISSING OR INVALID" — and a town like Estes Park has
   no code at all.) Emulated has no geo index → NO HOTELS (live-only). Mocked
   tests: `test/dialects/galileo-live-hotel.test.ts`. **`mapHotelSearch` VERIFIED
   2026-06-15** against a real live DEN search (100 properties; `LowestAvailableRate
   {value,code}` confirmed; 57 closed → no rate → `RQ`) — captured via
   `TVP_STAYS_AIRPORT=DEN TVP_STAYS_OUT=… npm run validate:stays-creds`.
   **`HOC<line>` rate detail — DONE + VERIFIED 2026-06-14.** It's its own REST
   call (`LiveTravelportBackend.hotelAvailability()` →
   `POST /hotel/availability/catalogofferingshospitality`) for the property on
   the cached HOA line, mapped by `mapHotelAvailability` →
   `HotelRateDetail[]` (bookingCode / room description / full-stay total / avg
   nightly / rate category / offerId). Both the REQUEST body
   (`CatalogOfferingsQueryRequest` → `[CatalogOfferingsRequestHospitality]` with
   `StayDates{start,end}` + `HotelSearchCriterion.PropertyRequest[].PropertyKey`)
   and the RESPONSE shape were verified live against a real Westin-DEN capture
   (HTTP 200, 48 offerings) via the probe's opt-in third call
   (`TVP_STAYS_AVAIL=1 TVP_STAYS_AVAIL_OUT=…`). `HOI` stays emulated; emulated
   `HOC` keeps the seed's rate list.
3. **Sell path** — **active book DONE + VERIFIED 2026-06-14.** ⚠️ Key correction:
   `POST /hotel/book/reservations/build` is NOT a workbench — it is a **one-shot
   CONFIRMED booking** (the feasibility probe created real DEN PNR `GZWS3Q` with a
   supplier confirmation + HK status; there is no separate commit step). So the
   live flow is **HOA → HOC → `N<rooms>A<rate>`**, where the sell books the chosen
   HOC rate by its `offerId` immediately. The build requires a **traveler** (the
   BF's first `N.` name) + a **card guarantee** (the `F.` field — the API rejects
   without one: `FORM OF PAYMENT DATA IS INVALID`); deposit-rate offers are
   skipped client-side in favour of `GuaranteeRequired` rates where possible.
   Pieces landed:
   - `LiveTravelportBackend.bookHotel()` → build endpoint, request shape verified
     live (HTTP 200). `mapHotelReservation()` → `{ HotelSegment, locator }`,
     verified against the real `GZWS3Q` response (supplier conf, PNR locator, HK).
   - HOC live caches the rate detail (offerIds) on `wa.lastHotelRateDetail`;
     `sellGalileoHotelLive` sources name + parses the `F.` card (`parseFopCard`)
     and books. Faithful rejections: `NEED RATE DISPLAY` / `NEED NAME` /
     `NEED FORM OF PAYMENT`. Tests mocked from the real capture
     (`test/dialects/galileo-live-hotel.test.ts`) — **no live writes in CI.**
   - Probe gained an opt-in build feasibility call (`TVP_STAYS_BUILD=1`), used
     once to prove entitlement; the stray PNR it created was cancelled via
     `…/canceloffer`.
   - Real-behaviour note: live `N.` still spins up an (unused) air workbench even
     in a hotel-only flow. Harmless; not worth special-casing.

   **Passive book DONE + VERIFIED 2026-06-14.** `0HTL…MK/CF-<conf>` →
   `LiveTravelportBackend.bookHotelPassive()` → `POST /hotel/book/reservations/
   passive` (status MK, PNR `GZWS4M`, cancelled). The body was nailed live,
   field-by-field — non-obvious bits:
   - Offer `@type: "Offer"` (NOT `OfferHospitality`); Product `ProductHospitality`.
   - The property is a **free-form `PropertyAddress`, NOT a GDS `PropertyKey`** —
     a real key makes the host try to reach the supplier → `500 COMMUNICATION
     ERROR` (passive is an *external* booking).
   - The supplier confirmation rides `Receipt(@type ReceiptConfirmation) →
     Confirmation(@type ConfirmationHold) → Locator` — the **concrete** `@type`s
     are required; the abstract `Receipt`/`Confirmation` earn `CONFIRMATION
     NUMBER IS INVALID`.
   - `bookingCode`, `Quantity`, `GuestCounts` (with `ageQualifyingCode`), and a
     `Traveler` are all required (each surfaced as its own 400 while probing).
   New cryptic qualifier **`/CF-<conf>`** carries the external confirmation (the
   live API requires it; the cryptic had no field for it). Faithful rejections:
   `NEED CONFIRMATION - USE /CF-`, `NEED NAME - USE N.`. Active direct-sell
   (`0HTL…HK`) has no catalog offer, so it stays local even on live. Tests mocked
   from the real capture; the probe gained a self-cancelling passive mode
   (`TVP_STAYS_PASSIVE=1`).
4. **Cancel** — **DONE + verified live.** `X<n>` where the target is a hotel
   segment → `LiveTravelportBackend.cancelHotelOffer()` → `PUT /hotel/book/
   reservations/{locator}/canceloffer?offerID=…&supplierLocator=…` (the endpoint
   proven by every probe-PNR cleanup). The retrieve mapper now preserves the
   hotel `Offer.id` onto `HotelSegment.offerId` so a retrieved committed BF can
   be cancelled; `handleGalileoCancel` routes an all-hotel `X<n>` selection to
   `handleGalileoHotelCancel` (live cancel + local remove; emulated just
   removes). Needs a committed BF (locator) + the captured offerId — rejections
   `FINISH OR IGNORE` (uncommitted) / `LIVE OFFER ID MISSING`. **Mixed +
   itinerary closed:** `X<air>.<hotel>` cancels both in one entry and `XI`
   sweeps the hotel too (`cancelGalileoCombined` — hotels via canceloffer, air
   via the existing path; whole selection validated up front so a bad number
   can't half-cancel). The committed air validator is now segment-NUMBER based
   (not count) so interleaved air/hotel numbering works. Tests: emulated +
   mocked-live in `galileo-hotel-car` / `galileo-live-hotel`. Retrieve was
   already done.

## Out of scope

- **Car** — genuinely no published v11 REST *booking* surface. Dug 2026-06-16
  (per user request, starting from the uAPI vehicle page):
  - **v11 JSON REST (our backend's protocol):** the JSON APIs home lists only
    **Flights / Stays / Pay** — no Cars product. The Car booking API is marked
    "**(full release pending)**" everywhere (Multi-Content guide); there's no
    Cars API-reference section, no endpoints list, no schemas. So active/passive
    car *booking* via JSON is NOT wireable today.
  - **Live gateway probe (2026-06-16) confirms it's not just undocumented —
    the route isn't deployed.** POSTing empty bodies to six structurally-likely
    mirrors (`/car|/vehicle|/cars` × `book/reservations`, `search/…`,
    `availability/…`) all returned bare **`404 page not found`**. Contrast: the
    hotel paths return `200`/`400` (routed) with identical headers — so the
    gateway DOES route deployed namespaces; car simply isn't one. (This is the
    "maybe the path's up but the docs aren't" test that *confirmed* Stays; for
    cars it confirms the gap.)
  - **Retrieve already covers the READ side:** multi-content Reservation Retrieve
    returns `ProductVehicle` (ECAR/ACRISS) for active+passive cars — which
    `mapReservationCars` already maps. So a retrieved BF's cars show; only
    creating them via JSON is blocked.
  - **uAPI (XML/SOAP)** HAS full vehicle booking (`VehicleCreateReservationReq`:
    search → rules → create → modify/cancel/retrieve), but it's a different API
    generation — XML not JSON, different endpoint + branch-based auth. Wiring it
    means a whole separate `uAPI` backend, not an extension of `LiveTravelport-
    Backend`. Out of scope unless we add a uAPI transport.

  Net: `CAL` / `0CCR` car-sell stay emulated until the v11 JSON **TripServices
  Car APIs** ship (or we take on a uAPI backend). Unlike Stays — which turned out
  to be a real, GA, dismissed-by-mistake JSON API — the car JSON *booking* gap is
  genuine. See [[dig-before-declaring-platform-gaps]].
- **Live multi-content *retrieve*** — already wired (`mapReservation` maps
  air+hotel+car; `test/backends/multi-content-retrieve.test.ts`).
- **v12 `SearchComplete`** — defer; v11's separate search/availability is enough.
