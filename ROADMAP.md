# Roadmap

Tracks planned work beyond v1. Formats cite
`references/Sabre-Basic-Reservation-Course.pdf` (workbook line numbers in the
extracted text where useful). Items move from here into code + tests; check
them off as they land.

## v1.1 — Core PNR lifecycle depth (done)

Making the happy path feel like a real GDS, within the existing architecture.

- [x] **Multi-passenger names** — `-2MURRAY/FRED MR/HANA MRS` (count + multiple
      given names per surname); multiple name items via separate `-` entries.
      Display: `1.2MURRAY/FRED MR/HANA MRS   2.1SMITH/JUNE`.
- [x] **Cancel** — `X1` (segment), `X1/3` (multiple), `X1-3` (range), `XI`
      (entire itinerary), `XIA` (all air). Renumber remaining segments.
- [x] **Change segment status** — `.1HK` (allowed codes: BK BL DS GK GL HK HL YK).
- [x] **Display sub-sections** — `*N` names, `*I`/`*IA` itinerary, `*P` phones,
      `*T` ticketing, `*A` all (redisplay current AAA, no state change).
- [x] **Similar-name list** — when `*-SMITH` matches >1 PNR, show a numbered
      list. (Selecting from the list: deferred below.)

### Deferred out of v1.1 (still core, but later)

- [x] **Field change/delete key `¤`** — change/delete name, phone, ticketing,
      received-from by line: `-1¤JENSEN/KURT MR`, `91¤214-555-2121-H`, `-¤`,
      `91-3¤`, `91,3¤`, `7¤TAW17FEB/`, `6¤JENS`. Chains with `§`. Passenger-level
      refs (`-1.1¤`) and name-reference data (`¤*`) now supported (see SSR/OSI
      section for the reference number).
