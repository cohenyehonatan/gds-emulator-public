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
      - [x] **Multi-PQ range/list** — `W¥PQ2-4/7` (`0b8cdf3`). Enforces
            QR p.1 rules: max 4 records, ranges ascending, sequential-
            order fulfillment regardless of typed order. Per-PQ named-
            selection form (`W¥PQ2N1.2¥PQ5N1.3-1.5`) still open —
            needs the dotted-name parser extension.
      - [x] **`*T` display variants** — all six from the Ticket Display
            Tools QR (`690d6bd`): `*T` / `*T/N` / `*TA` / `*TA/O` / `*TI`
            / `*TI/O`, with the QR's exact active/inactive partition
            (OPEN / ACTL vs everything else) and per-variant default
            ordering (T = oldest-first; TA / TI = newest-first).
      - [x] **`*PAC` accounting field display** — auto-renders one
            accounting line per issued TicketRecord per the QR p.5
            verbatim layout (`faee30f`). Commission and FOP surface
            here, not `*T` — Sabre's data model. Manual `AC/<…>` create,
            `AC¤<n>` delete, `AC<n>/<…>` modify, and `*HAC` history are
            still open.
      - [x] **`DQB*` audit trail** (`98deed3`) — system-wide ticket-
            issuance log iterating ctx.pnrStore. Six entry shapes
            from the QR pinned (today / specific day / previous year /
            branch / combined / two-step delete stub). Report layout
            is reconstructed at the queue-prompt fidelity bar (QR
            documents the entries but punts the layout to Format Finder).
      - [x] **WFR / WFRT refund** (`6373c7f`) — full refund flips
            ticket status REFUNDED so it moves *TA → *TI; tax-only
            records the action but leaves the ticket active pending
            per-coupon adjustments. First code drawn from the third-
            party Zenon QREX manual.
      - [x] **WTRX cancel refund** (`35418c2`) — two-step flow with
            BOTH legs landed verbatim from QREX p.21 (the first
            verbatim QREX strings in code). Pending-ticket state on
            the work area; different-ticket on step 2 resets to step 1.
      - [x] **Refund extras**: `WFR<tkt>¥AGF` agent-fare flag
            (`fb90904`), `WFR<tkt>¥N<dotted-name>` name-selected
            (`4639d41` — pairs with the dotted-name parser also added
            there). `WFR*L<n>` deferred: not actually in QREX, the
            hunter's note appears to have come from a different source
            we can't verify.
      - [x] **Dotted-name parser utility** (`4639d41`) — Sabre's
            `<item>.<passenger>` addressing, supporting single / range /
            list / mixed forms with cross-item rejection. Lives in
            `src/utils/passenger-ref.ts`; unblocks per-PQ named + WFR ¥N
            + future SSR dotted refs.
      - [x] **Per-PQ named selection** (`c4500f5`) — `W¥PQ2N1.2¥PQ5N1.3-1.5`
            verbatim from QR p.1. Detects multi-PQ-with-names by
            "every token matches PQ\d+N…", routes through dotted-name
            parser, enforces max 4 PQs. Handler issues one ticket per
            named ref in two-pass atomic style.
      - [x] **Manual AC create + modify + history**: `AC/<carrier>/<tkt>/…`
            create (`b6a3393`), `AC<n>/<carrier>[/comm]` modify
            (`beb6b83`), `*HAC` history (`12cd250`). Manual lines live
            alongside auto-from-tickets in *PAC numbering; modify
            updates either the TicketRecord or ManualAccountingLine
            depending on which range the line number falls into.
      - [x] **`WETR*` / `WTDB*` document display** (`e09740d`) — all
            eight QR variants (redisplay / by-item / by-ticket /
            enhanced / history × ETR or image family). Coupon lines
            derived from the on-screen PNR's segments; flagged as the
            documented approximation until per-coupon ticket modeling
            lands.
      - [x] **Void (`WV`)** (`174f303`/`b2f85d0`/`2223489`/`01a0660`) —
            all five forms from the Sabre Travel Network Middle East QR
            (Sept 2007) p.13: `WV<n>` (Twice / two-step confirmation),
            `WV‡<13>/<amt>/<fop>/<DDMMM>/<cc>/<n>` manual, `WV*`
            list-month, `WV*DT<DDMMM>` list-day, `WV*DT<from>-<to>`
            list-range. Picked option (a) — imported the EmQuest QR as
            quasi-first-party (published by Sabre Travel Network Middle
            East, a Sabre subsidiary). Entries are verbatim-third-party
            (one tier above pure reconstruction, matching QREX); host
            responses (`OK-VOID`, `RE-ENTER TO VOID TKT`, `TKT ALREADY
            VOIDED`, `NO VOIDS`) are reconstructed at the QREX-voice
            fidelity bar and flagged inline. Same-day cutoff isn't
            enforced (consistent with WTRX — emulator doesn't model
            wall-clock cutoffs).

  **v3 ticketing complete.** Every item in the section above is shipped
  and source-grounded. The only residual reconstruction is in the void
  host responses (no source documents them); entry formats are sourced
  for every verb. 309/309 tests green.

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
- [x] **`Backend` seam** (`c863934`/`71f7438`) — synchronous interface in
      `src/backends/backend.ts` exposing `inventory`, `pnrs`, `queues`, and
      `nextTicketSerial()`. `EmulatedBackend` (the v1-v3 behaviour) is the
      default; `new GdsHost({ backend: ... })` accepts an injected one.
      Every handler reads `ctx.backend.X` — no direct imports of `Inventory`
      or `PnrStore` from handler files. 314/314 tests still green after
      the refactor, so the seam is provably non-disruptive.
