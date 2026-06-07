# Seat Maps — design plan and chunks

**Status:** CHUNK-2 LANDED — PRE-CHUNK-3 (2026-06-07). Chunks 0+1+2
all closed: SCC + status enums sourced (chunk 0); SeatMap model +
10-equipment seed + synthesizer landed (chunk 1); Amadeus SM
dispatch + WorkArea cache + ST existence-validation landed (chunk 2,
this commit). 1034 tests pass. Chunk 3 (Amadeus direct-access SM
forms `SM <flight>/<class>/<route>` + `SM/<line>` from cached
availability) is the next code-bearing chunk.

ROADMAP.md flags this under "remaining for future chunks: seat maps (SM
display)" with the note "needs new seat-map data structure". This doc
unpacks that note.

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

**Open follow-ups from the live shape** (SCC + status enums promoted
to chunk 0 above; remaining shape-level notes captured here):
- `seatAvailabilityStatus` is GROUPED in the response (one entry per
  status with a flat seat-list), NOT per-seat. Our internal model can
  go either way; mirror the live grouping so the mapper is trivial,
  then "flatten" at render time.
- `SeatingChartRef` is a separate ReferenceList entry — same indirection
  pattern as `FlightRef` / `ProductRef` elsewhere. String-keyed lookup
  (not array index); see chunk 6 mapper bullet for the full gotcha.
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
  per-cabin per-aircraft, so each equipment type needs its own
  seed. Chunk 1 seeds all 14 equipment types currently in
  `SCHEDULE` — see chunk 0's resolved-question block for the
  rationale (avoid `undefined` returns from `seatMapFor` in
  cross-dialect tests later).

Synthesized availability for emulated stays — we don't track real
seat occupancy across PNRs. Deterministic seed from
hash(carrier+flight+date+seat) so the same query returns the same
answer twice.

## Chunks

Each chunk = one self-contained commit with code + tests. Mirrors the
v4 chunking pattern from ROADMAP.md.

### Chunk 0 — Prerequisite source lookups (HARD BLOCKER for chunk 1)