- [x] **Pick from similar-name list** — `*<n>` picks line N from the list
      cached by a prior `*-SMITH` that matched >1 PNR. Source-grounded in the
      Sabre Basic Reservation Course ("Display specific PNR from similar name
      list" — format `*(PNR list number)`, example `*3`). Cache lives on the
      work area, cleared on selection / reset / new search.
- [x] **Infants** — done (see SSR / OSI section): `-I/` name field + `3INFT` SSR.
- [x] **Passive cancel** — `.(segment selection)XK` (e.g. `.1XK`, `.1-3XK`,
      `.1/3XK`), source-grounded against the Sabre Basic Reservation Course
      ("Passively cancel segments, no message sent to the airline"). Modeled
      as a separate `PassiveCancelEntry` kind so XK doesn't have to masquerade
      as a status code on `SegmentStatusEntry`. Whole-itinerary form (XI/XIA)
      has no passive analog and isn't supported.
- [x] **Cancel & rebook in one entry** — both source-grounded forms from
      Sabre Basic Reservation Course: `X<sel>¥0<seats><class><line>` (cancel +
      sell from CPA, e.g. `X3¥01F1`) and `X<sel>¥00<date>` (cancel + resell
      same flight on new date, e.g. `X1¥0025APR`). On rebook failure the
      cancel still stands (Zenon course note — agent recovers via `IR`).
      Multi-segment date rebooks (`X1-3¥0024JUN`) and XIA delta forms
      (Zenon-only) are open as a follow-up.

## Fidelity pass (done, except one item the source can't settle)

- [x] Day-of-week — single-letter Sabre convention (S M T W Q F J; Q=Thu, J=Sat),
      matching the workbook sold-segment line. `session/handlers/context.ts`.
- [x] Sold-segment `/E` end-item marker, 12-hour times, letter DOW.
      `protocol/serializer.ts`.
- [x] Signature line at the foot of a committed PNR
      (`A0UC.A0UC*4321 1257/24MAY26 YDTWOE`), plus the sign-in response screen
      and the `SO` / `SO*` sign-out strings — all workbook-grounded.
- [x] Record-locator character set — all-alpha, matches `VZRAFH` / `5UXHHO`.
- [x] **End-transaction error wording** — pinned against the *Sabre Basic
      Course* (Ed. 1.0, p.53), captured in `references/sabre-eot-error-responses.md`.
      `NEED PHONE FIELD - USE 9` and `NEED TICKETING/TIMELIMIT - USE 7 OR 8` are
      verbatim; `NUMBER OF NAMES NOT EQUAL TO RESERVATIONS` is now enforced.
      The source list has no received-from / no-names / no-itinerary message.
      Cross-checked against three Sabre training docs (workbook Ed 2.7, Basic
      Course Ed 1.0, Zenon Reservation Course Rev 08) — none quote those three;
      they only state the behavior ("impossible to end"). Confirmed they live
      only in login-gated Format Finder, so those stay reconstructed-and-flagged
      in `constants.ts`. Behavior (rejecting on them) is correct.
  - [ ] Wire remaining verified strings when their features land: `NO CHANGES
        MADE TO PNR`, simultaneous-changes (`IR`), `VERIFY ORDER OF ITINERARY
        SEGMENTS`, infant SSR.
- [x] Time format + day-of-week aligned to the guides: the **sell echo** uses
      12-hour + letter DOW (workbook "EXAMPLE SOLD SEGMENT"); **availability**
      and the **stored itinerary display** use 24-hour + numeric DOW (workbook
      "EXAMPLE OF BASIC PNR" / Zenon).
- [x] Next-day arrival rendering on overnight segments — sell echo
      `800A 16JUN T/E` (12h + letter), itinerary `0800 16JUN 2 /E` (24h + numeric).
- [x] Phone field shows a city — explicit (`9NYC305-…`) or the agency home city
      prepended on display (`1.NYC305-555-1212-H`, per workbook `1.LOS080-…`).
- [ ] Spaced-vs-concatenated carrier+flight (the guides differ: workbook
      `IB6840F`, Zenon `MA 225K`; we use spaced). Left as-is — sources conflict.

## SSR / OSI

- [x] **Foundation** — SSR (`3<CODE>` / `4<CODE>`) and OSI (`3OSI` / `4OSI`)
      modeled on the PNR, with passenger association via a name reference
      (`3VGML-1.1`), carrier default YY (or AA for sigil 4), and display
      (`SSR VGML YY NN -1.1`, `OSI DL HAS BROKEN LEG`). Survives commit/retrieve.
- [x] **Infant** — infant name field `-I/ADAMS/MARY` (and multiple
      `-I/3OBI/MARY/JUNE/BRANDON`), shown as `I/1ADAMS/MARY` and excluded from
      the seat count. The infant SSR `3INFT/.../DOB-1.1` parses via the SSR
      foundation.
- [x] **Name reference number** — add `-SMITH/LAUREN*5467` (printed, not
      transmitted), change/delete via `¤*` (`-1¤*AN9999`, `-1¤*`), at item or
      passenger level (`-1.2¤*ABC`).
- [ ] Segment-specific SSR (entry format not cleanly pinned in the workbooks)
      and explicit per-SSR carrier.

## PNR optional fields

- [x] **Remarks (`5`)** — general `5<text>`, form-of-payment `5-CASH`,
      historical `5H-…`; shown under `REMARKS` (`*P5`); change/delete by line
      via `¤` (`51¤NEW`, `52-3¤`). Survives commit/retrieve.
- [x] **Time Limit / option (`8`)** — `86P/17JUN` stored as an option field,
      shown `OPTION - 6P/17JUN`, overwrite on re-entry. (Thinly documented;
      auto-cancel not simulated — no wall clock.)
- [x] **Frequent Flyer (`FF`)** — add `FFBA2345678-1.1`, change `FF1¤…`,
      delete `FF1¤`; passenger-associated; shown under `FREQUENT FLYER` (`*FF`).

## PNR operations

- [x] **Move / insert segments** `/0/2` (to front), `/3/1`, `/0/2-4` (range) —
      reorders the itinerary and renumbers.
- [x] **Divide** `D2.1` / `D1` / `D3.1*4.1` + **File** `F` — splits passengers
      into a new pending PNR (copy of the itinerary + `DIVIDED FROM` remark),
      stashes the remainder; `F` files the new PNR (locator), cross-refs the
      original (`DIVIDED TO`), restores it. `6P§F` chains. Range `D1.2-3.2`
      deferred.

## Keyboard & special keys (done)

- [x] Keyboard mapping (workbook p.3 "Other Identification Code Keys"):
      physical-key aliases `[`→`¤`, `\`→`§`, `'`→`¥` normalized in
      `protocol/keyboard.ts`; real glyphs accepted too.
- [x] **End-item** (`§`) chaining — one transmission runs several entries in
      sequence (build a whole PNR in a line), halting on the first error and
      showing only the final screen state.
- [x] `¤` change/delete behavior (see "Field change/delete key" below).
- [x] `¥` cross-of-Lorraine — used as the availability preferred-airline
      separator: `1…¥AA`, multi-carrier `1…¥UADLB6`. Other `¥` separator uses
      (e.g. fare entries) remain out of scope until those features exist.

## Richer availability & sell

- [x] Availability **time qualifier** (`115JUNJFKLAX1200` → start at/after) and
      **class qualifier** (`…-F` → only flights with that cabin). Seed inventory
      enriched to 7 flights so both bite.
- [x] **Waitlist** from availability `01V2LL` (status LL, no inventory draw,
      → HL at end transaction, per Zenon course p.13).
- [x] **Long/direct sell** by flight number `0BA074Y14FEBLOSLHRNN2` (status NN;
      times filled from the schedule when known).
- [x] **Passive** `0VS651Y...GK1*AB123C` (GK/BK + airline locator) and **open**
      segments `0AFOPENJ9JULLOSCDGDS2`.
- [x] **Connections** — inventory auto-builds two-leg itineraries via a hub
      (45-min min-connect) when no nonstop exists; legs share a `connectionGroup`.
      Sell with `*` (full connection, same class) or explicit pairs `01Y1F2`
      (per-leg class); waitlist multi-leg supported. Seed: JFK-SFO via ORD/DEN.
- [x] **Carrier** (preferred-airline) qualifier `¥AA` / `¥UADLB6` — filters
      nonstops and online connections (see "Keyboard & special keys").
- [x] Availability **scroll** `1*` / redisplay `1*R`, **return-date**
      (`1R25JUN` / `1R¥15`), **connecting-city** (`1…JFKSFOORD`), and
      **direct-only** (`/D`) qualifiers.

## Flight information / verify

- [x] **FLIFO / verify** — `2<carrier><flight>/<date>` and `V*<carrier><flight>/<date>`
      (by flight number), `VA*<line(s)>` (from availability), `VI*<seg(s)>` / `VI*`
      (from the itinerary). Read-only display: city pair, 24h dptr/arrv, equipment,
      elapsed (overnight-aware). Meals/miles/smoking columns not modeled.
- [x] Verify minimum connecting time (`VCT*`) — checks consecutive connection
      segments against the 45-min minimum; verified response strings.

## v2 — Pricing & fares

Grounded in `references/Sabre-Basic-Pricing-QR.pdf`.

- [x] **`WP` price-as-booked + `WP*` redisplay** — fare engine (`pricing-handler.ts`)
      sums per-segment base fares from a tariff seed (`store/tariff.ts`), adds a
      simple tax model (US 7.5%, XF 4.50/seg, AY 5.60), totals for the
      seat-occupying passengers (ADT), and renders the fare quote. Cached on the
      work area for `WP*`. Pricing is a query (no state change).
- [x] **Bargain finder** — `WPNC` (advise the lowest available class), `WPNCS`
      (ignore availability), `WPNCB` (rebook the lowest class: updates the PNR
      classes + inventory). Searches the tariff's classes per segment.
- [x] **Passenger types** `WPPADT/C05/INF` — a fare block per type (ADT full,
      child `C…` 75%, infant `INF` 10% + XF/AY exempt); grand TTL across types.
- [x] **Segment selection** `WPS1-3/5` — price only the chosen segments.
- [x] **Qualifiers** via a unified `¥`-separated parser: name `¥N1.1`,
      validating carrier `WPALH`, currency `WPMEUR` (label only), tax exempt
      `WPTN` (all) / `WPTE` (taxes only, keep fees), combos `WP¥S1¥MEUR`.
      Folds the existing `P`/`S`/`RQ` qualifiers through the same path.
- [ ] Negotiated / account / exclude qualifiers (`WPI`/`WPAC`/`WPXP`/`WPXR`/
      `WPXA`/`WPPL`/`WPPV`/`WPB`/`WP¥TC`) — rejected as FORMAT; need fare-rule
      and currency-conversion modeling we don't have.
- [x] **Stored fares (PQ records)** — `PQ` stores the last quote (one record per
      passenger type), `WPRQ` prices + stores in one entry, `*PQ` / `*PQ<n>`
      displays them. Records live on the PNR (survive commit/retrieve), up to 99.
      Grounded in `references/Sabre-Fares-and-Pricing-Course-Zenon.pdf`.
- [x] **Fare-calculation line** in the quote + `WPDF` / `WPDF*` / `WPDF<n>`
      display (per-passenger-type construction `JFK AA LAX245.00Y14 … 490.00 END`).
- [ ] Validating-carrier alternates, OB/baggage fees, `LAST DAY TO PURCHASE`
      (needs fare rules), name qualifier `¥N…`, manual PQ (`PQM`), PQ delete,
      ticketing from PQ (v3). Through-fare `X/` construction + NUC/ROE (intl).

## v3 — Queues & ticketing

- [x] **Queue place / access / work** — `QP/<q>[/<pic>]` places the on-screen
      committed PNR, `Q/<q>` accesses (pulls the first PNR), `*Q` shows the
      current queue depth, `QR` removes + advances, `QX/QXI/QXE` exits. Queues
      live at the PCC level (`HandlerContext.queues`, locator lists) so they
      survive end-transaction and are shared across work areas; working a queue
      uses the `DISPLAYED → DISPLAYED` RETRIEVE self-loop. The queue
      prompt/confirmation strings are reconstructed (the course documents the
      entries, not the host responses).
      - [x] Branch-PCC general queues (`QP/2EA0G`) — already worked transparently
            (queue IDs are opaque alphanumeric); the explicit new piece was
            **multi-target chained placement** (`QP/G¥S¥T`, `QP/2EA0G¥5OT0S¥A`,
            up to 9 addresses per source).
      - [x] **Exit-and-redisplay** — `QXIR` (ignore + exit + redisplay) and
            `QXER` (end-tx + exit + redisplay). QXER returns control to the
            agent inside the queue context if end-tx rejects on a missing field.
      - [x] **Skip** — `QBI¥N` and `QBI-N` move a per-WorkArea queue cursor
            without mutating the list, matching the source's "ignores" (vs
            "removes") wording. Backward navigation goes back to PNRs that
            were previously skipped. Implemented via a cursor refactor of the
            queue handler: QR/QL/QU splice at cursor, QBI moves cursor.
      - [x] **Re-queue** — `QL` → LMTC, `QU` → UTR, each with an optional
            ≤15-char message logged as a general remark on the PNR per Zenon
            note 1. The source's auto-requeue-after-N-hours timer behavior
            isn't modeled (no wall clock).
      - [ ] **Jump** (`QJ`) — referenced in some queue summaries but not pinned
            in either Sabre PDF; deferred until a source surfaces.
