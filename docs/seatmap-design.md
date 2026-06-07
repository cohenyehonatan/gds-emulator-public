# Seat Maps — design plan and chunks

**Status:** PRE-DESIGN. Modeling decision pending before chunking starts.
ROADMAP.md flags this under "remaining for future chunks: seat maps (SM
display)" with the note "needs new seat-map data structure". This doc
unpacks that note.

Updated chunk-by-chunk like ROADMAP.md — flip `[ ]` to `[x]` with a
commit ref when a piece lands.

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

### Decision (TBD)

Locked-in choice gets written here before chunk 1 starts. Current lean:
**Option C** — structural model with synthetic availability. Open
question: does the column-position labeling (`window`/`aisle`/`middle`)
need to differ by aircraft (e.g. 2-4-2 vs 3-3 vs 3-4-3)? Probably yes,
which means each equipment type needs a representative seat-row pattern.

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

- [ ] Find the canonical seatmap request body in the GDS reference-
      payload devkit (`v11_GDS_ReferencePayload_DevKit/...json`),
      probably under "Optional Pre Commit Requests > Optional Seats".
- [ ] Add `getSeatMap(workbenchId, opts)` method to
      `LiveTravelportBackend`.
- [ ] Add mapper `mapSeatMap(response)` in
      `src/backends/travelport-mapper.ts` that converts the REST
      payload to our `SeatMap` shape.
- [ ] Galileo's seatmap handler dispatches live with `instanceof`
      discrimination (same pattern as the rest of the live wire).
- [ ] Mocked test + diff-oracle probe + manual run against pre-prod
      with `TVP_DEBUG_DUMP=1` to confirm the canonical body matches.

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

- [ ] Aircraft column patterns: does each equipment type need its own
      column spec, or can we group (narrow-body 3-3, twin-aisle 2-4-2,
      etc.) and label?
- [ ] Should `SeatMap` go on `Pnr` (so the cached map round-trips through
      JsonFilePnrStore) or stay on `WorkArea` (transient)? Lean: WorkArea
      — the map belongs to the query, not the PNR.
- [ ] Sabre's seatmap verb — `4G*<line>` / `SA*<flight>`? — needs source
      verification before chunk 4.
- [ ] Galileo's seatmap verb in Smartpoint Module 2 — does it match
      Amadeus's `SM` family or use a different prefix?
- [ ] Does the live `/seatmaps` endpoint need an active workbench, or
      can it be queried standalone (anonymous)? Affects whether the live
      handler requires `wa.liveWorkbenchId`.
- [ ] Apollo: the Comparison Guide should say whether SM is the same
      in 1V. If yes, no translator change needed; if no, add a 4th
      translator pattern.

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
