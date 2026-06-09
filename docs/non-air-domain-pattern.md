# Non-air domain pattern

Recipe for adding a new bookable non-air domain (hotel, car, rail,
cruise, insurance, tour, etc.) to the emulator. Distilled from v4
chunks 22 (hotel) and 23 (car) — see commits `20d049c` and `932cd28`
for the worked examples this pattern was extracted from.

This is a structural template, not a strict contract. Each domain
will have its own quirks (rail has timetables similar to air, cruise
has multi-day itineraries, insurance has no city/segment). Use the
seven steps as a sequencing aid; deviate where the domain demands it.

## When this pattern fits

A domain is "non-air" in our sense when:

- It has an **availability display** verb that lists offerings in a
  given location/time.
- It has a **sell** verb that books one offering from the list into
  the PNR by line number.
- It has a **cancel** verb that removes a sold offering by segment
  number.
- The booked offering becomes a **segment** on the PNR alongside
  AirSegment, with a `segmentNumber` so cross-domain displays can
  reference it uniformly.

Domains that don't fit this shape (e.g. ancillary services that
attach to existing segments, document output that derives from the
PNR rather than booking new state) follow different patterns — see
chunk 21 (document output) for one such.

## The seven steps

For each step, the file paths are the conventional location. The
specific signatures are exemplary — copy what fits, change shape
where the domain calls for it.

### 1. Model file — `src/models/<domain>.ts`

Two interfaces minimum:

- `<X>Property` (or `<X>Rental`, `<X>Offer`) — what an availability
  display item carries. Includes whatever fields the renderer needs
  to surface in the per-line summary plus enough identifying data
  for the sell verb to reconstruct.
- `<X>Segment` — what a sold offering looks like in the PNR. Must
  carry:
  - `segmentNumber: number` — unified with `AirSegment.segmentNumber`,
    bumped from `pnr.segments.length + <all other segment arrays>.length`
  - `status: string` — HK/NN/KK same as air
  - `confirmationNumber?: string` — issued at sell time

Add domain-relevant defaults as constants at the bottom (e.g.
`DEFAULT_CHECK_IN_HOUR`, `DEFAULT_PICKUP_HOUR`).

### 2. Seed file — `src/store/<domain>-seed.ts`

Exports a `const <DOMAIN>_SEED: <X>Property[]` array. Sized to give
HA/CA-style lists enough variety to test all filter combinations
without being overwhelming. Chunk 22 used 10 properties × 4 cities ×
6 chains; chunk 23 used 18 rentals × 4 cities × 4 companies.

Pick **fictional but plausible** data — round numbers for amounts,
real city codes (LON/MAD/ZRH/NYC), real chain/company codes that
follow the relevant industry convention (IATA 2-letter for airlines
and car companies, ACRISS SIPP for car vehicle types, etc.). Don't
benchmark to real market prices.

If the domain has named entities (carrier names, hotel chains), also
export a `<X>_NAMES: Record<string, string>` lookup table for the
renderer.

### 3. Inventory method — `src/store/inventory.ts`

Add a method per query pattern the domain supports:

```ts
<domain>sIn(city: string, filter?: string): <X>Property[] {
  const all = <DOMAIN>_SEED.filter((x) => x.city === city);
  return filter ? all.filter((x) => x.<filterField> === filter) : all;
}
```

For domains that don't filter by city (e.g. insurance might filter
by traveler age or trip cost), substitute the appropriate key. The
return-empty-on-no-match convention lets the dispatcher surface
"NO <X> FOUND" without throwing.

Add a direct-lookup method too if the domain has primary keys:
`<X>ByCode(<key1>, <key2>)`. Chunk 22 uses `hotelByCode(chain,
property)` for the single-property display variant.

Import the seed at the top of `inventory.ts`.

### 4. WorkArea cache slot — `src/session/work-area.ts`

The availability display must persist across entries so the sell
verb can reference by line number. Add to `WorkAreaSlot`:

```ts
last<X>Avail?: {
  /* enough fields to reconstruct the original query — usually city,
     date(s), time, plus the full <X>Property[] list returned */
  city: string;
  /* date-range fields */
  properties: import('../models/<domain>.js').<X>Property[];
};
```

Then mirror as a getter+setter on the `WorkArea` class (around line
348+ where `lastSeatMap` lives), and clear it in `reset()` alongside
the other display caches.

### 5. PNR segments array — `src/models/pnr.ts`

Add to the `Pnr` class:

```ts
<domain>Segments: <X>Segment[] = [];
```

Import `<X>Segment` at the top alongside `HotelSegment` and
`CarSegment`. The cross-dialect PNR display (e.g. Amadeus RT, Galileo
\*R) doesn't currently iterate non-air segment arrays — that's a
future cross-cutting addition when the dialects need it. For now,
each domain's segments are accessible via the typed field.

### 6. Dispatch — `src/dialects/<dialect>/index.ts`

Three verb groups per the QRG-documented family:

```ts
// Availability — populate the cache.
const <A>Match = /^<verb><params>$/.exec(entry);
if (<A>Match) {
  /* parse params, look up via inventory, cache on wa.last<X>Avail */
  return render<X>Availability(...);
}

// Sell — read the cache, append a new segment.
const <S>Match = /^<verb>(\d+)(?:\/<options>)?$/.exec(entry);
if (<S>Match) {
  if (!wa.last<X>Avail) return 'NO <X> DISPLAY';
  const line = parseInt(...);
  const offering = wa.last<X>Avail.<list>[line - 1];
  if (!offering) return 'INVALID LINE';
  const seg: <X>Segment = {
    segmentNumber: wa.pnr.segments.length + ...allOtherSegmentArrays + 1,
    /* fields from offering + cached query */
    status: 'HK',
    confirmationNumber: `<X>${confirmationFor(<deterministic-inputs>)}`,
  };
  wa.pnr.<domain>Segments.push(seg);
  recordHistory(wa.pnr, `<S> <code> <date-range>`);
  try { wa.machine.transition(SessionEvent.ADD_FIELD); } catch { /* */ }
  return render<X>Segment(seg);
}

// Cancel — remove a segment by number.
const <X>Match = /^<verb>(\d+)$/.exec(entry);
if (<X>Match) {
  const segNum = parseInt(...);
  const idx = wa.pnr.<domain>Segments.findIndex(s => s.segmentNumber === segNum);
  if (idx < 0) return 'SEGMENT NOT IN ITINERARY';
  wa.pnr.<domain>Segments.splice(idx, 1);
  return 'OK CANCELLED';
}
```

Each branch lives next to the others for the domain. Per-dialect
renderers (`render<X>Availability`, `render<X>Segment`) live as
private functions further down in the same file.

### 7. Deterministic confirmation number

Real systems issue random-ish confirmation numbers; tests need
determinism. Reuse `hotelConfirmationFor` (in `src/dialects/amadeus/
index.ts`) or define a sibling — both implement DJB2 hash of
`<keyed inputs>`:

```ts
function <domain>ConfirmationFor(...keys: string[]): string {
  let hash = 5381;
  const s = keys.join('|');
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return String(Math.abs(hash) % 90000 + 10000);
}
```

Keys should be (chain/company, property/vehicle-type, segment-index)
or whatever uniquely identifies the booking within a session. Same
inputs → same confirmation number across runs.

## Validation rules (the common four)

Each domain typically surfaces these error responses:

- `NO <X> FOUND` — availability display with no matching offerings
- `NO <X> DISPLAY` — sell with no prior availability cache
- `INVALID LINE` — sell with line number beyond cached list size
- `SEGMENT NOT IN ITINERARY` — cancel with no matching segmentNumber

Domain-specific rules layer on top:
- `INVALID RATE CODE` (hotel) — `/<bad-code>` on HS
- `INVALID VEHICLE TYPE` (car) — `/VT-<bad-code>` on CS
- `NO ROOMS AVAILABLE` (hotel) / `NO CARS AVAILABLE` (car) — rate has
  zero availability

## Testing structure

Mirror the chunk 22/23 pattern (~17-20 tests per domain):

- **Seed sanity** (~3 tests) — basic Inventory.<x>In() coverage
- **Availability verb forms** (~6-8 tests) — all entry shapes +
  default behaviors + cache verification + unknown-city handling
- **Sell verb** (~5-6 tests) — basic sell + rate/type override +
  error paths + deterministic confirmation + segment number bumping
- **Cancel verb** (~2 tests) — success + no-match

Put tests in `test/dialects/<dialect>-<domain>.test.ts`.

## Cross-dialect considerations

Both `HotelSegment` and `CarSegment` were added without dialect-
specific handlers — only Amadeus has the cryptic surface for HA/CA
families currently. When Sabre/Galileo grow their own non-air
verbs:

- The model + seed + Inventory methods are already in place
  (cross-dialect by construction).
- Each dialect adds its own dispatch with its own verb cryptic
  pointing at the same Inventory + WorkArea slots.
- The render functions become per-dialect (since each GDS has its
  own display convention) but consume the same underlying data.

This is the same shape as `synthesizeAvailability` for seat maps —
shared model, per-dialect render.

## Out-of-scope follow-ups (per QRG)

Things that are NOT covered by this seven-step recipe:

- **Hotel features / rate change displays** (HF, HR) — read-side
  detail verbs that drill into a single property from the HA cache.
  Add as a 4th verb group with its own `render<X>Detail()`.
- **Car terms displays** (CT, CR) — same shape as hotel HF/HR.
- **Location lists** (CL, HL) — separate keying domain (city
  airport list). Could be a sub-pattern.
- **Vouchers / billing** (CVD, CVP for car) — output documents,
  use the chunk 21 (INV/IBP) pattern instead.
- **Multi-segment booking** (referencing flight segments via S<n>)
  — needs cross-segment date inheritance; defer until a dialect
  asks for it.

## Working from this pattern

Recommended workflow for a new domain:

1. Find the QRG chapter (or equivalent reference) for the domain.
   Extract the documented availability + sell + cancel entry shapes.
2. Copy `src/models/hotel.ts` to `src/models/<domain>.ts` and rewrite
   the field shapes for the new domain.
3. Copy `src/store/hotel-seed.ts` to `src/store/<domain>-seed.ts`
   and seed 10-20 fictional entries.
4. Add the `<x>sIn(...)` method to Inventory.
5. Add the `last<X>Avail` cache slot to WorkArea.
6. Add the `<domain>Segments` array to Pnr.
7. Add the three dispatch branches to the relevant dialect.
8. Write the test file mirroring chunk 22/23's structure.

Total LOC for a domain typically 350-500 across all files, plus
~150 LOC of tests. Both chunks 22 and 23 landed in single commits;
expect similar scope for any future domain that fits this shape.