- [x] **E-ticket issuance** — `W¥`/`TTP` issue one e-ticket per seat-occupying
      passenger (pricing as booked or off the last `WP` quote), `W¥PQ<n>` from a
      stored PQ record, `W¥N<item>` for one name field. Each ticket
      (`models/ticket.ts`) gets a 13-digit number (3-digit airline code +
      serial from `ctx.ticketSerial`) and surfaces in the ticketing field
      (`*T`), per the Issue-Tickets QR's `*T` display
      (`TE <number>-AT <pax> <pcc>*<agent> <hhmm>/<date> D|I`). Re-issue is
      blocked once tickets exist. No-PQ / already-issued strings reconstructed.
      - [x] **Source-grounded qualifiers** — `W¥A<carrier>` (validating-
            carrier override → changes the ticket-number prefix), `W¥KP<n>`
            (commission percentage), `W¥K<amount>` (commission flat amount).
            Source: the Basic Reservation Course example `W¥PQ1¥KP0¥ALH`
            (p.6 ICK table footer). All three are ¥-separated qualifiers
            that combine with the existing PQ / N base entries.
      - [x] **W¥S<n>** segment select + **W¥XETR** paper-ticket override
            (`a770d46`). Segment validated against the itinerary; paper
            flips ticket type from `TE` to `TK` per QR p.5.
      - [x] **W¥F<fop>** form of payment (`f82951e`) — all four QR p.2-3
            shapes: cash, check (FCHECK/FCHEQUE/FCK), credit card with
            optional `*E` extended payment or `*Z` approval code inline,
            pre-approved (`F*Z<code>`). Plus the separate `¥CVV<n>`
            credit-card-security qualifier. FOP persists on TicketRecord;
            renders in `*PAC` (lands when *PAC display does).
      - [x] **W¥DP** invoice + ordering enforcement (`8e4b38e`). Catches
            "¥DP qualifier must be last" violations at parse time per QR
            p.1; PQ-must-be-first is enforced implicitly (PQ recognized
            only as base entry).
      - [ ] **Remaining unblocked work** (Issue Tickets QR + siblings):
            multi-PQ `W¥PQ2N1.2¥PQ5N1.3-1.5` (max 4 records, ranges
            ascending), the `*PAC` accounting-data line display
            (commission + FOP live here, *not* `*T`), the `*T` variants
            (`*T/N` / `*TA` / `*TI`) and `WETR*` / `WTDB*` / `DQB*`
            display family, plus refund / exchange flow
            (WFR/WFRT/WTRX, third-party Zenon QREX manual).
      - [ ] **Void** stays the one permanent source gap — no first-party
            Sabre QR documents the standalone `WV` sigil with response
            screens; only third-party reseller cheat sheets do. Void
            responses would land as "reconstructed" if implemented.

