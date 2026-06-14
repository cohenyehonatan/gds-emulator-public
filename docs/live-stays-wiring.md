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
| `HOC` rates/rules | `POST /hotel/rules/offershospitality/buildfromcatalogoffering` |
| `N<rooms>A<line>` active sell | `POST /hotel/book/reservations` (+ `/hotel/book/reservations/build` workbench) |
| `0HTL…MK` passive sell | `POST /hotel/book/reservations/passive` (+ `/passiveupdate`) |
| `*<locator>` retrieve | `GET /hotel/book/reservations/{Identifier}` — already mapped via `mapReservation` (`ProductHospitality`) |
| cancel | `PUT /hotel/book/reservations/{id}/canceloffer` |

v12 adds a `SearchComplete` that fuses search+details+availability; v11 (our target)
keeps them separate. Search-by-location body uses `SearchBy` with
`@type: SearchByAirport` + `SearchAirport` + `SearchRadius` + check-in/out + guests.

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

## Open questions (resolve before/while chunking)

1. **Does the 7K9S trial tenant have Stays entitlement?** The trial validated *air*
   search; Stays may need a different access group (e.g. a `_HOTEL`/`_HCD` PCC suffix
   on `TVP-PCC-CORE`) or a separate grant. **Resolve first** with a one-shot probe —
   if it 403s, live hotel is blocked on the same trial-tenant gate as production
   ticketing, and stays emulated until a production/entitled tenant exists.
2. **Exact request body shapes** — the use-cases give the search body skeleton
   (`SearchByAirport`); availability/rules/book bodies need a `TVP_CAPTURE` pass or
   the per-endpoint API reference to pin field paths (same bar every mapper meets).
3. **Workbench vs direct book** — `/hotel/book/reservations/build` implies a
   workbench like air; confirm whether the active-sell flow needs the build step or
   the direct `POST /reservations` suffices.

## Chunk plan

1. **Probe + entitlement check** — a `validate-stays-creds.ts` (sibling of
   `validate-travelport-creds.ts`): one `POST /hotel/search/properties/search`
   against pre-prod with `TVP_CAPTURE`. Confirms 7K9S can see Stays and records the
   real response shape. **Gates everything below.**
2. **Read path (`HOA`/`HOC`)** — lowest risk, read-only: live hotel search +
   availability → `lastHotelAvail`. Operators get real hotels; the existing
   reference-sell then books locally (or live in chunk 3).
3. **Sell path** — active book (`N<rooms>A<line>` → `/hotel/book/reservations`) and
   passive book (`0HTL…MK` → `/hotel/book/reservations/passive`).
4. **Cancel** — `X`-family hotel segment → `…/canceloffer`. Retrieve is already done.

## Out of scope

- **Car** — genuinely no published v11 REST surface (developer-docs nav has
  Flights / Stays / Pay only; the Multi-Content guide's "(full release pending)"
  applies here). `CAL`/car-sell stay emulated until a Cars API ships.
- **Live multi-content *retrieve*** — already wired (`mapReservation` maps
  air+hotel+car; `test/backends/multi-content-retrieve.test.ts`).
- **v12 `SearchComplete`** — defer; v11's separate search/availability is enough.