- [x] **`Backend` seam — async upgrade** (`8b03edc`) — `GdsHost.process`
      returns `Promise<string>` and `Dialect.processEntry` widened to
      `string | Promise<string>`. EmulatedBackend dialects stay sync
      internally; live ones return promises. Cost: bulk `await` on ~920
      test sites across 31 files + `async` on the surrounding callbacks
      + helper functions (mechanical sed). All 445 tests still green
      after the migration — pure return-type widening, zero behavior
      change.
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
- [x] **Apollo (1V) as a sibling dialect** (`798df7e`) — `ApolloDialect`
      in `src/dialects/apollo/` shares Galileo's parser + dispatch +
      serializer entirely, with a 3-pattern Apollo→Galileo translator
      applied before parse. Verified against pp.5-18 + 27-30 + 34 of the
      GDS Format Comparison Guide: Apollo and Galileo cryptic overlap
      ~95% (SON/SOF, work-area switching, scrolling, encode/decode,
      queue place/access, retrieve, mandatory + optional fields, SSR/OSI,
      cancel, fare quote, ticketing all IDENTICAL). The three syntactic
      deltas:
      * Reference sell `01Y1` ↔ `N1Y1` (Apollo `0<digit>` → `N<digit>`,
        guarded so direct sells `0AY631...` pass through unchanged)
      * Segment-status change `.1HK` ↔ `@1HK`
      * Avail carrier qualifier `+LH` ↔ `/LH`

      Wired into DialectId + pickDialect + CLI (`npm run start:terminal:
      apollo`). The diff-oracle (see below) gained a `--dialect=apollo`
      flag so Apollo's translator gets real live-traffic regression
      coverage. Same `LiveTravelportBackend` (OAuth + TripServices REST)
      backs both dialects; a 1V access group's PCC code goes in via the
      same env vars.
- [x] **OAuth client** (`b4bc113`) — `LiveTravelportBackend.ensureToken()`
      with in-memory cache + 60s pre-expiry refetch. Reads
      `TVP_CLIENT_ID/SECRET/USERNAME/PASSWORD` from env via
      `liveTravelportFromEnv()` or directly via the constructor. No
      disk writes, no log emission, no network at import or
      construction time.
- [x] **Cryptic → REST mapping — first verb live** (`069dbf9`/`6c432bc`/
      `b0a4e16`) — `A<DDMMM><orig><dest>` now dispatches against
      LiveTravelportBackend via `airSearch()` →
      `mapCatalogProductOfferings()` → `AvailabilityLine[]`. The mapper
      also captures `vendorRef.{offerId,productId,brandId}` so a
      future live sell has the Travelport identifiers it needs. `TTL<n>`
      flight-detail surfaces the offerId on a `TVP OFFER <id>` trailer
      so an operator can confirm which Travelport offer a cached line
      maps to.