## v4 — Aviation-suite integration (optional)

- [ ] BHS check-in retrieves a PNR by locator before generating PECTAB; the
      `AgentTerminal` client is the seam. (Not a current dependency.)

## v5 — Multi-GDS via Dialect ⊥ Backend

The project's name promises more than Sabre. v5 introduces two orthogonal axes
so it can grow into it without faking fidelity. The matrix:

|              | emulated (offline)        | live (real GDS via REST)         |
|--------------|---------------------------|----------------------------------|
| sabre        | ✅ everything today       | — (Dev Studio REST, later)       |
| galileo (1G) | future, oracle-built      | **proven path** via 7K9S         |
| apollo (1V)  | sibling of galileo (cheap)| — (Travelport, separate access group) |
| worldspan(1P)| —                         | — (Travelport, separate provisioning) |
| amadeus      | **viable, format-grounded**| — (separate vendor, no creds)   |

- **Dialect** = parser, serializer, keyboard, screen profile, FSM rules,
  fidelity sources. Pure content. Selected per-tenant.
- **Backend** = where answers come from. `emulated` reads local
  `inventory`/`tariff`/`pnr-store`; `live` translates cryptic ⟷ vendor REST.
- Sabre stays the reference tenant; everything in v1–v3 is its emulated backend.

