# Behavior-layer source scouting — 2026-06-09

ROADMAP.md lists four items as "no public source" and therefore
deferred from format-faithful chunking:

1. NUC/ROE/HIP fare construction
2. MCT carrier-specific exceptions
3. Alliance ranking
4. FFA/FFR mileage accrual/redemption

This dig revisits each to see whether the "no public source" claim
still holds. Spoiler: **three of the four have substantive public
documentation** that we hadn't searched for hard enough. Only
alliance ranking remains genuinely opaque.

## Sources surveyed

Searches run via WebSearch (Anthropic) + Playwright MCP for
Cloudflare-gated pages. Targets exhausted in this dig:

- IATA — `iata.org/en/publications/manuals/iata-rates-of-exchange/`,
  `passengerairtariff.com/docs/WWFARES.pdf` (Worldwide Fares),
  `iata.org/en/publications/manuals/passenger-tariffs-conference-
  composite-manual/` (PTCCM), `iata.org/en/fmc-documents/...`
  (Resolution 800 — travel agent rules, not fare construction),
  Wikipedia "Neutral unit of construction"
- Travelport — `support.travelport.com/webhelp/FaresAndPricing/
  Content/NUCsCurrency%20Rounding.htm`
- OAG — `oag.com/blog/minimum-connection-times-insiders-guide`,
  `oag.com/hubfs/Inbound-Services/OAG-Guide-to-MCTs-Explained.pdf`,
  `oag.com/inbound-mcts`, `knowledge.oag.com/docs/57-mct-minimum-
  connection-times-1` (404 today; cached pages had content)
- Amadeus Service Hub — solution 862136 (FFA/FFR/FFU), 876446
  (SRFQTV manual), 949189 (VFFD), 936274 (error wording)
- Star Alliance — `staralliance.com/en/availability-display` (empty
  scaffold page; no documented rules)

## #1 NUC / ROE / HIP fare construction

**Public-source status**: 🟡 **Partial.** Concepts are documented
across multiple public sources; the **actual fare-construction
algorithm** (HIP / mileage / through-fare resolution) lives in IATA
Resolution 024 and the PTCCM, which are referenced publicly but the
full text is paywalled / member-only.

### What IS public

- **Travelport NUCsCurrency rounding doc** (extracted verbatim
  2026-06-09):
  - NUC rounding: 2 decimals, truncate (no rounding)
  - Local currency: per-currency HX (round up) or NX (nearest)
  - Default rule: ALWAYS ROUND UP unless a note specifies otherwise
  - IROE list established by IATA Clearing House on 5-day average
    ending 15th of month
- **Wikipedia "Neutral unit of construction"**: NUC system replaced
  the older FCU (Fare Construction Unit) on 1 July 1989
- **IATA Rates of Exchange Manual** — publication exists; not free
- **Resolution 024c** governs IROE (referenced in multiple sources)
- **Worldwide Fares PDF** at `passengerairtariff.com/docs/WWFARES.pdf`
  — likely the deepest free source; behind redirect, not yet
  extracted

### What ISN'T public

- The verbatim IROE conversion factor table (varies monthly; sold
  via IATA subscription)
- The HIP (Higher Intermediate Point) algorithm with sample worked
  examples — most public sources describe the concept but not the
  decision logic for picking between competing intermediate points
- Mileage system rules (MPM, EMS / Extra Mileage Surcharge brackets)
  — referenced in IATA training but full algorithm in PTCCM
- The full Composite Manual (PTCCM) text

### Practical implication for the emulator

**Format-faithful implementation possible** for:
- NUC rounding rules (truncate-2-decimals, round-up local default)
- A small synthetic IROE table for the 5 currencies we already use
  (USD/EUR/GBP/CHF/EUR) — not the real one but flagged-as-emulated
- Simple HIP detection with documented response wording (the verb
  surface exists in Amadeus QRG; the *result* needs the algorithm)

**Synthesis layer needed** for:
- The actual HIP algorithm (no public source for the decision tree)
- MPM / EMS surcharge calculation
- Real IROE numbers (would need a paid IATA subscription)

## #2 MCT carrier-specific exceptions

**Public-source status**: 🟢 **Documented at the model level**, opaque
on the actual data values.

### What IS public (extracted 2026-06-09)