The two enums below are load-bearing for both the synthesizer (chunk 1)
and the renderer (chunk 2). Without closed sets matching what live
returns, the diff-oracle in chunk 6 will flag false STRUCTURALs
everywhere and the renderer will guess at code semantics (`N` = "no
recline"? "next to lavatory"?). Pulled forward from chunk 6 follow-ups
because chunk 1 can't ship safely without them.

**Sourcing path (where to look first)** — preferred order, fallback at
each step:

1. **Travelport v11 OpenAPI / JSON schema.** The canonical source for
   any enum. Travelport publishes per-version schemas; check
   `support.travelport.com/PSC/` for the swagger / OpenAPI archive,
   and `references/galileo/Travelport-JSON-Air-v11-API-Spec.md`'s
   "Reference docs" links. Most likely path: a downloadable
   `.yaml` / `.json` with every `enum` listed explicitly. Grep for
   `SeatCharacteristic`, `seatAvailabilityStatus`, `SccCode`.
2. **Webhelp narrative** at
   `support.travelport.com/webhelp/TripServices/#Air/Seats/Seatsv9.htm`
   (URL from the devkit's endpoint description). Webhelp pages often
   describe response shapes inline; whether they list the full enum
   varies. Worth a single fetch as a backup to the schema dive.
3. **Capture-then-extract from pre-prod.** Run
   `validate-live-galileo:capture` for several flights spanning
   different equipment + carriers (UA 777, BA 38M, LH 320, AA 76W) and
   accumulate the observed set. Less complete than the schema but
   gives ground truth for codes that actually appear; useful as a
   sanity check on what the schema says.
4. **ATPCO industry-standard SSR/SCC list** as a reality check —
   Travelport's codes mostly align with the airline-industry standard
   table. If a code appears in the live response that's not in
   Travelport's schema (rare but possible — vendor extensions), ATPCO
   usually has the definition.

Whoever picks up chunk 0 should start at step 1; the four-step list is
documented so they don't start from zero.

- [x] **Travelport Seat Characteristic Code (SCC) table — full enum.**
      Sourced 2026-06-07 — the canonical PADIS 9825 codeset (~115 codes)
      is captured verbatim in `references/iata-padis-9825-seat-codes.md`.
      Travelport's API ref confirms SCC = PADIS 9825; the codes are
      industry-standard across all GDS and direct-connect NDC. Chunk 1
      lands the `SccCode` union + `SCC_LABELS` map by importing from
      that reference. The reference also pre-curates a renderer-glyph
      mapping for the chunk-2 anchor (position markers W/A/M/K/E/H +
      no-seat positions D/LA/GN/SO/ST/TA/CL/KN/8).
- [x] **`seatAvailabilityStatus` full enum.** Sourced 2026-06-07 from
      the Travelport v11 API ref — 5 values total: `Available`,
      `Reserved`, `Blocked`, `NoSeat`, `Unavailable`. Definitions
      verbatim in `references/iata-padis-9825-seat-codes.md`. Devkit
      sample only showed 2 (Available, Reserved); the other 3 will
      surface as live captures expand. Chunk 1 lands the union and the
      synthesizer emits a realistic mix (~70% Available, ~20% Reserved,
      ~5% Blocked, ~5% NoSeat for galley/lavatory positions in the
      cabin row layout).

**Default-fallback policy if a code/status appears that wasn't in the
sourced enum:** keep it literal in the model (`status: string` accepts
anything; SCC list is `string[]`), but warn at the renderer + log to
diff-oracle output so the calibration loop surfaces it. Better to fail
explicit than to silently render wrong.

**Closed-output / open-input asymmetry — intentional.** The model
fields stay open (`status: string`) so live responses with vendor-
specific extensions don't break parsing. The synthesizer in chunk 1
is typed to the closed `SeatAvailabilityStatus` union so a typo in
the emulated emit path (`Avaliable` instead of `Available`) is caught
at typecheck. Same for SCC: model holds `string[]`, synthesizer emits
`SccCode[]`. The asymmetry is by design — live input is open, emulated
output is closed.

**Decision: `SeatMap` lives on `WorkArea`, not `Pnr`.** Locked
2026-06-07. A seatmap is *query state* tied to "the last segment I
asked about" — not booking state. Three reasons:
1. The map regenerates per query (different equipment per segment;
   `RT<locator>` doesn't restore a seatmap, only the PNR).
2. `JsonFilePnrStore` round-trip cost is unjustified — nothing on the
   PNR references the map by content; ST seat-requests reference seats
   by label which validates against a fresh fetch.
3. Chunk 7 (scrolling MD/MU/MB/MT on a displayed map) needs the cache
   on WorkArea anyway — same pattern as `wa.lastAvailability`.

Concrete: add `lastSeatMap?: SeatMap` to WorkArea, cleared on
`reset()` and on `SM` of a different segment. This is settled before
chunk 2 to prevent chunk 7 from having to undo a Pnr choice.

### Chunk 1 — `SeatMap` model + Inventory.seatMapFor seed ✅

Landed in commit (this commit).

- [x] **Created `src/models/seat-map.ts`** mirroring Travelport's
      Cabin/Layout/Row/Space hierarchy. Closed unions `SccCode`
      (~115 PADIS values) + `SeatAvailabilityStatus` (5 values) for
      typed emits; open `string` / `string[]` on the model fields
      themselves for vendor-extension tolerance. `SCC_LABELS` curated
      for the chunk-2 renderer (~25 codes most relevant to display);
      `STATUS_GLYPHS` maps the 5 statuses to render characters.
- [x] **Seeded `Inventory` with 10 equipment layouts** in
      `src/store/seat-map-seed.ts`: 320, 32A, 32B, 738, 739, 7M9, 752,
      75W, 76W, 777. **The doc previously said 14 equipment types from
      an inaccurate count** — actual `SCHEDULE` has 10 unique codes,
      and chunk 1 seeds all of them. `makeCabin(name, fromRow, toRow,
      pattern, exitRows)` helper keeps each layout to ~3 lines per
      cabin. Patterns supported: F22 (2-2 first), Y33 (3-3 narrow-body
      Y), J222 (2-2-2 twin-aisle business), Y232 (2-3-2 twin-aisle Y),
      Y333 (3-3-3 wide-body Y). Bulkhead-row K, exit-row E auto-
      applied per row position.
- [x] **`Inventory.seatMapFor(carrier, flightNumber, equipment?)`** —
      look up by carrier+flight (via schedule), or by explicit equipment
      override. Returns SeatMap or undefined.
- [x] **`synthesizeAvailability(seatMap, locator, date)`** — DJB2
      hash-keyed deterministic synthesizer. Returns
      `SeatAvailabilityList[]` (status-grouped, mirroring live shape).
      Distribution ~70% Available, ~20% Reserved, ~5% Blocked, ~5%
      NoSeat. Seats with structural no-seat SCCs (LA / GN / SO / ST /
      TA / CL / KN / D / EX / `8`) bypass the hash and always return
      NoSeat — position-driven, not chance.
- [x] **21 tests in `test/store/seat-map.test.ts`** covering: every
      SCHEDULE equipment has a seat map, unseeded equipment returns
      undefined, equipment override beats schedule, cabin/row/layout
      structural invariants (Layout starts with row-range; column
      positions in closed {W,A,C,M} set; row labels match Layout
      bounds; bulkhead K on cabin-first row; exit-row E auto-applied),
      seat labeling (windows + aisles for 738 row 5), synthesizer
      determinism (same input → same output, different locator/date
      → different output), full-coverage (every seat appears exactly
      once), closed-status emit, distribution roughly matches the
      70/20/5/5 mix, no-seat SCC always returns NoSeat regardless of
      hash. 1022 total tests pass (+21).

### Chunk 2 — Amadeus `SM <segment>` (current PNR + ST validation) ✅

Landed in commit (this commit).

- [x] `SM <n>` parses segment number, looks up the segment, calls
      `Inventory.seatMapFor(carrier, flightNumber, equipment)`, calls
      `synthesizeAvailability` keyed on `(pnr.locator ?? 'PENDING', date)`.
- [x] Render vertical (default) and `/V` / `/H` layout variants in
      `src/dialects/amadeus/seat-map-render.ts`. Position SCC override
      tweaked from the design-doc anchor: K (bulkhead) dropped from
      per-cell rendering because the cabin-code prefix on the left
      margin already marks the boundary — per-cell K was visual noise
      without information. Final priority: E (exit) > W (window) > A
      (aisle) > M (middle) > H (handicapped) > status glyph. Renderer
      output matches the doc anchor for 32A / 738 / 777 layouts.

      **Render anchor (concrete target so chunk 7 has something to
      scroll against):**

      ```
       SM 1 — UA2430 15JUL DEN-ORD — 777
            A  B    D  E  F  G    K  L
       F   1.W  .    .  .  .  .    .  W
       F   2.W  X    .  X  .  X    X  W
       J   3.W  .    A  .  .  A    .  W
       J   4.W  .    X  X  X  X    .  W
       --- EXIT ROW ---
       Y   5.W  .    .  .  .  .    .  W
       Y   6.W  X    .  .  .  X    .  W
       ...
       LEGEND: . avail  X reserved  * premium  - blocked
               W window  A aisle  E exit  B bulkhead
      ```

      Notes for the renderer:
      - One row per `Row[]` entry. Spaces correspond to `Space[]`.
      - Column header drawn from the cabin's `Layout[]` block,
        gapped by aisle position.
      - Left-of-row label: cabin code (F/J/W/Y), **shown only at the
        cabin boundary row, blank for subsequent rows in the same
        cabin**. Matches real Amadeus SM output convention; a 777 with
        30+ Y rows shouldn't have `Y Y Y Y...` running down the left
        margin — visual noise without information.
      - Per-seat character is `STATUS_GLYPHS[status]` from chunk 0's
        status enum; SCC overrides (window/aisle/exit/bulkhead) take
        precedence when the seat has both an availability status
        AND a structural characteristic — show the characteristic.
      - Exit-row dividers between cabin rows that contain the exit
        Characteristic.

      `/V` (vertical, default) renders as above. `/H` (horizontal)
      transposes — rows along the X axis, columns along Y. Chunk 7's
      MD/MU/MB/MT scrolling navigates within this rendered frame.

- [x] ST seat-existence validation: when an `ST/<seat>/S<n>` entry
      references a seat that doesn't exist in segment n's seatmap
      (row out of range or column not in layout), reject with
      `INVALID SEAT`. Preferences (NSSA / WB / etc. — anything not
      matching `\d{1,3}[A-Z]`) skip validation; bare ST without /S
      also skips (no segment to validate against). Availability
      validation (occupied seats) remains chunk 8.
- [x] **WorkArea cache:** `wa.lastSeatMap = { segment, map }` stores
      the displayed seatmap so chunk 7 scrolling can reuse it without
      re-synthesizing. Cleared on `reset()` (IG/E). Accessor pair
      added to WorkArea forwarding the slot field.
- [x] 12 tests in `test/dialects/amadeus-dialect.test.ts`:
      - NO ITINERARY when no segments
      - SEGMENT NOT IN ITINERARY when segment number out of range
      - Happy path renders header + cabin code + legend
      - Cache populated correctly
      - Deterministic across two calls (same input → same output)
      - /H transposes (different from default /V)
      - reset() (IG) clears the cache
      - ST/12C/S1 accepted (valid seat)
      - ST/99A/S1 rejected (row out of range)
      - ST/12Z/S1 rejected (column not in layout)
      - ST/NSSA/S1 + ST/WB/S1 accepted (preferences bypass validation)
      - ST/99A (no /S<n>) accepted (no segment to validate against)

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
      - Resolve `SeatingChartRef` via `ReferenceList[]` walk. **String-
        keyed lookup, not array index** — `SeatingChartRef:
        "seatingChart_1"` must match against
        `ReferenceList[i].SeatingChart[j].id`. Don't assume position 0.
        Validate the ref value resolved to something non-null and warn
        if not; the FlightRef / ProductRef helpers in the existing
        mapper follow the same shape and you can copy that pattern
        verbatim. Looks trivial; takes 45 minutes when the key doesn't
        match and you're staring at `undefined`.
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

### Chunk 8 — ST availability validation

- [ ] When `ST/<seat>` references an occupied seat (per the synthesizer
      from chunk 1), reject with `SEAT NOT AVAILABLE`.
- [ ] When `ST/<seat>` references an exit-row seat without the right
      passenger profile (deferred — needs pax type modeling), warn but
      accept.
- [ ] **Stays a separate chunk, not folded into chunk 2.** Chunk 2 is
      already doing model + renderer + ST existence-validation + tests;
      adding availability validation on top would make the commit
      message dishonest about scope. Even if the actual implementation
      is 20 lines, the chunking discipline is worth more than the line
      count — separate commits keep history grep-able by feature
      ("ST seat-existence" vs "ST availability") and let chunk 6's live
      wire land between them without bundling.

## Open questions

- [x] **Aircraft column patterns:** each equipment type needs its own
      column spec. Resolved 2026-06-07 by the live shape — Travelport
      returns per-cabin per-equipment `Layout[]` blocks; we mirror that
      structure. **Seed all 14 equipment types currently in `SCHEDULE`**
      (737, 738, 320, 752, 73J, 332, 339, 321, 787, 789, 32N, 75W, 7M9,
      7M8) — chunk 1 covers it. Structural data per equipment is ~15-20
      lines (cabin partitions + column-position map + exit rows); the
      total seed is ~250 lines. Worth it to avoid `seatMapFor` returning
      `undefined` mid-test in chunk 4/5 when a Galileo or Sabre test
      hits a 75W. The earlier "5-6 common" sentence was wrong; corrected
      to "all 14" so chunk 0 and chunk 1 don't disagree.
- [x] **Does the live `/seatmaps` endpoint need an active workbench?**
      Yes — workbench-tied. Requires `catalogProductOfferingsIdentifier`
      (= UUID from prior `A` query, lives on
      `wa.lastAvailability.vendorRef.offerId`). Resolved 2026-06-07.
- [x] **Should `SeatMap` go on `Pnr` or `WorkArea`?** WorkArea —
      resolved in chunk 0 (see decision block there). Locked
      2026-06-07 so chunk 2 can wire the cache without chunk 7 having
      to undo it.
- [x] **Travelport Seat Characteristic Codes (SCC) — full table.**
      Promoted to chunk 0 (HARD BLOCKER). Moved out of follow-ups
      because chunk 1's synthesizer + chunk 2's renderer both need
      the closed set before they can ship.
- [x] **Full set of `seatAvailabilityStatus` values.** Promoted to
      chunk 0 (HARD BLOCKER). Same reason.
- [ ] Sabre's seatmap verb — `4G*<line>` / `SA*<flight>`? — needs source
      verification before chunk 4.
- [ ] Galileo's seatmap verb in Smartpoint Module 2 — does it match
      Amadeus's `SM` family or use a different prefix?
- [ ] Apollo: the Comparison Guide should say whether SM is the same
      in 1V. If yes, no translator change needed; if no, add a 4th
      translator pattern.
- [ ] Devkit Postman variable name confusion: collection sets
      `SeatmapsRefDevKit` but the request also uses
      `catalogProductOfferingsIdentifierValueDevKit` /
      `catalogProductOfferingIdDevKit` / `productOfferingIdentifierDevKit`
      as query params. 10-minute clarification pass before chunk 6's
      pre-prod manual run — not during, so the 401-debugging path
      isn't where this surfaces. Resolve by reading the devkit's
      collection-variables block + cross-checking the request URL
      construction.

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
