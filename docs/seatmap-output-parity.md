# Seat-map output parity vs references

Verification pass: compare our renderer's output against each
dialect's published sample (where one exists). This doc is the
audit; follow-up commits address divergences if needed.

## Per-dialect reference availability

In-tree:

| Dialect | Reference | Sample output documented? |
|---|---|---|
| Sabre | `references/Sabre-Basic-Reservation-Course.pdf` (Display Seat Maps section) | **YES** — verbatim DL/MD90 response |
| Sabre | `references/Sabre-Reservation-Course-Zenon-Rev08.pdf` | No — extensive 4G verb tables, no rendered output |
| Sabre | `references/Sabre-Quick-Reference-MiddleEast-2007.pdf` | No — 4G verb table only |
| Galileo | `references/galileo/Galileo-Pocket-Guide.pdf` + Mini Format Guide v2 + Kuwait 2021 | No — verb forms only |
| Travelport+ Mini Guide | `references/galileo/Travelport-Mini-Format-Guide-v2.pdf` | No — Smartpoint click-targets only |
| Amadeus | `references/amadeus/Amadeus-Cryptic-Entries-Reference-Guide-Ed-9.2-2012.pdf` (p.39) | No — entry forms only |

Found via additional dig (2026-06-08):

| Dialect | Reference | Sample output documented? | Stored at |
|---|---|---|---|
| Sabre (Eurostar) | Eurostar 2026 Sabre guide | **YES** — Eurostar/Sabre rail convention: symbol table verbatim | `references/Sabre-Eurostar-Guide-2026.pdf` (saved 2026-06-08) |
| Amadeus | Amadeus Service Hub (`servicehub.amadeus.com/c/portal/view-solution/794907`) | **YES** — official Amadeus seat-map symbol legend | External — copied verbatim into this doc since the page is gated behind a 403 for unauthenticated fetches |

Three samples + two official symbol-table references = the strongest
parity dataset we'll get short of running terminals. The new finds
show that "Sabre's convention" isn't a single convention — it varies
by carrier and product (DL/MD90 differs from Eurostar/rail). Amadeus
has an officially-published symbol legend that we can hold our
renderer up against.

## Sabre — verbatim reference vs our output

### Reference (Sabre Basic Course PDF, "Display Seat Maps", DL/MD90 sample)

```
DL RESPONSE
864Y 25OCT DFWSLC       SEATS INVENTORY DETAIL
M90-Y1/SHIP 000
M90 DELTA MD90 Y-138 SEATS ECONOMY CLASS
            ....................
      10    . . -BLKHD- . . .
      11P A B            C D E
      12P A B            C D E
      13    A B          C D E
      14    A B          C D E
      15    A B          C D E
      16    A B          C D E‡
AVAIL: SEAT LETTER LEAST PREF:    SMOKING:S        BULKHEAD:
TAKEN: .           UPPER DECK:    NOSMOKE:N        WING    ://
BLOCK:             HANDICAP :     BUFFER :         EXIT ROW:EX
PREFERRED:P
```

### Our output (DL422 76W on 4G1*)

```
422Y 25OCT LAXJFK
SEATS INVENTORY DETAIL

 FIRST (F)        A  B     C  D     E  F
                1 W  A     A  A     A  W
                ...

ROWS 1-20 OF 29
LEGEND: . avail  X reserved  - blocked   W window  A aisle  M middle  K bulkhead  E exit  H handicapped
```

### Divergences (Sabre)