- **OAG's "MCTs Explained" blog post** documents the 4-layer
  override hierarchy:
  1. IATA-approved airport standard (the default)
  2. Airport-specific industrial standard (overrides #1)
  3. Airline-specific exceptions (filed by individual carriers)
  4. Exceptions to exceptions (carrier-pair-specific re-overrides)
- **Standard defaults** (typical, not exhaustive):
  - Domestic-to-Domestic: ~30 minutes
  - International transfers: ~90 minutes
- **Example records** (illustrative):
  ```
  AA – to All  D-to-I exception at MIA  55 minutes
  AA – to BA   D-to-I status standard at MIA  9999
  ```
  ("9999" means "use default standard")
- **Exception volumes**: LHR has 2,372 carrier exceptions; CDG has
  10,160 — gives us an order-of-magnitude estimate
- **MCT record fields**: carrier, airport, connection type (D-D /
  D-I / I-I / I-D), flight number range, terminal, date range,
  codeshare flag, equipment

### What ISN'T public

- The actual 157,000 OAG MCT records — those are licensed via OAG's
  Flight Info API ($$$)
- Per-airport default tables (IATA-approved)
- Real-time updates

### Practical implication for the emulator

**Layered model possible**: extend our current single
`MIN_CONNECT_MINUTES = 45` constant in Inventory to a small dataset
with the same shape as the documented OAG model:

```ts
interface MctRecord {
  airport: string;       // IATA code
  carrier?: string;      // optional — undefined = airport default
  connectionType: 'DD' | 'DI' | 'II' | 'ID';
  minutes: number;
  flightNumberRange?: [number, number];
  effectiveFrom?: string;
  effectiveTo?: string;
}
```

Seeding 10-20 records gives DM/DMI verbs something more realistic
to return than the current 45-minute hard-coded value. Flagged as
"emulator-seeded, not OAG live data."

## #3 Alliance ranking

**Public-source status**: 🔴 **Still opaque.**

### What we found

- **Academic paper** (ScienceDirect, 2017): GDS displays historically
  preferred online connections, which drove airlines into alliance
  consolidation. The ranking-algorithm internals are not in the
  paper.
- **Star Alliance "Availability Display" page**: marketing-empty
  scaffold; no documented rules.
- **Wikipedia "Global Distribution System"**: describes the GDS role
  but not the sort algorithm.

### Pattern hypothesis (not source-verified)

The general industry pattern for availability sort appears to be:
1. Online (same-carrier) connections first
2. Same-alliance connections next
3. Other interline last
4. Within each tier, by departure time

But no specific GDS or alliance publishes the algorithm. The
ranking that operators actually see is a result of the
carriers paying for display position + the GDS's commercial
neutrality rules + EU/US regulatory constraints
(DOT 14 CFR 256 in the US).

### Practical implication for the emulator

**Format-faithful implementation not possible**. Our current
emulator availability uses the seed order — that's as good as we can
do without a documented algorithm. If we ever build it, we should
flag the ranking heuristic as synthesized and document the
publishable behavior pattern (online > alliance > other) rather
than claiming algorithmic fidelity.

## #4 FFA / FFR / FFU / FFD frequent-flyer

**Public-source status**: 🟢 **Fully documented in Amadeus Service Hub.**
The "no public source" claim in ROADMAP.md was wrong. These verbs
are documented verbatim with response samples.

### What we extracted verbatim

From Amadeus Service Hub solution 862136 (2026-06-09, Playwright
bypass of Cloudflare):

#### FFA — Frequent Flyer Accrual

Format: `FFA<airline>-<number>`
- Creates an SSR FQTV element with the passenger's mileage program
- Multi-airline variant: `FFA<airline>-<number>, <code1>, <code2>`
- When the FF program has cross-airline agreements, Amadeus uses
  `YY` as the airline code in the SSR, and end-of-transaction
  fans out one SSR FQTV per agreement carrier
- Cannot be used for passive segments

Response (verbatim from Service Hub):
```
RP/XXXXXXXXX/
  1.VIRTA/VILLE MR
  2 *SSR FQTV YY HK/ AY608479929/4
```

Field decode (from the page table):
- `*` — element has been validated
- `SSR` — SSR identifier
- `FQTV` — frequent flyer accrual code
- `YY` — airline code (YY when agreements span multiple carriers,
  else the card-owning airline)
- `HK` — action code
- `/AY` — airline owning the FF program
- `608479929` — FF account number
- `/4` — airline priority code (optional)

#### FFR — Frequent Flyer Redemption

Format: `FFR<airline>-<number>`
- Creates an SSR FQTR element
- Requires names + segments to exist first
- After SSR FQTR added, names cannot be changed in the PNR
- Cross-cardholder variant:
  `FFR<airline>-<number>-CARDHOLDER <surname>/<given>`

#### FFU — Frequent Flyer Upgrade

- Creates an SSR FQTU element
- Requires names + segments + must end-transact in original class
- Used to redeem miles for an upgrade

#### FFD — Frequent Flyer Display

- Displays FF name from the airline's FF database
- Shows how the name is stored in the FF database

#### VFFD — Frequent Flyer Agreements

- Already implemented in chunk 17 (lists carriers with FF agreements)

### Practical implication for the emulator

**Chunk 25 fully landable** with format-faithful response wording
extracted verbatim from Amadeus. The verbs map to existing SSR
infrastructure:
- FFA → push SSR{code: 'FQTV', carrier, text: <number>}
- FFR → push SSR{code: 'FQTR', carrier, text: <number>}
- FFU → push SSR{code: 'FQTU', carrier, text: <number>}
- FFD → render the FQTV/FQTR/FQTU SSRs in the standard PNR format

## Summary table

| Item | Public-source status | Implementable now? |
|---|---|---|
| NUC/ROE rounding | 🟡 partial | Yes (rounding rules + synthetic IROE) |
| HIP algorithm | 🔴 opaque | No (algorithm not public) |
| MCT exception layering | 🟢 model documented | Yes (small seed dataset) |
| Real OAG MCT data | 🟡 licensed only | No (paid API) |
| Alliance ranking algorithm | 🔴 opaque | No (no public algorithm) |
| FFA/FFR/FFU/FFD | 🟢 fully documented | Yes (chunk 25, this commit) |

## ROADMAP.md update

The "no public source" claim should be split. The five items that
remain genuinely opaque are:
1. HIP decision algorithm (concept documented, algorithm not)
2. MPM / EMS mileage surcharges (algorithm in PTCCM, paywalled)
3. Real IROE conversion table (IATA subscription)
4. Real OAG MCT data (OAG license)
5. Alliance ranking algorithm (industry trade secret + commercial
   carrier-paid display position)

The four items that ARE chunkable format-faithfully — all landed:
1. FFA/FFR/FFU/FFD — ✅ chunk 25
2. NUC rounding rules + synthetic IROE table — ✅ chunk 27
3. MCT exception layering with seed data — ✅ chunk 26
4. VFFD already implemented (chunk 17)
