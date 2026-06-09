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

## Second dig (2026-06-09, later session) — HIP + display ranking

The first dig left HIP and alliance ranking marked 🔴 opaque. A
second pass overturned both:

### HIP algorithm — 🟢 NOW DOCUMENTED

**Travelport CAT17 webhelp** (`support.travelport.com/webhelp/
FaresAndPricing/Content/Cat17%20-%20HIP.htm`, extracted verbatim)
documents the production HIP semantics:

- Class-hierarchy comparison: "P class fare with P class fare; If no
  P fare, compare with F fare" (and down through J/C → Y)
- Comparison direction: "The comparison shall be made in the same
  direction as the fare component. When using half round trip fares
  the comparison shall be made using half round trip fares."
- "THE HIGHER INTERMEDIATE POINT RULE DOES NOT APPLY FOR CONNECTIONS"
  — only stopover points are HIP candidates (post-ISI-elimination)
- Exclusions during comparison: "any Stopover Charges, Q surcharges
  or Mileage Increases must be excluded"
- After determination: "any applicable mileage increases applicable
  to the through fare will be applied to the HIP fare"
- ATPCO Cat 17 override semantics (byte 290: X = no HIP check,
  B = do HIP check; default when unfiled = check)
- Geographic exceptions (India→N.America via Europe, Turkey, West
  Africa, Israel — all-ticketed-points variants)

**Colbourne College Unit 33 lecture PDF** (saved in-tree at
`references/fares/Colbourne-College-Airfares-Ticketing-Unit33.pdf`;
third-party IATA-derived training material, same bar as the Zenon
PDFs) gives the full **14-step one-way fare construction sequence**:

  1. FCP — establish fare construction/break points
  2. NUC — take the OW NUC origin→destination per global indicator
  3. SR — if Specified Routing applies, skip mileage, NUC = AF
  4. MPM — establish max permitted mileage (per global indicator)
  5. TPM — sum ticketed-point mileages, compare to MPM
  6. EMA — deduct Extra Mileage Allowance if any
  7. EMS — if over, divide TPM by MPM (5 decimals) and surcharge:

     | TPM/MPM over | up to | surcharge |
     |---|---|---|
     | 1.00000 | 1.05000 | 5% (5M, ×1.05) |
     | 1.05000 | 1.10000 | 10% (10M, ×1.10) |
     | 1.10000 | 1.15000 | 15% (15M, ×1.15) |
     | 1.15000 | 1.20000 | 20% (20M, ×1.20) |
     | 1.20000 | 1.25000 | 25% (25M, ×1.25) |
     | — | over 1.25000 | break the fare (use combination) |

  8. HIP — check three comparison sets:
     (1) unit origin → each intermediate stopover point
     (2) intermediate stopover point → another
     (3) intermediate stopover point → unit destination
  9. BHC — backhaul check when origin→stopover fare > origin→
     destination fare: OWM = HI + (HI − LO)
  10. Stopover/transfer charges (converted to NUC at IROE)
  11. Q surcharges (converted to NUC at IROE)
  12. Total NUCs
  13. IROE — multiply by rate of country of commencement
  14. LCF — round per the currency's rounding unit

This composes exactly with chunk 27's NUC module (steps 13-14 are
implemented; steps 4-9 are now implementable with synthetic TPM/MPM
seed data).

### Display ranking — 🟢 EU-mandated neutral ranking IS public law

**Regulation (EC) No 80/2009** (CRS Code of Conduct), Annex I —
full text on EUR-Lex. The *commercial* alliance-preferenced ranking
remains opaque, but the EU mandates a NEUTRAL principal display that
every CRS operating in the EU must implement, with verbatim ranking
criteria:

  (i) non-stop travel options ranked by departure time
  (ii) all other travel options ranked by elapsed journey time

Plus: ranking "shall not be based on any factor directly or
indirectly relating to carrier identity"; no travel option featured
more than once (limited code-share exceptions); best-ranked train /
air-rail service on the first screen when offered for the city pair.

For an emulator, the neutral display is the RIGHT thing to implement
— it's what a compliant CRS shows by default, it's legally specified,
and it sidesteps the unpublishable commercial ranking entirely. Our
current availability sort (nonstops by departure time, then
connections) is already close; making elapsed-journey-time the
explicit connection sort key + documenting the Annex I citation
closes it.

## Summary table (updated after the second dig)

| Item | Public-source status | Implementable now? |
|---|---|---|
| NUC/ROE rounding | 🟢 documented | ✅ chunk 27 |
| HIP algorithm | 🟢 documented (CAT17 + Unit 33) | Yes — needs synthetic TPM/MPM seed |
| MPM/EMS mileage system | 🟢 bracket table verbatim | Yes — same seed |
| BHC backhaul check | 🟢 formula verbatim | Yes |
| MCT exception layering | 🟢 model documented | ✅ chunks 26+28 |
| Real OAG MCT data | 🟡 licensed only | No (paid API) |
| Real IROE table | 🟡 licensed only | No (IATA subscription) |
| EU neutral display ranking | 🟢 Annex I verbatim | Yes — small sort change |
| Alliance commercial ranking | 🔴 opaque | No — but the EU neutral display is the documented alternative |
| FFA/FFR/FFU/FFD | 🟢 fully documented | ✅ chunk 25 |

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