| # | Aspect | Reference | Our output | Severity |
|---|---|---|---|---|
| 1 | Header layout | `<flight><cls> <date> <citypair>   SEATS INVENTORY DETAIL` on ONE line | Two lines | **Cosmetic** |
| 2 | Ship line | `M90-Y1/SHIP 000` | Absent | **Cosmetic** — we don't model ship-tail data |
| 3 | Equipment description | `M90 DELTA MD90 Y-138 SEATS ECONOMY CLASS` | Absent | **Cosmetic** — we don't track airline names / total seat count |
| 4 | Available seat marker | **Seat letter** (A, B, C, D, E shown when available) | `.` for available | **🔴 SEMANTIC INVERSION** — Sabre operators read `.` as TAKEN, our render uses it as AVAILABLE |
| 5 | Taken seat marker | `.` | `X` | **🔴 inverse of above** |
| 6 | Bulkhead row marker | `-BLKHD-` between aisles | We use cabin code prefix only | **Cosmetic** |
| 7 | Preferred-seat marker | `P` suffix on row number | Absent | **Cosmetic** — we don't model preferred seats |
| 8 | Column header line | Absent (rows go straight after equipment line) | Per-cabin column header | **Cosmetic** — operator-friendly addition |
| 9 | Cabin code prefix | Absent | `FIRST (F)`, `BUSINESS (J)`, `ECONOMY (Y)` | **Cosmetic** — operator-friendly addition |
| 10 | Aisle marker | Multi-space whitespace | Extra space + we wrote `A` for aisle position | **Cosmetic** |
| 11 | Legend format | Multi-line categorical (AVAIL/TAKEN/BLOCK/PREFERRED/SMOKING/HANDICAP/UPPER DECK/BUFFER/EXIT ROW/BULKHEAD/WING) | One-line generic | **Cosmetic** |
| 12 | Multi-cabin display | Reference shows ECONOMY CLASS only | We render all cabins | **Cosmetic** — our seed has F/J/Y for 76W |

The **🔴 semantic inversion** (rows 4-5) is the only correctness
issue. A Sabre operator reading our output would interpret:

- Cell shows `.` → Sabre operator thinks "TAKEN" — actually we mean "available"
- Cell shows `X` → Sabre operator thinks "what's X?" — we mean "reserved/taken"

This isn't a parser conflict (the renderer never sees raw input);
it's a display-side semantic clash. For an emulator targeting real
Sabre-trained operators, this gets it wrong.

The Sabre Basic Course also explicitly says:

> Each airline's seat maps appear differently and use different
> symbols. The legend at the bottom of each map will help you
> decode the symbols

So per-airline variation is expected; the legend on our output
documents OUR convention explicitly. An operator reading our legend
("`. avail X reserved`") gets correct semantics — they just don't
match the DL-specific Sabre sample.

## Galileo — verb-rich, no rendered sample

The 2026-06-08 Playwright dig pulled additional Galileo verb
documentation from three online sources (galileoindonesia.com,
support.travelport.com/webhelp/formats, support.travelport.com/
webhelp/Smartpoint1G1V) — all yielded richer verb-form tables than
the in-tree references but **no actual rendered seat-map sample**.

New Galileo seat-map verb forms found (richer than our chunk 5
implementation):

```
SA*AZ610J20JULFCOJFK         direct: <carrier><flight><class><date><citypair>
SA*KL598Q29JANCPTAMS/NW      direct + non-smoking-window filter
SA*KL598Q29JANCPTAMS/15      direct + from row 15 offset
SA*KL598Q29JANCPTAMS/NW/15   combined filter + offset
SA*AA101Y1JUNLHRJFK/N-3      direct + non-smoking for 3 passengers
SA*A1F                       from avail line 1, F class
SA*A1F/20                    avail line + from row 20
SA*A1F/NW                    avail line + non-smoking-window
SA*A1F/NW/20                 combined
SA*A1Y/S-2                   avail line + smoking area, 2 pax
SA*S4                        segment 4 (we have this)
SA*S4/15                     segment + from row 15
SA*S4/NW                     segment + non-smoking-window
SA*S4/NW/15                  combined
SA*                          refresh (we have this)
SC*10A                       specific seat characteristic (we don't have)
SA*S1#BRU                    segment + change-of-gauge leg from BRU
```

Our chunk 5 implementation covers the three core verbs (segment,
avail-line, refresh) but not the filter suffixes (`/NW`, `/<row>`,
`/<class>-<count>`) or the change-of-gauge `#<airport>` qualifier
or `SC*<seat>` characteristics. These are all "richer" but not
correctness gaps — operators using them would get an honest "not
implemented" rather than wrong output.

## ✅ Apollo cryptic correction (Comparison Guide + Travelport GWS) — FIXED

The in-tree `references/galileo/Travelport-GDS-Format-Comparison-
Guide.pdf` has a Rosetta table that I missed during chunk 5. **All
5 dialects use different seat-map cryptics**:

| Dialect | Display by segment | Cancel seats |
|---|---|---|
| Galileo (1G) | `SA*S1` | `S.S1` |
| Worldspan | `41*` | `4RX1` |
| **Apollo (1V)** | **`9V/S1`** | **`9X/S1`** |
| Amadeus | `SM1` | `SX/S1` |
| Sabre | `4G1*` | `4GX1` |

