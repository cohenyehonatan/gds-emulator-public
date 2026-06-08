# Seat-map output parity vs references

Verification pass: compare our renderer's output against each
dialect's published sample (where one exists). This doc is the
audit; follow-up commits address divergences if needed.

## Per-dialect reference availability

| Dialect | Reference | Sample output documented? |
|---|---|---|
| Sabre | `references/Sabre-Basic-Reservation-Course.pdf` (Display Seat Maps section) | **YES** — verbatim DL/MD90 response |
| Galileo | `references/galileo/Galileo-Pocket-Guide.pdf` + Mini Format Guide v2 + Kuwait 2021 | No — verb forms only |
| Travelport+ Mini Guide | `references/galileo/Travelport-Mini-Format-Guide-v2.pdf` | No — Smartpoint click-targets only |
| Amadeus | `references/amadeus/Amadeus-Cryptic-Entries-Reference-Guide-Ed-9.2-2012.pdf` (p.39) | No — entry forms only |

So Sabre is the only dialect with an actual reference output to
compare against. Galileo + Amadeus headers are explicitly
reconstructed in our code (`galileoSeatMapHeader`, `amadeusSeatMapHeader`
both flagged with "reconstructed" comments).

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

## Recommendations

| # | Action | Status |
|---|---|---|
| 1 | Document the divergences (this doc) | ✅ Done |
| 2 | Flip the AVAIL/TAKEN convention to match Sabre's published format (letter = available, `.` = taken) for the Sabre dialect specifically | ⏳ Open. Cross-dialect renderer would need a per-dialect glyph map; small refactor. |
| 3 | Add ship/equipment description lines on Sabre | Defer — needs aircraft-name data we don't model |
| 4 | Add bulkhead marker (`-BLKHD-`) and preferred (`P`) row prefix on Sabre | Defer — needs preferred-seat data + per-row bulkhead synthesis |
| 5 | Multi-line categorical legend for Sabre | Cosmetic — defer |

Action #2 is the only one that fixes a real correctness issue and is
small enough to land in one chunk. Recommended next step if seat-map
fidelity matters for the Sabre dialect specifically.

## Cross-cutting observation

The Sabre Basic Course's "Each airline's seat maps appear differently"
caveat is real: the DL/MD90 example is ONE airline's convention.
Other airlines' maps (UA, AA, LH, etc.) in Sabre would render
differently. So even a "perfect" Sabre fix would only match the DL
case; other airline-specific quirks would still diverge.

Decision: for v1, our cross-dialect format prioritizes consistency
and operator-readability over verbatim airline mimicry. The
correctness fix in action #2 is worth doing for semantic alignment
(don't show `.` where Sabre shows AVAILABLE); the rest are cosmetic
and probably not worth the cross-dialect renderer complexity.