### Foundations

- [x] **Live-1G feasibility proven** — `chore: validate Travelport pre-prod
      creds for live-Galileo spike`. OAuth `password` grant against
      `auth.pp.travelport.net/oauth/token` returns a 24h Bearer; POST
      `/11/air/catalog/search/catalogproductofferings` with
      `TVP-PCC-CORE: 7K9S_1G` returns a real `CatalogProductOfferingsResponse`
      (10 offers, `DEN→FRA`, sandbox synthetic). `validate-travelport-creds.ts`
      at the repo root is the re-runnable gate.
- [x] **`Dialect` seam** — Sabre's cryptic surface (parser, keyboard, end-item
      splitter, Response constants, error-set) is now behind a `Dialect`
      interface (`src/dialects/dialect.ts`) with `SabreDialect` as the first
      and only implementation (`src/dialects/sabre/`). `GdsHost` owns a
      `readonly dialect: Dialect` and delegates `normalizeKeyboard` /
      `splitChain` / `processEntry` / `isErrorResponse` to it; banner and CRT
      status-bar label both source from `host.dialect`. No SABRE/sabre strings
      remain in `src/` outside `dialects/sabre/`. Landed across three
      atomic-and-reviewable commits, each leaving all 175 tests green:
      `9cb83fa` (relocate Sabre `Response.*` into `dialects/sabre/responses.ts`),
      `d426b86` (`Dialect` interface + `SabreDialect`, unused), `dd257f8`
      (`GdsHost` dispatches via Dialect, banner sourced from dialect).