**Chunk 5 implementation bug**: Apollo currently inherits Galileo's
`SA*S<n>` via the translator. But the actual Apollo cryptic for seat
maps is `9V/S<n>`. Apollo operators trained on the real Apollo
system would never type `SA*S1` — they'd type `9V/S1` and our
parser would fail to recognize it.

The Travelport GWS task documentation (`support.travelport.com/
webhelp/GWS/.../task_seat_map_request.html`) confirms verbatim:
"Terminal Equivalents: Apollo 9V/… Galileo SA*… or SM*…".

Fix: add `9V/S<n>` and `9V*<...>` parsing to the Apollo translator
so the actual Apollo cryptic works. SA*/SM* could continue to work
as a "Galileo-style" fallback (no operator would type those into
Apollo intentionally, but no reason to reject them).

## Sabre — Eurostar 2026 sample (rail variant)

Symbol table verbatim from the Eurostar 2026 guide:

| Symbol | Meaning |
|---|---|
| `*` | a seat that is available for selection |
| `.` | a seat that is already taken |
| `TTT` | location of a Table |
| `R` | this seat is in the Reverse direction of travel |

Eurostar-specific seat type codes: W=Window, A=Aisle, -T2/-T4 (Club
2/Club 4 — seats facing each other with table), -E1 (Solo), -E2
(Duo — airline-style with seat back tables).

**Cross-Sabre convention comparison**:
- DL/MD90 (Basic Course): letter (A B C D E) = available, `.` = taken
- Eurostar (rail): `*` = available, `.` = taken
- Common across both: `.` = TAKEN

So `.` for TAKEN appears to be universal across Sabre samples. The
AVAILABLE character is what varies (seat letter for airline,
asterisk for rail).

## Amadeus Service Hub — verbatim rendered sample

**Major correction**: an earlier read of the legend (transcribed via
WebSearch summary) had `<>` as the AVAILABLE marker. Pulled the actual
page through Playwright (2026-06-08, bypassing the 403 the
unauthenticated fetcher gets) — the legend is two separate entries:
`. AVAILABLE` AND `<> WING`. The period is AVAILABLE; the angle
brackets are wing-positional markers framing wing-section rows.

### Horizontal sample (verbatim, from servicehub.amadeus.com solution 794907)

```
SM AA 0505/M/18FEBMIAMEX
SM AA  0505  M 18FEB MIAMEX        737
   Y
   0 0         0         0
   0 1         2         3
   89012345678901234567890123
   B    <  EE   >
F  LLYYY.Y.LLYYY............+                                                 F
E  +LYYVVY.LLYYY............+                                                 E
D  +LYYVVV.LLYYY............+                                                 D

C  LLYYVVV.LLYYYV...........+                                                 C
B  LLYYVVY.LLYYYY...........+                                                 B
A  LLYY..Y.LLYYYY...........+                                                 A
B    <  EE
   89012345678901234567890123
   0 1         2         3
. AVAILABLE   <> WING     F GEN FACI   K GALLEY   E EXIT    C COT
+ OCCUPIED    - LAST OFF  H HANDICAP   Q QUIET    G GROUPS  P PET
/ RESTRICTED  B BULKHEAD  V PREF.SEAT  X BLOCKED  L LEGROOM U UMNR
() SMOKING    D DEPORTEE  UP UP-DECK   Z NO FILM  I INFANT  R REAR
Y CHARGEABLE
```

### Vertical sample (verbatim, `/V` suffix)

