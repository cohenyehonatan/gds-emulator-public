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

## Galileo / Amadeus — no reference sample

Verb forms documented, response wording is not. Our renderers are
explicitly reconstructed:

- `galileoSeatMapHeader` — `<carrier><flight>/<class> <date>
  <citypair>  EQP <equipment>` (reconstructed, flagged in code)
- `amadeusSeatMapHeader` — `SM <n> — <carrier><flight> <date>
  <orig>-<dest> — <equipment>` (reconstructed, flagged in code)

Our format is consistent across dialects (same body, dialect-
specific header) and the legend documents the conventions used.

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

## Amadeus Service Hub symbol legend (official)

The official Amadeus Service Hub documentation lists this seat-map
symbol legend (covers chargeable + preferred seats specifically):

| Symbol | Meaning |
|---|---|
| `<>` | AVAILABLE (with wing indicators where applicable) |
| `+` | OCCUPIED |
| `-` | LAST OFF (last seats to be assigned?) |
| `X` | BLOCKED |
| `/` | RESTRICTED |
| `V` | PREFERRED SEAT |
| `L` | LEGROOM (extra-legroom seat) |
| `Y` | CHARGEABLE |
| `K` | GALLEY |
| `F` | GALLEY (or other facility per the legend) |
| `E` | EXIT |
| `B` | BULKHEAD |
| `H` | HANDICAP-accessible |
| `Q` | QUIET zone |
| `G` | GROUP-allocated |
| `P` | PET-allowed |
| `U` | UNACCOMPANIED MINOR |
| `D` | DEPORTEE |
| `UP` | UPPER DECK |
| `Z` | NO FILM |
| `I` | INFANT |
| `R` | REAR |
| `()` | SMOKING (parenthesized seat letter) |

Vertical (/V) vs horizontal (/H) display toggle confirmed.

**Comparing to our renderer**:
- We use `.` for AVAILABLE; Amadeus uses `<>`
- We use `X` for RESERVED; Amadeus uses `+` for OCCUPIED, `X` for BLOCKED
- We have no chargeable/preferred/legroom markers; Amadeus does
- We DO emit position SCC (W/A/M); Amadeus doesn't use position
  markers per-cell (those are just structural)

Amadeus's official convention is genuinely richer than ours but
internally consistent: each character means ONE thing (no
position-vs-status precedence rules like ours has). Our renderer's
multi-tier precedence (position SCC > status glyph) is an
operator-readability optimization that diverges from how Amadeus
actually renders.

## Recommendations (revised after the 2026-06-08 dig)

| # | Action | Status |
|---|---|---|
| 1 | Document the divergences (this doc) | ✅ Done |
| 2 | Flip `.` (currently AVAILABLE) to mean TAKEN — universal across both Sabre samples (DL, Eurostar) | ⏳ Open. Small refactor: change STATUS_GLYPHS at the renderer. Other characters (W/A) keep their position-SCC meaning. |
| 3 | Adopt `<>` for Amadeus AVAILABLE per the official Service Hub legend | Open — would need a per-dialect glyph map. Slightly bigger refactor than #2. |
| 4 | Add chargeable (Y), preferred (V), legroom (L) status markers driven by additional seat metadata | Defer — needs metadata model (we don't track chargeable/preferred/legroom per seat) |
| 5 | Sabre-specific ship/equipment description lines, BLKHD marker, P preferred-row prefix | Defer — needs additional data we don't model |
| 6 | Per-dialect glyph map architecture (each dialect can override STATUS_GLYPHS + POSITION_PRIORITY) | Open — the right structural change to unblock both #2 and #3 cleanly |

**Recommended order**:
1. Land #6 (per-dialect glyph map) as the structural change
2. Land #2 (flip AVAILABLE/TAKEN for Sabre) and #3 (Amadeus `<>`)
   using the new architecture
3. Defer the rest (chargeable/preferred/legroom + Sabre-specific
   cosmetic lines) until we have a data model for those attributes

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