- [ ] **`Backend` seam + async** — widen `Dialect.processEntry` /
      `GdsHost.process` to `string | Promise<string>` for live REST backends.
      The interface change is one line; the cost is `await` on ~400 test call
      sites across 16 files (mechanical, but voluminous). Deferred until
      `galileo:live` is actually wired — pre-emptively going async pays the
      mechanical cost now for no behavioral win, and the change lands cleanly
      alongside the OAuth client + cryptic→REST mapping when those need it.
- [x] **CLI dispatch** — `npx tsx src/index.ts terminal [sabre|galileo]`
      resolves a name to a Dialect via `pickDialect()` in `src/index.ts`
      (throws on unknown name, so typos exit cleanly). npm scripts
      (`start:terminal:sabre`, `start:terminal:galileo`) added; bare
      `start:terminal` still defaults to Sabre. Backend dispatch (`galileo:
      live` etc.) lands with the async upgrade.

### Galileo (1G) — live backend

The cryptic-to-REST adapter. Inventory and tariff state evaporate — 1G itself
is the source of truth — but cryptic format fidelity becomes the new burden.

- [x] **Galileo cryptic references** — gathered in `references/galileo/` and
      covering 11 of 12 fidelity categories at A-grade: Travelport+ Mini Format
      Guide v2 (canonical), Smartpoint Module 2 (annotated availability + sold-
      segment columns — the only public source with column-by-column
      annotation), Galileo Pocket Guide (legacy queue verbs + worked ticketing
      recipes), the 5-way GDS Format Comparison Guide (Apollo / Worldspan /
      Amadeus Rosetta), and the Travelport Smartpoint Kuwait 2021 mirror
      (segment-status code table the v2 guide dropped). Error wording is the
      one C-grade category — same Format Finder gap Sabre has — mitigable by
      provoking errors against the live REST API and using the few public
      examples as style anchors.
- [ ] **Apollo (1V) as a sibling dialect** — almost free given Galileo: the
      Comparison Guide gives a verb-by-verb Rosetta, and Apollo's conventions
      are closer to Sabre's (`0` sell, `¤` change/delete, `:3`/`:4` SSR/OSI,
      `N:` name) than Galileo's. Same Travelport OAuth path with a 1V access
      group. Not a separate version — a co-build once Galileo lands.
- [ ] **OAuth client** — token fetch, in-memory cache to 24h expiry, single
      refresh on 401. Reads `TVP_CLIENT_ID`/`SECRET`/`USERNAME`/`PASSWORD` from
      env (never on disk); production `auth.travelport.net` swap is one env var.
- [ ] **Cryptic → REST mapping** — minimum viable surface:
      `A` (availability) → `catalogproductofferings`, `0` (sell line N) →
      cache offer refs from search and resolve N → offerRef on `0`, `N:` (name)
      → passenger on the in-flight order, `*R` (retrieve) → order lookup,
      `ER` (commit) → `CreateOrder`. The BUILDING→DISPLAYED FSM choreographs
      the offer/order lifecycle — the avail-cached-on-work-area invariant maps
      almost 1:1 onto "cache offer refs for later resolution."