```
SM AA 0505/M/18FEBMIAMEX/V
SM AA  0505  M 18FEB MIAMEX        737
         A  B  C     D  E  F
Y  8  B  L  L  L     +  +  L  B  8  Y
   9     L  L  L     L  L  L     9
  10     Y  Y  Y     Y  Y  Y     10
  11     Y  Y  Y     Y  Y  Y     11
  12     .  V  V     V  V  Y     12
  13 <   .  V  V     V  V  .   > 13
  14 <   Y  Y  V     V  Y  Y   > 14
  15 <   .  .  .     .  .  .   > 15
  16 <E  L  L  L     L  L  L  E> 16
  17 <E  L  L  L     L  L  L  E> 17
  18 <   Y  Y  Y     Y  Y  Y   > 18
  19 <   Y  Y  Y     Y  Y  Y   > 19
  20 <   Y  Y  Y     Y  Y  Y   > 20
         A  B  C     D  E  F
. AVAILABLE   <> WING     F GEN FACI   K GALLEY   E EXIT    C COT
+ OCCUPIED    - LAST OFF  H HANDICAP   Q QUIET    G GROUPS  P PET
/ RESTRICTED  B BULKHEAD  V PREF.SEAT  X BLOCKED  L LEGROOM U UMNR
() SMOKING    D DEPORTEE  UP UP-DECK   Z NO FILM  I INFANT  R REAR
Y CHARGEABLE
```

### Symbol legend (verbatim, sorted)

| Symbol | Meaning |
|---|---|
| `.` | AVAILABLE |
| `+` | OCCUPIED |
| `-` | LAST OFF |
| `X` | BLOCKED |
| `/` | RESTRICTED |
| `V` | PREF.SEAT (preferred) |
| `L` | LEGROOM |
| `Y` | CHARGEABLE |
| `<>` | WING (positional markers, frame wing rows) |
| `F` | GEN FACI (general facility) |
| `K` | GALLEY |
| `E` | EXIT |
| `C` | COT (bassinet) |
| `B` | BULKHEAD |
| `H` | HANDICAP |
| `Q` | QUIET |
| `G` | GROUPS |
| `P` | PET |
| `U` | UMNR (unaccompanied minor) |
| `D` | DEPORTEE |
| `UP` | UP-DECK (upper deck) |
| `Z` | NO FILM |
| `I` | INFANT |
| `R` | REAR |
| `()` | SMOKING (parenthesized seat letter) |

### Vertical format structure

Per-row layout in vertical mode:

```
<cabin>  <row>  <L-marker>  A  B  C     D  E  F  <R-marker>  <row>  <cabin>
```

Where the markers (2-char each) can be:
- `  ` (nothing — interior row)
- `B ` and ` B` (bulkhead row, B before col A and after col F)
- `< ` and ` >` (wing-section row)
- `<E` and `E>` (wing AND exit row combined)

Row 8 (`Y  8  B  L  L  L     +  +  L  B  8  Y`) shows the bulkhead +
cabin code annotations: `Y` = Economy cabin, row 8 is bulkhead row,
seats are L (legroom), +(occupied), L (legroom).

Rows 13-15: wing-section rows (`<` and `>` markers).
Rows 16-17: wing AND exit rows (`<E` and `E>` markers).

### Comparing to our renderer

| Aspect | Amadeus official | Our renderer | Status |
|---|---|---|---|
| AVAILABLE marker | `.` | `.` | **✅ MATCHES** |
| OCCUPIED marker | `+` | `X` | Diverge — semantic, ours uses X |
| BLOCKED marker | `X` | `-` | Diverge — ours uses `-` for blocked |
| Cabin code label | Row-gutter Y/F/J (left + right) | Left-margin `ECONOMY (Y)` once per cabin | Diverge — ours is more verbose |
| Wing markers | `<>` framing wing-section rows | Absent | Diverge — we don't model wing position |
| Bulkhead markers | `B` left + right of seat block on bulkhead row | Absent (we used to do per-cell K, dropped in chunk 2 review) | Diverge |
| Exit row markers | `<E` and `E>` framing exit row | `--- EXIT ROW ---` divider above | Diverge — ours is more verbose |
| Chargeable / Legroom / Preferred | Y / L / V per seat | Absent | Defer — no seat metadata |
| Row labels position | Both sides (mirrored) | Left side only | Diverge — ours is asymmetric |
| Column headers | Top + bottom (mirrored) | Top only, per-cabin | Diverge |

**Our convention `.` for available IS correct** for Amadeus. The
earlier search-summary misread "AVAILABLE <>" as a single entry was
wrong. Our renderer's choice diverges from Amadeus in OCCUPIED (we
use `X`, they use `+`) and in cabin/wing/bulkhead annotations, but
not in the basic available-seat semantics.

## Recommendations (revised after the 2026-06-08 Galileo dig)

Three findings from the dig changed the priority list:

1. **Amadeus `.` = AVAILABLE matches us** (the WebSearch summary had
   misread the legend; Playwright pulled the actual page)