- [x] **Cryptic → REST mapping — remaining verbs** (multiple commits
      through 2026-06-06, capped by `03cd43e`) — full PNR-build
      lifecycle end-to-end against pre-prod via
      `validate-galileo-handler-live.ts`:
      * `N<seats><class><line>` sell — `addOffer` against the canonical
        `OfferQueryBuildFromCatalogProductOfferings` body; threads
        workbench-side offer UUIDs via `wa.liveWorkbenchOfferIds`
        (deduplicates connection legs on the (offerId, productId) pair).
      * `N.<name>` — multi-name with delta-aware live posting; first
        N.+P. posts via `/travelers/list` batch, subsequent N. entries
        post just the delta via singular `/travelers`.
      * `P.<phone>` — `addTraveler` (embedded Telephone, per the
        `TELEPHONE IS A REQUIRED FIELD` commit-time rule) + `addPrimary-
        Contact`. Cryptic-strips city/digits before posting.
      * `FQ` — `priceOffer` per unique workbench offer + merged into a
        single FareQuote (multi-offer FQ verified live with 4 fareBasis
        codes from 2 offers, total 1098.60 = 2× single-offer 552.10).
      * `SI.<code>` — `/specialservices/list` with `TravelerIdentifier`
        from `wa.liveTravelerIds` and per-segment `segmentRef` (S<n>).
      * `X1` / `XI` cancel — routes to `cancelitems` with
        `cancelAllInd: true` when cancelling everything in the workbench,
        per-offer `canceloffer` otherwise. Pragmatic fallback handles
        the trial-tenant's per-offer authorization gap.
      * `@<n>XK` passive cancel — `canceloffer` with
        `sendPassiveNotificationInd: true`.
      * `TKP` — local ticket records + sets 0% commission on the build
        workbench (per the canonical commission-by-passenger flow).
      * `ER` — `commitWorkbench` with the wrapped build body produces a
        real 6-char locator; post-commit ticket-issuance dance fires
        canonically (buildfromlocator → setCommission → addFOP →
        applyPayment → preTicketReview → commit with the flat ticket
        body). Trial-tenant `documentoverrides` silently no-ops →
        tickets gated on production tenant access.
      * `*<locator>` retrieve — live REST GET, walks
        `Reservation.Offer[].Product[].FlightSegment[].Flight` to
        produce mapped segments (fixed real shipping bug in mapper).
      * `*-<surname>` — local `pnrStore` shadow mirrored at commit time.
      * `QEB/<n>` queue place + `Q/<n>` queue access — both live-
        verified against pre-prod 2026-06-06.

      For Apollo 1V (next dialect), the template stays the same:
      live class method + response mapper + dispatch instanceof
      discrimination + mocked tests + env-gated REPL verifier.
- [x] **JSON → Galileo screen rendering** (`069dbf9`) — established by
      `mapCatalogProductOfferings` + `renderGalileoAvailability`. The
      same dialect serializer renders the emulated and live responses
      identically; only the source-of-truth differs. Pattern extends
      to the remaining verbs as their mappers land.
- [x] **Hybrid coverage, made explicit** (`3b8fde1`) — three verbs with no
      v11 REST equivalent (verified against the GDS reference-payload
      devkit) now append `[LOCAL VIEW ONLY — no v11 REST equivalent]` to
      their response when running on a live backend:
      * `@<n>HK` segment-status manual override (no agent-override
        endpoint; Travelport's model is server-driven via async carrier
        notifications)
      * `*H` / `*HI` / `*HFF` / `*HNP` history display (only
        `POST /documents/history` exists and it's ticket-scoped)
      * `*-<surname>` retrieve (surname search is "GDS-host-only" per the
        spec; we serve from a session-local pnrStore shadow)

      Emulated backend doesn't append the trailer (the local store IS
      authoritative). Error responses (FORMAT, NO_PNR) are exempt from
      decoration. Single helper `appendLocalOnlyTrailer(response, ctx)`
      keyed on `ctx.backend instanceof LiveTravelportBackend`.
- [x] **Vendor-pacing discipline — pacing half** (`e01adcb`) — every
      outbound HTTP request from LiveTravelportBackend serializes through
      a single-worker async chain with a jittered inter-request delay
      (default 200-400ms, override via `opts.pacing`). Failures consume
      a slot too (no burst-retry on stuck endpoints). Disabled
      automatically when `process.env.VITEST === 'true'` to keep the
      mocked test suite fast. Per CLAUDE.md project rule: never probes
      pre-prod's limit; paces conservatively regardless.

      Capture-then-replay cache half is still open — needs a serialization
      format for request+response pairs and a cache-file convention.
- [x] **Sandbox caveats documented** (`9211905`) — REPL banner now
      includes a `── BACKEND: ... ──` advisory block after the dialect
      banner. Emulated mode says "No live REST calls. All state
      synthesized in-process." Live mode surfaces the synthetic-inventory
      + no-real-tickets + known trial-tenant (7K9S) silent-failure gaps:
      `addReservationComment`, `/fromfaredisplay`, `canceloffer`
      per-offer, `documentoverrides` commission. Live ticket issuance
      requires production-tier access. Visible on every REPL start;
      fires for both CRT mode and the line-mode fallback.