- [ ] **JSON → Galileo screen rendering** — reconstruct cryptic screens from
      REST responses. Real data, reconstructed presentation (same caveat the
      project already documents for reconstructed strings — just with authentic
      data underneath).
- [ ] **Hybrid coverage, made explicit** — only entries with REST analogs
      (search/price/order/ticket/retrieve) go live. Queue ops, exotic displays,
      host-only functions have no endpoint → return a single, explicit
      "not-supported in `galileo:live`" string. Silent stubs are worse than
      an honest boundary.
- [ ] **Vendor-pacing discipline** — single-worker, jittered delays,
      capture-then-replay for dev iteration. Local response cache so iteration
      doesn't hammer pre-prod. Never probe for limits. (Project rule.)
- [ ] **Sandbox caveats documented** — pre-prod = synthetic inventory, no real
      tickets, trial creds expirable. Make these surface in the banner, not in
      a comment somewhere.

### Amadeus — emulated, format-grounded

A different fidelity claim than Galileo. Amadeus is a separate vendor (no
Travelport-style creds path), so any Amadeus dialect ships fully `emulated` —
the project owns the behavior layer. The references in `references/amadeus/`
cover format and errors *better* than anything publicly available for Sabre,
but public sources are silent on behavior (fare construction NUC/ROE/HIP,
availability simulation, alliance/MCT logic). Honest framing: format-faithful,
behavior-synthesized. Not a successor to Galileo — a parallel option with a
different upside.

- [x] **Amadeus references** — gathered in `references/amadeus/` and covering
      11 of 12 fidelity categories at A-grade in a single artifact: the
      Amadeus Cryptic Entries Reference Guide, Ed. 9.2 (276 pp, 2012, Amadeus
      Global Learning Services). Plus `errors/Predef_Errors_*_*.htm` — the
      official ~10,000-entry Predefined Host Messages dump from
      `api.dev.amadeus.net`, mirrored locally as 10 HTML pages. Verbatim
      error strings with numbered codes (e.g. `400 NO ITINERARY - FINISH OR
      IGNORE`) — exceeds anything publicly available for Sabre or Galileo.
- [ ] **Amadeus dialect (emulated)** — parser, serializer, keyboard, screen
      layout, FSM rules under the same seam as Sabre. Cryptic differs
      meaningfully: `AN` avail, `SS` sell, `NM1` name, `AP` phone, `TKOK`
      ticketing, `RF` received-from, `ET` end, `RT` retrieve, `IR` ignore-
      redisplay; passenger association via `/P1` tail-syntax; `;`-separated
      multi-element entries; status set `HK/HX/KK/KL/NN/UC/UN/NO`.
- [ ] **Behavior layer (the honest hard part)** — no public source documents
      Amadeus's actual algorithms (fare construction, inventory simulation,
      MCT, alliance ranking). The emulator owns these. State the claim in
      the banner: "amadeus emulated; format and error wording source-
      grounded; behavior synthesized." Don't let it look like a real Amadeus.
- [ ] **Screen layouts (B-grade gap)** — the QRG documents *what to send*,
      not what comes back. Annotated screen responses live in the Amadeus
      Service Hub (login-gated) and a 224-pp Travel Agency Basic Functionality
      Course on Yumpu (view-only). Recoverable but assembly-required, unlike
      Galileo's Smartpoint Module 2 which has the column annotations cleanly.
      Acknowledge before shipping.

### Live-as-oracle (bonus, after both Galileo backends exist)

- [ ] Diff harness — fire the same cryptic at `galileo:emulated` and
      `galileo:live`, structurally compare the rendered screens. Live 1G becomes
      ground truth for *building* the emulated Galileo, instead of speculation.
      This is precisely why `Backend ⊥ Dialect` is worth the abstraction.

## Infra / DX

- [ ] `start:terminal:tcp` — drive the CRT over a real socket via `AgentTerminal`.
- [ ] JSON-file persistence backend for `PnrStore`.
- [ ] End-to-end TCP scenario test (host + terminal over the wire).
- [ ] CRT polish: keep the input row's right border intact during live typing.
