# Seat Maps — design plan and chunks

**Status:** PRE-DESIGN — modeling decision locked to **Option C** as of
2026-06-07 once the live shape was checked (see below). Chunking still
pending. ROADMAP.md flags this under "remaining for future chunks: seat
maps (SM display)" with the note "needs new seat-map data structure".
This doc unpacks that note.

Updated chunk-by-chunk like ROADMAP.md — flip `[ ]` to `[x]` with a
commit ref when a piece lands.

## What `/seatmaps` actually returns (checked first — 2026-06-07)

Before any modeling decision, the live response shape was sourced from
the v11 GDS reference-payload devkit Postman collection so the model
mirrors live, not the other way around.

**Endpoint:** `POST {baseURL}/{version}/air/search/seat/catalogofferings`
`ancillaries/seatavailabilities`
- Query string: `catalogProductOfferingsIdentifier`, `catalogProductOffer`
  `ingID`, `productIDs` (UUIDs lifted from the prior `A` availability +
  the selected segment's `ProductIdentifier`)
- Headers: standard Bearer + `XAUTH_TRAVELPORT_ACCESSGROUP` (1G or 1V) +
  `Content-Version`
- **Workbench-tied.** The endpoint requires a `CatalogProductOfferingsID`
  UUID, which comes from a prior `A` query — so the SM live path needs
  `wa.lastAvailability.vendorRef.offerId` populated. Same dependency
  the existing FQ live path has. Without prior `A`, fall back to
  `NO AVAILABILITY` (reconstructed wording).

**Request body** (canonical shape):
```json
{
  "CatalogOfferingsQuerySeatAvailability": {
    "SeatAvailabilityOfferings": {
      "@type": "SeatAvailabilityOfferingsBuildFromCatalogProductOfferings",
      "BuildFromCatalogProductOfferingsRequest": {
        "@type": "BuildFromCatalogProductOfferingsRequest",
        "CatalogProductOfferingsIdentifier": {
          "id": "catalogProductOfferings",
          "Identifier": { "value": "<uuid>", "authority": "Travelport" }
        },
        "CatalogProductOfferingSelection": [
          {
            "CatalogProductOfferingIdentifier": { "id": "o1" },
            "ProductIdentifier": [ { "id": "p7" } ]
          }
        ]
      }
    }
  }
}
```

**Response shape** (`CatalogOfferingsAncillaryListResponse`):
- Top-level: `CatalogOfferingsID[]` (one per flight) + `ReferenceList[]`
  (with the actual cabin layout) + `Result.Error[]` envelope.
- Each `CatalogOfferingsID[i]` has:
  - `Flight[]` — carrier, number, equipment, Departure/Arrival
  - `CatalogOffering[].ProductOptions[].Product[]`:
    - `@type: ProductSeatAvailability`
    - `SeatAvailability[]` — **grouped by status**, with a flat seat-label
      list per status:
      ```
      { "seatAvailabilityStatus": "Reserved", "value": ["1A","1B","2A",...] }
      { "seatAvailabilityStatus": "Available", "value": ["1D","1E","1F",...] }
      ```
    - `SeatingChartRef: "seatingChart_1"` — links to ReferenceList
    - `Brand.name`: "SEAT ASSIGNMENT" (free) or other paid-brand name
  - `Price`: per-offering total (zero for free seats)
- `ReferenceList[].SeatingChart[]` — **per-equipment layout**:
  - `Cabin[]` — F/J/Y partitions
    - `name`: "FIRST" / "BUSINESS" / "ECONOMY"
    - `Layout[]` — cabin-level column-position map:
      - `{ startRow, endRow }` — row range owned by this cabin
      - `{ position: ["W"], value: "A" }` — column A is **W**indow
      - `{ position: ["A"], value: "B" }` — column B is **A**isle
      - middle columns omit the `position` (or use a different code)
    - `Row[]` — per-row breakdown
      - `label: "1"`
      - `Space[]` — per-seat:
        - `location: "A"`
        - `Characteristic: ["A","N"]` — Travelport SCC codes (A=Aisle,
          N=likely "next to lavatory" or "no recline" — published table)

**Key consequence:** the response IS Option C (structural model + per-date
availability). The Layout block gives us cabin-level column positions
exactly as our `ColumnSpec { position: 'window'|'aisle'|'middle' }`
shape proposed; `Row[].Space[].Characteristic` lets us override per-seat
for exit rows / bulkheads. We can mirror the Travelport shape almost 1:1
and our mapper becomes trivial — same pattern as the rest of the v11
mapping.

**Decision: Option C is locked in** based on this. The model field names
will mirror Travelport's so the mapper is one-pass.

**Open follow-ups from the live shape** (lift into chunk planning):
- Travelport SCC characteristic codes: full table is published in the
  v11 schema doc. Catalog the relevant codes (A=Aisle, W=Window,
  E=Exit, etc.) into `src/models/seat-map.ts` as an enum or string-union
  so the renderer can label them. Pull the table verbatim before
  chunk 1 starts — same fidelity bar Sabre uses for response wording.
- Status codes seen: `Reserved`, `Available`. Need to enumerate the
  full set (`Blocked`, `Restricted`, `Premium`, `Occupied`?) — likely
  in the same schema doc. Synthesizer in chunk 1 should emit the same
  set so emulated and live render identically.
- `seatAvailabilityStatus` is GROUPED in the response (one entry per
  status with a flat seat-list), NOT per-seat. Our internal model can
  go either way; mirror the live grouping so the mapper is trivial,
  then "flatten" at render time.
- `SeatingChartRef` is a separate ReferenceList entry — same indirection
  pattern as `FlightRef` / `ProductRef` elsewhere. The mapper has to
  walk ReferenceList[] to resolve.
- `Brand.name = "SEAT ASSIGNMENT"` (free) vs other names indicates
  paid seat brands. v1 ignores brand pricing; chunk 8 (deferred) could
  surface "EXTRA LEGROOM +50.00" style display.

## Why this needs its own doc

Every other Amadeus v4 chunk extended existing models (addresses,
seat-request stubs, FF elements) or used already-existing infrastructure
(queues map, PnrStore, tariff). SM doesn't have that. The cryptic family
is small but the supporting data structure is genuinely new, and that
data structure has cross-dialect consequences: Sabre, Galileo, Apollo
all have seat-map verbs that would want to share the same `SeatMap`
shape; LiveTravelportBackend's `/seatmaps` endpoint returns a payload
we'd ideally mirror.

So this isn't "add 5 verbs and 3 tests." It's "pick a seat-map model,
then add 5 verbs and 3 tests once across however many dialects make
sense, and decide whether to wire the live REST surface."

## Cryptic surface to cover

### Amadeus (QRG p.39-40)

| Form | Meaning |
|---|---|
| `SM` | Seatmap for a single-segment itinerary in current PNR |
| `SM 4` | Seatmap for segment 4 |
| `SM LH330/Y/FRAJFK` | For flight + class + route, current date |
| `SM IB123/C/14AUGMADCDG` | For flight + class + specific date + route |
| `SM SK862//28SEPSTOLHR` | Same, all classes |
| `SM BA123/C/14AUGMADCDG/V` | Vertical display |
| `SM BA123/C/14AUGMADCDG/H` | Horizontal display |
| `SM/1` | From availability line (uses cached AN result) |
| `SM/1/Y` | From avail line, specific class |
| `SM/1/2/Y` | From dual-city-pair avail line 1, second flight, Y class |

### Cross-dialect equivalents

Looked up later — Galileo's seatmap cryptic is documented in Smartpoint
Module 2; Sabre's is in the Basic Course or Seat Tools QR. Each dialect
has its own surface, but they all want the same underlying `SeatMap`
model from `src/models/`.

### Live Travelport REST

`LiveTravelportBackend` already has `addFormOfPayment` / `applyPayment` /
etc. for the ticket flow; `/seatmaps` would be the parallel for seats.
GDS reference-payload devkit has a seatmap endpoint sample. Probably
goes under `Optional Pre Commit Requests > Optional Seats` in the
collection. Wiring it follows the same template the rest of the live
verbs use (REST method on backend + mapper + dispatch instanceof
discrimination + mocked test + harness probe).

## Modeling decision tree

This is the load-bearing call. Three options, picking one before any
chunk lands.

### Option A — Exact positions (every seat enumerated)

```ts
interface Seat {
  row: number;            // 1..N
  column: string;         // 'A'|'B'|'C'|'D'|'E'|'F'|'G'|...
  cabin: string;          // 'F'|'J'|'Y'|...
  type: 'standard' | 'window' | 'aisle' | 'middle'
      | 'bulkhead' | 'exit-row' | 'preferred';
  blocked?: boolean;
}
interface SeatMap {
  carrier: string;
  flightNumber: string;
  equipment: string;      // '737', '320', '76W', ...
  seats: Seat[];
}
interface SeatAvailability {
  date: string;           // DDMON
  occupied: Set<string>;  // "12C" style keys
}
```

**Pros:**
- `ST/12C/P2/S5` (chunk 10) can validate that seat 12C exists, is in the
  right cabin, and isn't already occupied — currently ST just stores
  the string verbatim.
- Real vertical/horizontal display content: rows of "WAB...DEF" with
  occupancy markers.
- Live REST seatmap response maps cleanly onto this shape.

**Cons:**
- ~50-200 LOC of seat data per equipment type. Need at least 737/738,
  320/321, 76W/77W, 75W, 7M9 (FI Boeing 757 variants used in the live
  Galileo tests) to cover the existing inventory + a couple of common
  variants. Maintenance burden if equipment list grows.
- Most operators never look at the actual seat data — they just want
  "is something available?"
- Emulated-only complexity: live SeatMap response is the source of
  truth; emulated synthesis is decorative.

### Option B — Summary stats (no individual seats)

```ts
interface SeatMap {
  carrier: string;
  flightNumber: string;
  equipment: string;
  rows: number;
  columns: string[];      // ['A','B','C','D','E','F']
  exitRows: number[];
  cabinClasses: Array<{ cabin: string; rowRange: [number, number] }>;
}
interface SeatAvailability {
  date: string;
  summary: 'OPEN' | 'PARTIAL' | 'FULL';
}
```

**Pros:**
- Tiny — a few dozen lines per equipment type.
- Enough to render "this aircraft has 30 rows, A-F seating, exit rows
  at 12+30" which is what most operator queries need.
- ST validation: "is 12C in range?" answerable from rows + columns.

**Cons:**
- ST validation is rough — can't say "12C is a window" without column
  semantics, can't say "12C is occupied" without per-seat tracking.
- Display is mostly synthetic decoration.
- Live REST response doesn't map cleanly — we'd be downgrading detail.

### Option C — Structural model + synthetic availability (recommended)

Real seat structure (rows × columns + exit rows + cabin partitions +
column types so we can label window/aisle), synthetic per-date
availability ("open" / "preferred-cost" / "blocked").

```ts
interface ColumnSpec {
  letter: string;
  position: 'window' | 'aisle' | 'middle';
}
interface SeatMap {
  carrier: string;
  flightNumber: string;
  equipment: string;
  cabins: Array<{
    code: string;        // 'F' | 'J' | 'Y' | 'W' (prem econ)
    fromRow: number;
    toRow: number;
    columns: ColumnSpec[];
    exitRows: number[];
  }>;
}
// No SeatAvailability persistence — synthesize per query from a
// seed (e.g. hash of locator+date) so the same query returns the
// same answer twice but different segments get different layouts.
```

**Pros:**
- ST validation works: `ST/12C/S5` resolves to "row 12, column C, which
  is an aisle seat in cabin Y" — can reject "ST/12W" (no column W).
- Display has real content: vertical/horizontal layouts with cabin
  boundaries, exit rows, aisle marker.
- Live REST `/seatmaps` response maps onto this without loss.
- Avoids the bookkeeping of tracking real occupancy across PNRs and
  cancels — synthetic availability sidesteps the "did we already book
  this seat?" question that none of the other emulated work touches.

**Cons:**
- More structural data per equipment than Option B; less than A.
- The synthesizer for availability needs a deterministic seed if we
  want the same SM query to return the same answer twice (a hash of
  carrier+flight+date+seat is sufficient).

### Decision: LOCKED to Option C (2026-06-07)

Driver: the live `/seatmaps` response shape IS Option C (see "What
`/seatmaps` actually returns" above). The Travelport response gives
us a per-cabin `Layout[]` block with column-position labels and a
`Row[].Space[]` block with per-seat characteristics — exactly the
shape we'd have designed if we'd guessed cold. Mirroring the live
shape means:

- Model field names match Travelport's (`Cabin`, `Layout`, `Row`,
  `Space`, `Characteristic`) so the v11 mapper is one-pass with no
  reshape.
- Per-equipment cabin layouts can be seeded from real responses
  captured via `TVP_CAPTURE` once the live wire lands — no need to
  hand-author every aircraft type from scratch.
- The "does column-position labeling differ by aircraft" open
  question is answered: yes, and the live response includes it
  per-cabin per-aircraft, so each equipment type does need its
  own representative seed (chunk 1 picks ~5-6 common equipments).

Synthesized availability for emulated stays — we don't track real
seat occupancy across PNRs. Deterministic seed from
hash(carrier+flight+date+seat) so the same query returns the same
answer twice.

## Chunks

Each chunk = one self-contained commit with code + tests. Mirrors the
v4 chunking pattern from ROADMAP.md.

### Chunk 1 — `SeatMap` model + Inventory.seatMapFor seed

- [ ] Create `src/models/seat-map.ts` with the agreed shape (see
      decision above).
- [ ] Seed `Inventory` with representative seatmaps for the equipment
      types currently in `SCHEDULE` (737, 738, 320, 752, 73J, 332, 339,
      321, 787, 789, 32N, 75W, 7M9, 7M8). Each gets a `cabins[]` entry
      with cabin code, row range, columns with position labels, and
      exit rows.
- [ ] `Inventory.seatMapFor(carrier, flightNumber, equipment?)` returns
      the SeatMap or undefined.
- [ ] Helper `synthesizeAvailability(seatMap, locator, date)` returns
      a deterministic `{ occupied: Set<string> }` per the chosen
      synthesizer scheme.
- [ ] Unit tests in `test/store/seat-map.test.ts` covering: lookup,
      cabin boundaries, exit-row detection, column-position labeling,
      synthesizer determinism (same seed → same answer twice).

### Chunk 2 — Amadeus `SM <segment>` (current PNR + ST validation)

- [ ] `SM <n>` parses segment number, looks up the segment, calls
      `Inventory.seatMapFor(carrier, flightNumber, equipment)`, calls
      `synthesizeAvailability` keyed on `(locator, date)`.
- [ ] Render vertical (default) and `/V` / `/H` layout variants. QRG
      doesn't pin the literal rendering — flag the wording as
      reconstructed.
- [ ] ST (chunk 10) gains seat-existence validation: when an ST/<seat>
      entry references a seat that doesn't exist in the segment's
      seatmap (e.g. row 99 on a 30-row 320), reject with
      `INVALID SEAT`. Don't validate against availability yet — keep
      the validation about static seatmap structure.
- [ ] Tests: SM happy path, SM no-segment, SM on segment with no
      schedule, ST/12C accepted, ST/12Z rejected, ST/99A rejected.

### Chunk 3 — Amadeus direct-access SM (no current PNR)

- [ ] `SM <carrier><flight>/<class>/[<date>]<orig><dest>` — direct
      query without an itinerary. Looks up by carrier+flight via
      `Inventory.scheduleFor`.
- [ ] `SM/<line>` and `SM/<line>/<class>` — from cached availability
      (uses `wa.lastAvailability.lines`).
- [ ] Tests: direct happy path, unknown carrier, unknown class for
      cabin lookup, SM/<line> with no prior AN.

### Chunk 4 — Sabre seatmap parity

- [ ] Look up Sabre's seatmap verb in the Basic Course / Seat Tools QR.
- [ ] Implement in `dialects/sabre/` using the same `Inventory.seatMapFor`
      + `synthesizeAvailability` helpers, with Sabre's response format.
- [ ] Tests in `test/dialects/sabre-seatmap.test.ts`.

### Chunk 5 — Galileo seatmap parity

- [ ] Look up Galileo's seatmap verb in Smartpoint Module 2.
- [ ] Implement in `dialects/galileo/dispatch.ts`.
- [ ] Apollo inherits via the translator (verify no translation needed
      first; the SM family might pass through unchanged).
- [ ] Tests + harness probe in `validate-galileo-diff-oracle.ts`.

### Chunk 6 — Live Travelport `/seatmaps` REST wire

- [x] **Find the canonical seatmap request body** in the GDS reference-
      payload devkit. **Done 2026-06-07** — endpoint, body, response
      shape captured in the "What /seatmaps actually returns" section
      above. Devkit file:
      `~/.claude/jobs/2620983b/tmp/devkit/v11_GDS_ReferencePayload_DevKit/`
      `V11 GDS Air Reference Payload Path v25.11.2.json` (search for
      `"name": "Search Seat Maps"`).
- [ ] Add `searchSeatAvailabilities(opts)` method to
      `LiveTravelportBackend`. Takes a `CatalogProductOfferings`
      identifier (UUID from prior `A`) + selected offer/product IDs.
      URL: `POST /<version>/air/search/seat/catalogofferings`
      `ancillaries/seatavailabilities`. Headers: standard 1G/1V
      access-group + Content-Version. Body: as in the canonical shape
      above. Same pacing + capture/replay semantics as the rest of the
      live wire.
- [ ] Add mapper `mapSeatAvailabilities(response)` in
      `src/backends/travelport-mapper.ts`:
      - Walk `CatalogOfferingsID[].CatalogOffering[].ProductOptions[]`
        `.Product[].SeatAvailability[]` for the status-grouped seat lists
      - Resolve `SeatingChartRef` via `ReferenceList[]` walk (same
        indirection pattern as FlightRef / ProductRef)
      - Convert Travelport's `Layout[]` + `Row[].Space[]` to our
        `SeatMap.Cabin[]` shape (chunk 1 settles the exact field names)
- [ ] Galileo's seatmap handler dispatches live with `instanceof`
      discrimination (same pattern as the rest of the live wire).
- [ ] Mocked test against a fixture extracted from the devkit sample
      response (verbatim — same pattern as the existing FQ-response
      fixtures).
- [ ] Diff-oracle probe `SM` (after segment built) — should be
      IDENTICAL between emulated and live once the synthesizer matches
      live's status distribution closely enough; flag STRUCTURAL
      expected otherwise.
- [ ] Manual run against pre-prod with `TVP_DEBUG_DUMP=1` to confirm
      the canonical body matches what 7K9S actually accepts (the same
      pre-prod gap pattern other live verbs have hit).

### Chunk 7 — Scrolling + view variants

- [ ] Amadeus `SM` family supports vertical (`/V`), horizontal (`/H`),
      hide-legend (`/NL`), show-legend (`/L`), MD/MU/MB/MT scrolling
      while a seatmap is displayed.
- [ ] State on WorkArea: cache the last-displayed seatmap so scrolling
      verbs operate on it. Mirrors the availability-cache pattern.

### Chunk 8 — ST availability validation (optional, after chunk 1)

- [ ] When `ST/<seat>` references an occupied seat (per the synthesizer),
      reject with `SEAT NOT AVAILABLE`.
- [ ] When `ST/<seat>` references an exit-row seat without the right
      passenger profile (deferred — needs pax type modeling), warn but
      accept.
- [ ] Reserve the chunk: only meaningful if synthesized availability
      proves useful. May get folded into chunk 2 if the validation feels
      cheap there.

## Open questions

- [x] **Aircraft column patterns:** each equipment type needs its own
      column spec. Resolved 2026-06-07 by the live shape — Travelport
      returns per-cabin per-equipment `Layout[]` blocks; we mirror that
      structure. Pick 5-6 common equipments to seed (chunk 1).
- [x] **Does the live `/seatmaps` endpoint need an active workbench?**
      Yes — workbench-tied. Requires `catalogProductOfferingsIdentifier`
      (= UUID from prior `A` query, lives on
      `wa.lastAvailability.vendorRef.offerId`). Resolved 2026-06-07.
- [ ] Should `SeatMap` go on `Pnr` (so the cached map round-trips through
      JsonFilePnrStore) or stay on `WorkArea` (transient)? Lean: WorkArea
      — the map belongs to the query, not the PNR.
- [ ] Sabre's seatmap verb — `4G*<line>` / `SA*<flight>`? — needs source
      verification before chunk 4.
- [ ] Galileo's seatmap verb in Smartpoint Module 2 — does it match
      Amadeus's `SM` family or use a different prefix?
- [ ] Apollo: the Comparison Guide should say whether SM is the same
      in 1V. If yes, no translator change needed; if no, add a 4th
      translator pattern.
- [ ] Travelport Seat Characteristic Codes (SCC) — full table. The
      response uses 1-letter codes (`A`/`W`/`N`/`E`/...). Catalog the
      full set into `src/models/seat-map.ts` before chunk 1 so the
      renderer can label them consistently.
- [ ] Full set of `seatAvailabilityStatus` values. Sample showed
      `Reserved` and `Available`; need to enumerate (`Blocked`,
      `Premium`, `Restricted`, `Occupied`?) so the synthesizer + the
      renderer share a closed set.
- [ ] Devkit Postman variable name confusion: collection sets
      `SeatmapsRefDevKit` but the request also uses
      `catalogProductOfferingsIdentifierValueDevKit` /
      `catalogProductOfferingIdDevKit` / `productOfferingIdentifierDevKit`
      as query params. Confirm during chunk 6 which one of those maps
      to the UUID we already have at `vendorRef.offerId`.

## Tie-ins to existing code

| Existing | How SM touches it |
|---|---|
| `src/models/seat-request.ts` (ST/SX chunk 10) | ST already stores seat code + segment + NameRef. Chunk 2 adds existence-validation against the seatmap. |
| `src/store/inventory.ts` (`SCHEDULE`) | Equipment column on each `ScheduledFlight` (e.g. '320', '76W') becomes the lookup key for `seatMapFor`. |
| `src/backends/live-travelport-backend.ts` | Adds `getSeatMap` method following the same pacing/capture/replay pattern. |
| `validate-galileo-diff-oracle.ts` | Add SM probes once Galileo's seatmap verb is wired both emulated + live. |
| `JsonFilePnrStore` | Probably untouched — seatmaps don't persist on the PNR (see open question above). |

## Out of scope (defer past v4)

- Real per-flight occupancy tracking (would need a `SeatAssignment`
  store keyed on flight+date and cross-PNR coordination — large
  cross-cutting change).
- Premium-seat pricing (chargeable seats with fare amounts).
- Aircraft-specific lavatory / galley positioning beyond what's in the
  structural model.
- Equipment swaps (a flight changes from 320 to 321 mid-cycle — out of
  scope for the emulator; would matter for a real airline system).
- Group seat blocks / bassinet positioning / unaccompanied-minor seating
  rules.

## Cross-references

- ROADMAP.md "Remaining for future chunks" — SM line lives there as the
  high-level item; this doc is the unpacked decision + chunk list.
- CLAUDE.md "Cross-dialect models" — `SeatMap` joins `AddressElement`
  / `SeatRequest` / `FrequentFlyer` when chunk 1 lands.
- QRG p.39-40 (Amadeus) for the cryptic surface.
- Smartpoint Module 2 (Galileo) — to look up in chunk 5.
- Sabre Basic Course / Seat Tools QR — to look up in chunk 4.
- v11 GDS reference-payload devkit JSON — for the live REST shape in
  chunk 6.