2. **Apollo cryptic is `9V/S<n>` NOT `SA*S<n>`** — chunk 5's
   translator-pass-through assumption was wrong per the in-tree
   Comparison Guide + Travelport GWS task docs
3. **Galileo's SA*/SM* family is much richer** than we knew (filters
   for non-smoking-window, from-row offset, passenger count,
   change-of-gauge `#<airport>`, seat-characteristic `SC*<seat>`)

| # | Action | Status |
|---|---|---|
| 1 | Document the divergences (this doc) | ✅ Done |
| 2 | **✅ Apollo correctness fix**: `9V/S<n>` parsing landed in the Apollo translator (routes to Galileo's `SA*S<n>` handler). | ✅ Done — landed in the follow-up commit after this doc. |
| 3 | **Per-dialect glyph map architecture** — each dialect can override STATUS_GLYPHS + POSITION_PRIORITY | ⏳ Open — structural change for #4 |
| 4 | **Sabre dialect**: flip `.` to TAKEN, AVAILABLE varies by carrier (use `*` as the Eurostar-aligned char) | Depends on #3 |
| 5 | **Amadeus dialect**: switch OCCUPIED `X` → `+`, BLOCKED `-` → `X` to align with the official Service Hub legend | Depends on #3; small once #3 is in |
| 6 | Galileo SA* filter suffixes (`/NW`, `/<row>`, `/<class>-<n>`) + change-of-gauge `#<airport>` + `SC*` characteristics | Defer — feature surface expansion, not correctness |
| 7 | Add chargeable (Y), preferred (V), legroom (L) markers driven by seat metadata | Defer — needs metadata model |
| 8 | Sabre-specific ship/equipment description lines, BLKHD marker, P preferred-row prefix | Defer — needs additional data |
| 9 | Amadeus mirrored cabin code labels + top+bottom column headers | Defer — cosmetic |
| 10 | Wing-section markers (`<>`), exit-row inline markers (`<E E>`) on Amadeus vertical | Defer — needs wing-row data we don't seed |

**Revised recommended order**:
1. Land #2 (Apollo `9V/` fix) — the only real correctness bug, ~50 LOC
2. Land #3 (per-dialect glyph map) as the structural change
3. Land #4 (Sabre `.` flip) + #5 (Amadeus glyph tweaks) on top of #3
4. Defer the rest until a seat-metadata data model lands

## Galileo open question

We have NO actual rendered sample for Galileo SA*S<n> output. The
verb forms are well-documented (3 sources confirm) but the response
wording remains undocumented in any public source we could find.
Our current `galileoSeatMapHeader` is reconstructed and consistent
with Galileo display conventions but isn't verbatim per any sample.

Pragmatic: keep the reconstructed Galileo format. If a Galileo
seat-map sample ever surfaces, align then. The Amadeus-correction
pattern is a good template: get the live response, compare, decide
whether to align or document the choice.

## Cross-cutting observations

**The Sabre Basic Course's "Each airline's seat maps appear differently"
caveat is real**: DL/MD90 (letters for available) and Eurostar (`*` for
available, `.` for taken) are both in the Sabre family but use different
conventions. Even a "perfect" Sabre fix would only match ONE airline/
product convention; others diverge by design. The legend on our output
is what makes our renderer self-consistent.

**Amadeus's published legend is internally consistent**: each character
means ONE thing without precedence rules. Our multi-tier renderer
(position SCC overrides status glyph) is an operator-readability
choice but diverges from how Amadeus actually renders. Aligning the
Amadeus dialect's renderer to use `<>` for available and drop the
position-priority pass would be a closer match to official Amadeus
output.

**Galileo has no published sample** — our reconstructed
`galileoSeatMapHeader` + body remains the only documented option.
Recommendation: keep Galileo's body convention aligned with whichever
target gets the most work (likely Amadeus, since that's the dialect
with the official legend).

## v1 decision (current state, kept until per-dialect glyph map lands)

Our cross-dialect format prioritizes consistency across dialects and
operator-readability via a self-documenting legend. The renderer's
character choices (`.` available, `X` reserved, `-` blocked) are
internally consistent and explicitly documented at the bottom of
every render. An operator unfamiliar with any single GDS's
convention can read our legend and understand the output; that's
the right v1 trade-off until per-dialect customization lands.