- [ ] **Production tenant access** — five live behaviors are wired canonically
      against the GDS reference-payload devkit but provably broken on the 7K9S
      trial tenant via silent-failure (POST returns 200 + UUID, server-side
      state doesn't change):
      * `documentoverrides` commission → ticket-issuance commit rejects with
        `COMMISSION PERCENTAGE MUST BE ENTERED` regardless of what we POST
      * `reservationcomments/list` (the addReservationComment family) →
        generic `1586 / INVALID INPUT FORMAT`
      * `/air/farerule/farerules/fromfaredisplay` → same generic 1586
      * `/offers/canceloffer` per-offer cancel → "Not Authorized to Access
        this API"
      * `CancelSelectedOffers` via cancelitems → 200 OK with empty body but
        offer isn't actually removed (worse than a 4xx because failure is
        silent)
      Wire is correct; verification gated on production-tier credentials.
      Without production access the project is feature-complete against
      pre-prod for everything it can actually exercise.

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
- [x] **Amadeus dialect (emulated) — v1 + v2 + v3**
      (`b6c23cf` / `e549fb5` / `294f177`): AmadeusDialect now covers
      the full PNR build, modify, enrich, and price cycle. Cryptic
      sourced verbatim from pp.5-36 of `references/amadeus/Amadeus-
      Cryptic-Entries-Reference-Guide-Ed-9.2-2012.pdf`. Chain separator
      `;` per the Dialect interface. CLI: `npm run start:terminal:amadeus`.
      * v1 sign-on family: `JI<duty><init>/<sys>`, `JIA<...>`, `JO`,
        `JO*`, `JD`.
      * v2 PNR build cycle: `AN<date><orig><dest>[<time>]` avail, `SS
        <seats><class><line>` sell, `NM1<sur>/<given> <title>` name,
        `AP<phone>-<purpose>` agency phone (A/B/H purpose codes),
        `RF<text>` received-from, `TKOK`/`TKTL<date>` ticketing, `ET`/
        `ER` end-transaction (with mandatory-field check), `IG`
        ignore, `RT<locator>` retrieve.
      * v3 modify + enrich: `NM<n><sur>/<g1> <t>/<g2> <t>...` multi-pax
        same surname, `XI` cancel itinerary (returns seats), `XE<n>
        [,<m>,<a>-<b>]` cancel segment(s) with range syntax, `<n>/
        <status>` modify segment status (MANUAL_STATUS_CODES set),
        `RM <text>` general remark, `RC <text>` confidential remark,
        `SR <code>[<carrier>][/P<n>] [text]` SSR with passenger
        binding, `OS <carrier> <text>[/P<n>]` OSI, `FXP` price the
        booked itinerary (shared fare engine), `FXX`/`TQT` display
        stored quotes.
      * Reconstructed-not-verified strings flagged in the dispatch
        comments (the QRG doesn't show response wordings literally).
      * Honest-boundary stub `NOT IMPLEMENTED — amadeus dialect (v2)`
        for verbs not yet wired (DM MCT, FQD fare display, DH history,
        LOT negotiated space, MD/MU scrolling, etc.).

      v4 progress (in chunks per the dev push pattern):
      * Chunk 1 — queue verbs (`c10cac9`): `QE<n>[C<cat>][D<date>]`
        place + end-tx, `RTQ` display queues current PNR is on.
        Uses composite queue ids so QE8C1D3 is distinct from QE8.
      * Chunk 2 — history display (`7e81324`): `RH` renders
        pnr.history[]. Sell/cancel/name-add/status-change handlers
        now populate the history at mutation time, so RH survives
        end-tx + retrieve.
      * Chunk 3 — fare display (`b802bb1`): `FQD<orig><dest>[/<date>]
        [/A<carrier>]` renders one row per booking class using
        the shared tariff (same `fareFor` Sabre's WP family uses).
      * Chunk 4 — minimum connect time (`71f111a`): `DM<airport>
        [-<airport2>][/<date>]` lookup, `DMI` segment-continuity
        check in current PNR. Returns the emulated inventory's
        MIN_CONNECT_MINUTES constant (45m) — consistent with what
        the auto-connection builder uses.

      Remaining for future chunks: NUC/ROE/HIP fare construction
      (currently Sabre's emulated engine), MCT carrier-specific
      exceptions, alliance ranking. The behavior-layer caveat
      (below) still applies — no public source for these algorithms.
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

- [x] **Diff harness** (`b1566e5`/`9e158cf`) — `validate-galileo-diff-
      oracle.ts` at repo root fires the same cryptic sequence through
      two GdsHosts (emulated + live) and structurally compares each pair
      of responses via a categorize() classifier. Categories: IDENTICAL,
      TRAILER-DIFF, LOCATOR-DIFF, STRUCTURAL, ERROR-EITHER. Exit code
      flips only for UNEXPECTED structural diffs (per-step
      `expectStructural: true` opt-out for intrinsically divergent
      verbs like availability). `--dialect=apollo` swaps in ApolloDialect
      to exercise the translator end-to-end live. First run surfaced
      two real signals: emulated needed DEN-FRA inventory (added —
      mirrors pre-prod's FI 670/520 KEF connection) and the emulated/
      live error wording diverges on N1Y1 (FORMAT vs CLASS NOT AVAILABLE).
      The exit-1 signal makes the harness CI-ready against regression.

- [/] **Calibrate emulated to match live wording** — narrow-target
      calibration in progress. First closed target (`1987e07`,
      2026-06-07): pre-prod returns HTTP 200 with a Result.Error[]
      payload for unknown locators (not 404); `retrieveGalileoLive`
      now matches "RECORD LOCATOR DOES NOT EXIST" + "BOOKING FILE NOT
      FOUND" and translates to `GalileoResponse.NO_PNR`, producing
      IDENTICAL wording on both backends for `*<missing-locator>`.
      Diff oracle gained stateless wording canaries under a fresh
      WorkArea pair so future drift surfaces in CI.

      Remaining targets are intrinsic-divergence cases the harness
      classifies as STRUCTURAL (expected): emulated FORMAT vs live
      CLASS NOT AVAILABLE on N1Y1, emulated synth flight set vs
      live's actual offers on availability. These aren't truly
      wording mismatches — the underlying inventories differ — so
      "calibration" there means broadening the harness's tolerance
      categorization, not changing emulated code.

- [x] **Capture-then-replay cache** (`1fa1d5c`) — second half of
      vendor-pacing discipline. `TVP_CAPTURE=<file>` writes a JSONL log
      of every request+response pair (Authorization headers redacted
      so the recording is shareable); `TVP_REPLAY=<file>` reads pairs
      in order and constructs Responses without going live. Throws
      "recording exhausted" if the run outpaces the file. End-to-end:
      validate-galileo-handler-live.ts records in 29s + 28 exchanges,
      replays in 0.6s with no creds and no pre-prod traffic — 50×
      speedup. `liveTravelportFromEnv()` returns a backend with
      placeholder creds when TVP_REPLAY is set, so verifier scripts
      run from a recording without shell-env setup.

## Infra / DX

- [x] **`start:terminal:tcp`** (`65cccaa`) — drives a remote `GdsHost`
      over TCP via `AgentTerminal`. The server (run via `start:server`
      in another shell) owns the dialect, work area, and PNR state;
      the local terminal is just a line-mode I/O shell. `GDS_HOST` and
      `GDS_PORT` env vars override the localhost:5555 default. v1
      ships plain line-mode; CRT-over-TCP (with the server pushing
      `wa.state()` updates) is a follow-up.
- [x] **JSON-file persistence backend for `PnrStore`** (`5d6979a`) —
      `JsonFilePnrStore` mirrors the in-memory `PnrStore` surface but
      writes the map to a JSON file on every commit (atomic via
      tmp + rename). New `PnrStoreLike` interface lets either drop in
      via `EmulatedBackend({ pnrStore })`. REPL auto-wires it when
      `PNR_STORE_FILE=<path>` is set. Dates serialize as ISO strings,
      Set fields as arrays; loader tolerates missing fields for
      forward-compat. Smoke: REPL session builds PNR `JOKGQV` →
      file written → fresh process recovers it.
- [x] **End-to-end TCP scenario test** (`65cccaa`) — 3 tests in
      `test/transport/tcp-e2e.test.ts` spin up a real GdsHost on an
      ephemeral port, connect AgentTerminal as a client, and run a
      full BF build through the socket (Sabre + Galileo dialects).
      Proves length-prefix framing + Connection lifecycle survive the
      whole BF lifecycle and the dialect seam works over TCP.
- [x] **CRT polish: keep the input row's right border intact during live
      typing** (`b87625c`) — `CrtScreen.redrawRightBorder()` re-emits the
      right `│` at column W of the input row, wrapped in DEC-style save/
      restore cursor (`\x1b7` / `\x1b8`). REPL's CRT mode installs a
      stdin `keypress` listener that calls it after each keystroke
      (deferred via `setImmediate` so readline's own write completes
      first). WRAP_OFF (DECAWM disabled in `CrtScreen.enter`) prevents
      cursor wrap, so without the redraw, typed characters past column
      W-1 pile up and overwrite the border. Verified on macOS Terminal +
      iTerm2 + Ghostty.
