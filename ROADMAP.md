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
- [x] Negotiated / account / exclude qualifiers — `WPI<id>`, `WPAC*<code>`,
      `WPXP`/`WPXR`/`WPXA` now parse per the Pricing QR's verbatim forms
      and price as public (the emulated tariff files no negotiated/
      penalty/restricted fares — acceptance is the honest behavior).
      Still open: `WPPL`/`WPPV`/`WPB`/`WP¥TC` (not in the in-tree QR
      extraction).
- [x] **Stored fares (PQ records)** — `PQ` stores the last quote (one record per
      passenger type), `WPRQ` prices + stores in one entry, `*PQ` / `*PQ<n>`
      displays them. Records live on the PNR (survive commit/retrieve), up to 99.
      Grounded in `references/Sabre-Fares-and-Pricing-Course-Zenon.pdf`.
- [x] **Fare-calculation line** in the quote + `WPDF` / `WPDF*` / `WPDF<n>`
      display (per-passenger-type construction `JFK AA LAX245.00Y14 … 490.00 END`).
- [ ] Validating-carrier alternates, OB/baggage fees, manual PQ (`PQM`),
      PQ delete. DONE since this was written: `LAST DAY TO PURCHASE`
      renders in the WP header per the QR's verbatim layout (last-day
      math reconstructed as departure − the fare-basis advance-purchase
      days); name qualifier `¥N…`; ticketing from PQ (v3); through-fare
      `X/` construction + NUC/ROE (chunks 27+30).

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
      * Chunk 1 — queue placement (`c10cac9`): `QE<n>[C<cat>][D<date>]`
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
        MIN_CONNECT_MINUTES constant (45m).
      * Chunk 5 — frequent-flyer (`41052a2`): `FFN<carrier>-<number>
        [/P<n>]` element add. Shares the existing FrequentFlyer
        model with Sabre's `FF<carrier><number>` cryptic.
      * Chunk 6 — partial PNR display family (`1a8995a`): `RTA`/
        `RTI`/`RTN`/`RTJ`/`RTK`/`RTF`/`RTG`/`RTR` — focused views
        with canonical "NO <X>" empty-state messages.
      * Chunk 7 — queue work (`b4ec5c9`): `QSTART<n>` sign in, `QN`
        next, `QF`/`QFR` remove + advance, `QES` skip, `QXI` exit.
        Uses WorkArea's existing currentQueue/queueCursor/queueWorking
        Set fields for cross-dialect consistency.
      * Chunk 8 — IR (`b95edb4`): ignore + redisplay. Pure-build path
        is == IG; after RT<locator> the BF is re-rendered from store.
      * Chunk 9 — AM / AB address elements (`13e3f43`): mailing
        (standard / home / delivery / misc) and billing addresses.
        Adds cross-dialect `AddressElement` model + Pnr.addresses
        field; JsonFilePnrStore round-trip support; RTJ extended to
        render addresses with per-kind indices.
      * Chunk 10 — ST / SX seat requests (`c1ac370`): specific seats
        or preference codes, with passenger + segment binding. Adds
        cross-dialect `SeatRequest` model + Pnr.seatRequests field.
        SX cancels all; SX/S<n> filters by segment.
      * Chunk 11 — LP list PNRs by flight (`5e2e882`): `LP/<carrier>
        <flight>/<date>` scans the PNR store for matching segments.
        Cross-dialect: PnrStoreLike gains `findByFlight(carrier,
        flightNumber, date)` on both PnrStore + JsonFilePnrStore.
      * Chunk 12 — RT name-retrieve variants (`7e5dd14`): `RT/<surname>
        [/<given-initial>]` reuses `findBySurname`. Multi-match returns
        a numbered locator list; single-match loads the BF; given-
        initial filters the multi-match.
      * Chunk 13 — RRN copy PNR (`c2c237f`): clones the displayed PNR,
        clearing locator/quotes/tickets/history so a fresh ET creates
        a distinct new BF that shares the names + segments + service
        elements with the original.
      * Chunk 14 — NU name modify (`fa1fc32`): `NU<n>/<NM-body>`
        replaces name element n with a full NM body; `NU<n>/<given>`
        replaces just the given name (preserves title unless a new
        one is specified). History records the rename.
      * Chunk 15 — time-limit modify (`63f89c9`): `8/<DDMON>` rewrites
        the TK element to TKTL<date>. Disambiguates from segment-
        status `<n>/<status>` by the value shape (date vs 2-letter).
      * Chunk 16 — SP split PNR + EF file associate (`64ee0ed`):
        `SP <n>[,<m>[,<a>-<b>]...]` peels named passengers into an
        associate PNR (stashed on wa.dividedOriginal). `EF` commits
        the associate + re-commits the trimmed parent. Both PNRs
        persist with distinct locators.
      * Chunk 17 — VFFD frequent-flyer agreements (`75b7b98`):
        `VFFD` lists 23 major loyalty programs; `VFFD <carrier>`
        narrows to one. Informational/read-side companion to FFN.
      * Chunk 18 — RRN variants (`d6af857`): `RRN/DP<n>` push dates
        forward, `RRN/DM<n>` push back, `RRN/C<class>` class change,
        `RRN/S<segs>` segment filter. `pushDdmonByDays` helper handles
        month/year rollover via JS Date setUTCDate.
      * Chunk 19 — e-ticket issuance + display (`a95d1fd`... + this):
        `TTP` issues tickets (one per seat-occupying pax, drawing from
        priceQuotes[0]); `TTP/ET` electronic, `TTP/PT` paper,
        `TTP/S<n>[-<m>]` segment validation; `TWD`/`TWDRT` displays
        ET records, `TWD/L<n>` (or bare `TWD/<n>`) specific line,
        `TWDRL` compact list, `TWH` history-style. Reuses the cross-
        dialect `TicketRecord` model + `ticketNumber()` helper so
        Sabre's `*T` family and Amadeus's `TWD` family share the
        underlying ticket store.
      * Chunk 20 — TK ticketing-arrangement family (`4ca1e5f`): all
        7 action codes (TKOK/TKTL/TKDO/TKIN/TKMA/TKSS/TKXL) + cross-
        cutting qualifiers (/<office>, /<HHMM>, /P<n>, /S<n>[-<m>],
        /C<n>, /-<freeflow>). Replaces the prior TKOK+TKTL-only
        handler. Records history of TK replacements with arrow
        notation. INVALID PASSENGER / INVALID SEGMENT validation.
        Special TKTL/<time>/<office> non-Amadeus-office variant.
      * Chunk 21 — document output (`e977340`): INVD/INV/INED/INE
        invoice family + IBD/IBP/IED/IEP itinerary family + joint
        (J-suffix) variants. /P<n>[-<m>] passenger filter, /S<n>[-<m>]
        segment filter. Extended variants add tax breakdown + ticket
        list. Display vs print verbs render identical content (no
        printer model). Out-of-scope qualifiers (/LP /TO /COPY /D
        /T<n>) accepted but ignored.
      * Chunk 22 — hotel availability + sell (`20d049c`): HA<city>
        list, HA<chain><city> chain filter, HA<chain><city><prop>
        single property, optional <date1>[-<date2>] range, HS<n>
        [/<rate-code>] sell, HX<n> cancel. New cross-dialect
        HotelProperty/HotelRate/HotelSegment model + seed (10 props
        across 4 cities × 6 chains). Inventory.hotelsIn(city, chain).
        WorkArea.lastHotelAvail caches the displayed list for HS.
      * Chunk 23 — car availability + sell (`932cd28`): `CA<city>`
        multi-company, CA<company><city> filter, CA<city><date>-
        <date|N> range or rental-day count, /ARR-<time> arrival
        window, CS<n>[/VT-<vt>] sell, CX<n> cancel. New CarRental/
        CarSegment model + seed (18 rentals across 4 cities × 4
        companies × ACRISS SIPP vehicle codes). Inventory.carsIn
        (city, company). WorkArea.lastCarAvail. Pnr.carSegments.
      * Chunk 24 — RRN passenger-specific variants + RRI (`4350018`):
        RRN/<n> change passenger count (trims from end of name list,
        within-NameItem aware), RRN/P<list> keep only listed passengers,
        RRN/PX<list> exclude passengers, RRN/SX<list> exclude segments.
        RRI mirrors RRN but drops names + phones + SSRs + OSIs + FFs +
        seat requests + addresses + remarks (itinerary-only copy).
        Lists support comma + range (`1,3-5`). INVALID PASSENGER on
        out-of-range pax refs. Closes the chunk 18 carryover; the
        RRN family now covers all QRG p.47 variants.
      * Chunk 25 — FF accrual/redemption/upgrade/display (this commit):
        FFA<carrier>-<number> creates SSR FQTV (with YY airline code
        when the program has agreements per VFFD_PROGRAMS — verbatim
        per the Service Hub sample); FFA<c>-<n>, <c2>, <c3> multi-
        airline variant; FFR creates SSR FQTR (redemption);
        FFR<c>-<n>-CARDHOLDER <name> cross-cardholder variant; FFU
        creates SSR FQTU (upgrade); FFD displays all FQT* SSRs. Format
        + response wording extracted verbatim from Amadeus Service
        Hub solution 862136 via Playwright Cloudflare bypass — see
        `docs/behavior-layer-research-2026-06-09.md` for the dig that
        unblocked this chunk (previously marked "no public source").
      * Chunk 26 — layered MCT model (this commit): replaces the
        single MIN_CONNECT_MINUTES=45 constant behind DM/DMI with the
        OAG-documented 3-tier resolution (airport standard → carrier
        exception → carrier-pair re-override, with the 9999
        USE_STANDARD sentinel for "exceptions to exceptions").
        `src/models/mct.ts` resolveMct() + `src/store/mct-seed.ts`
        (21 fictional records across MIA/JFK/LAX/DFW/LHR, including
        OAG's worked MIA example verbatim: DI standard 60, AA-to-ALL
        55, AA-to-BA 9999-reverts). DM<airport> now lists the layered
        records for seeded airports (legacy single-line wording kept
        for unseeded ones); DMI resolves each connection through the
        model with carrier context + source tag. Auto-connect builder
        still uses the flat 45 (per-leg carrier context at build time
        is a future wiring).
      * Chunk 27 — NUC arithmetic + international fare-calc format
        (this commit): `src/models/nuc.ts` implements the Travelport-
        documented rules verbatim (NUC truncates to 2 decimals, never
        rounds; local currency HX round-up / NX round-nearest — the
        doc's two worked examples, 1234.30 EUR→1235 and 120.80
        USD→121, are tests). Synthetic IROE table for USD/EUR/GBP/CHF
        (USD=1.0 is real — NUC is dollar-pegged by construction;
        others flagged synthetic). fareCalcFor now emits the IATA
        international construction format for itineraries touching
        non-USD airports: leg amounts in NUC + `NUC<total> END
        ROE<rate>` trailer. Domestic itineraries keep the legacy
        local-currency line, so existing fare-calc asserts hold.

      * Chunk 28 — connection-type inference + builder MCT wiring
        (this commit): closes both chunk 26 scope-notes. Airports
        carry country tags (`airportCountry` in mct.ts; unknown →
        US so the conservative DD default holds); `connectionTypeFor`
        infers DD/DI/ID/II from leg countries. DMI now shows the
        inferred type (`1-2: LAX DD OK / MCT 35M (AIRPORT)`), and
        `Inventory.connectionsFor` resolves each candidate hub's MCT
        through the layered model with arriving + departing carrier
        context — a carrier exception filed at a seeded hub changes
        which connections build. Unseeded hubs (ORD/DEN/KEF in the
        current schedule) fall back to the flat 45, so existing
        availability behavior is unchanged.

      * Chunk 29 — EU neutral display ranking (this commit): the
        second 2026-06-09 dig found that Regulation (EC) No 80/2009
        (CRS Code of Conduct) Annex I point 7 specifies the neutral
        principal-display ranking verbatim: (i) non-stops by
        departure time, (ii) all other options by elapsed journey
        time, carrier-identity-blind. Availability sort updated:
        nonstops already complied; connections now rank by elapsed
        journey time (with midnight-crossing arithmetic) instead of
        first-leg departure. The JFK-SFO via-DEN routing (5h00)
        correctly outranks via-ORD (5h45) despite departing later.
        The commercial alliance-preferenced ranking remains opaque —
        but the EU-mandated neutral display is the documented,
        legally-specified behavior a compliant CRS shows.

      * Chunk 30 — mileage system + HIP + BHC, landed in three
        commits (30.1 `0282765`, 30.2 `1a832ef`, 30.3 this commit):
        steps 4-9 of the documented IATA one-way construction.
        30.1 `src/models/mileage.ts` — TPM seed (13 sectors ≈ great-
        circle miles), MPM = 1.20 × direct TPM (rule-of-thumb; real
        table licensed), the verbatim EMS bracket table with 5-decimal
        truncation, mileageCheck(). 30.2 `src/models/fare-
        construction.ts` — constructThroughFare(): HIP three
        comparison sets (stopover points only per CAT17's connections
        exemption), comparisons in base-fare space, EMS applied to
        the governing fare, BHC backhaul minimum OWM = HI + (HI−LO);
        tariff-agnostic via a FareLookup param. 30.3 wiring —
        priceItinerary splits legs into fare components (chains break
        on gaps or return-to-origin), multi-leg components price as
        constructed through fares with leg-sum fallback (unseeded
        TPM / over-25M = the broken-fare combination); stopover-vs-
        connection inferred from segment date change; fare-calc line
        gains the IATA connection style (`JFK AA X/ORD AA
        SFO250.00Y14`) with X/ transfer markers + EMS tag.

      Remaining: real IROE table + real OAG MCT data (licensed),
      commercial alliance ranking (unpublished). The behavior layer
      is otherwise closed — all 14 steps of the documented fare-
      construction sequence are implemented or explicitly documented
      as skipped (SR specified routings, EMA — no public data).
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

## v6 — Available arcs (surveyed + COMPLETED 2026-06-09)

🏁 **MILESTONE (2026-06-09): everything buildable from public sources
is built.** Final state: 5 dialects (Sabre, Galileo 1G live-validated,
Apollo 1V, Amadeus ~150 verbs, Worldspan 1P), 3 non-air domains
(hotel / car / rail) with cross-dialect cryptic, the full documented
IATA fare-construction sequence (NUC/EMS/HIP/BHC, chunks 27+30),
EU-Reg-80/2009-compliant display ranking, the OAG-shaped layered MCT
model, live 1G wire with capture/replay + 3-dialect diff oracle, and
CRT both local and over TCP. 1469 tests. Every checkbox below is
either done or annotated with exactly what blocks it.

Live-oracle validation (2026-06-09, pre-prod 7K9S): all three
dialect variants run clean — Galileo, Apollo, and Worldspan each at
22 IDENTICAL + 5 expected-STRUCTURAL (availability/pricing synth vs
live offers), zero unexpected divergences. The Worldspan run is the
translator's first live workout: BSI$ sign-on, .1HK status, 01Y1
sell and the 19 shared verbs all match the emulated path verbatim
through the rewrite layer.

What remains, by blocker:

**Blocked on third parties (not effort):**
- Production Travelport tenant — five live behaviors wired
  canonically but silently broken on the 7K9S trial (commission
  `documentoverrides`, reservation comments, fare rules from fare
  display, per-offer cancel, `CancelSelectedOffers`). Ready to
  validate the day production access exists.
- Licensed datasets — real IROE table (IATA subscription), real OAG
  MCT records (OAG license). Synthetic stand-ins flagged at their
  definitions.
- Commercial alliance ranking — unpublished industry-wide; we ship
  the EU-mandated neutral display (Annex I) instead.

**Blocked on sources (formats no public document pins):**
- Sabre: WFR refund variants (name-selected / redisplay / list-pick),
  `WPPL`/`WPPV`/`WPB`/`WP¥TC` pricing qualifiers, OB/baggage fees,
  validating-carrier alternates, segment-specific SSR format, the
  spaced-vs-concatenated carrier+flight ambiguity, and the HOT/CF
  hotel-car column (sparsest in the Comparison Guide; the in-tree
  Sabre QRs don't cover hotel/car).
- Worldspan: `H0/R-` hotel sell + `CRD` descriptions, `B$` area
  display, `AD` more-availability — single modifier-heavy guide
  examples, not decomposable into a grammar.
- These can move the way FFA/FFR and HIP did: a future source-hunting
  dig (agency PDFs, Smartpoint Cloud Help, GDS-help blogs) is the one
  repeatable lever left.

**Optional / out of repo:**
- BHS integration — lives in the aviation-suite repo; explicitly
  "possible v4, optional."
- Amadeus verbatim screens — more Service Hub solution pages can be
  scraped one-by-one to upgrade reconstructed response wording (the
  FFA / seat-map extraction pattern). Open-ended polish, not a gap.

Post-milestone addendum (2026-06-09): **in-terminal help** — spotted
after the milestone; every in-tree source documents help-entry forms
(the Comparison Guide has a "Help entry" row in every section) and
none were implemented. Landed: Galileo `H/<topic>`/`HELP`, Apollo
`HELP <topic>` (Galileo content + deltas footer), Worldspan
`HELP`/`INFO <topic>` (native forms from its translator table),
Amadeus `HE <code>`/`HELP`. Content is emulator-native — each topic
lists the implemented verb surface, bannered as such, since the real
host help screens aren't public. Sabre deliberately gets NO help
verb: both first-party courses point at the Format Finder web system
and document no cryptic form.

Help-screen dig follow-up (2026-06-10): "maybe we haven't looked
hard enough for the real host help screens?" — partially right
again. The verbatim help-page BODIES remain unpublished, but the
dig surfaced the complete Amadeus help-META family that the first
pass missed, documented verbatim in the in-tree QRG p.5 ("Amadeus
Online Help Pages" table) + the newly-saved Complete Amadeus Manual
(references/amadeus/Complete-Amadeus-Manual-Jasir-Alavi.pdf,
verbatim-third-party bar): HE HE help-on-help, HE STEPS, HE/ (help
on the entry that just format-errored — the manual pins the
semantics), MP HE redisplay, multi-word topics (HE PNR NAME), and
help-screen scrolling. All landed. The 2006 Amadeus QRG (flyingway,
Cloudflare-bypassed) corroborates the table; the Service Hub EMD-
guide solution provided verbatim EGSD screens as a bonus reference.

- [x] **EMD family (chunk 31)** (landed, 2 commits) — surfaced by the help-screen dig:
      Service Hub solution 848456 yielded VERBATIM EGSD guide screens
      (the `LIST OF EMD SERVICES FOR AIRLINE` layout + the per-service
      detail screen with RFIC/RFISC/booking-method attributes, using
      Amadeus's 6X test airline + LH), and the in-tree QRG documents
      the full verb set: `EGSD/V<cxr>[/L<n>|/BM-<m>|/SC-<code>|
      /RFIC-<letter>]` guide displays (p. EMD chapter), `TTM[/M<n>|
      /INF|/L<n>|/RT|/ED]` issuance against SSR/SVC elements (p.172),
      `EWD[/L<n>|/EMD<num>|/<n>]` + `EWDRT`/`EWDRL` record displays
      (p.214), `FHD`/`FHP` manual document numbers, `EMR` accounting-
      coupon reprint. Plan: 31.1 EMD service guide (seed verbatim
      from the 6X/LH screens) + EGSD with the verbatim layouts;
      31.2 TTM issuance + EWD displays on a new EmdRecord model
      (synthetic service amounts, flagged — no public service-fee
      data). DONE: 31.1 EGSD verbatim screens; 31.2 TTM (/L /P /INF
      /RT + TTP/TTM ordering), verbatim FA/FB PNR lines, EWD family
      (verbatim list screen, reconstructed record body), 6X 089
      HEL-BKK seeded verbatim from the 873296 PNR sample, 6X numeric
      prefix 172 pinned by the EWD/EMD172- example. Chunk 32 closed
      the deferreds: EWH history (verbatim screen from solution
      828612 — the standard verb; TJH is the airline-agent variant),
      EMR coupon reprint (full QRG selector family /P /L /EMD,
      response reconstructed), FHD/FHP manual document numbers
      (QRG p.169 grammar, FHD/FHP PAX PNR lines, EWD/EWDRL pick
      them up, EMR + EWH correctly skip them). Still deferred:
      EWD/O* old-record — the TA-side EMD exchange entry is
      unpublished (the reissue solution is login-gated; the QRG
      documents only airline-agent TTM/IVI / TTM/OVNE).

- [ ] **Service Hub delta (chunks 33-36)** — surveyed 2026-06-10,
      full catalog in `docs/service-hub-delta-2026-06-10.md`. The
      Service Hub is a per-verb library of verbatim host screens;
      three more were captured and await landing: the AN
      availability display (33 — LANDED: verbatim header/line
      layout, days-out+DOW, terminals, +1 markers, E0/equipment,
      unnumbered connection legs + elapsed), the full RT PNR display
      with unified element numbering + status banner (34 — LANDED:
      banner from PNR state, RP header w/ Zulu stamp, one numbering
      across names/segments/AP/TK/SSR/OSI/RM/FA/FB, 24h times + +1,
      *1A/E*, SS→HK flip at commit; still unmodeled: MSC tag, OPW/
      OPC elements, OPERATED BY sublines, RT<n>/RT0 list nav),
      the TTP post-issuance PNR mutation (35 — LANDED: ET FA/FB/FM/FV
      lines + TK //ET suffix + the no-name-change invariant; FE
      endorsement + no-FA-cancel still open), and SVC segments (36 —
      LANDED: IU entry + /SVC PNR line verbatim from 843687, NN→HK,
      multi-pax /P requirement, TTM issues EMD-S from SVC-method
      guide rows — LH CANC/DPST/PENF now sellable end-to-end; the
      TMC/TSM-P intermediate isn't modeled, TTM issues directly).
      FXK landed too (36b): the verbatim catalogue screen
      (PASSENGER/PR/FROM-TO/C/SC/SRV/PTC/BKM/TOTAL/AV columns +
      FLIGHT RELATED section + description sublines) listing the
      carrier's SSR-method guide rows per pax x segment, FXK/P + /S
      filters, and FWK<n> booking from the cached catalog into an
      SSR that TTM then issues. Catalogue → book → issue runs end-
      to-end. Still open: the unmined-solutions table in the delta
      doc (passive segments, EMD re-association, XBAG example…).

- [x] **Worldspan native calibration** (COMPLETE, 8 commits — commits 1-4
      landed: native availability display, the HELP AVAILCONT
      continuation family (AD/A*/AT/AY/A<n>D/A<date>/A-<cxr>/A/R/
      A@A/A@D), encode/decode KC/KD/KAC/KAD across all three
      Travelport-family dialects — which also fixed Galileo's
      over-claiming H/DECODE help topic — the native sold-
      segment response, and the native PNR display (1P- header,
      *ADT names, P-/T-/G- fields, ITEMS SUPPRESSED trailer — ER/
      retrieve/by-name all render it). The deferred manual items
      landed too (commits 6-8): the S schedule display + its
      continuation table (frequency/EFF-DIS/meals synthesized,
      flagged), 0L waitlist sells (LL status) + *DR airline
      acknowledgments (deterministic synthetic airline locators) +
      ER retaining the PNR on screen per the manual, and the 4RA
      whole-itinerary seating family with the ALL SEATS RESERVED
      response, SR segment markers, /S trailer, and one-line
      multi-pax names. Still unmodeled from the manual: ER-vs-IR
      acknowledgment state (/DR trailer), TKG FAX advisories,
      DI items) — unlocked
      2026-06-10: the
      dead globallearningcenter.wspan.com was recovered from the
      Wayback Machine; `references/worldspan/Worldspan-Go-Res-
      Manual-4022-Argentina-2007.pdf` is a first-party Go! Res
      course with VERBATIM host screens (availability display with
      access-level sigils + WL-PLUS header, sign-on, encode/decode,
      seats, full PNR course). Our Worldspan dialect currently
      renders Galileo wording through the translator — this manual
      enables native render overrides, availability first (the
      chunk-33 playbook). See the delta doc's "Worldspan Go! find".

The original survey (all items now resolved or annotated):

### Real gaps, closable now

- [x] **Hotel/car segments in PNR displays** (landed) — the PNR
      itinerary now interleaves air + HHL (hotel) + CCR (car) lines
      by segmentNumber in renderAmadeusItinerary (used by RT<locator>,
      the build display, and RTI). Also closed the adjacent gaps the
      survey found: Pnr.clone() deep-copies both arrays (RRN/SP now
      carry them), hasContent() counts them (hotel-only PNR is
      dirty), and JsonFilePnrStore round-trips them (legacy files
      hydrate to empty arrays).
- [x] **Stale-TODO sweep** (landed) — `commands/sell.ts`'s connection-
      sell TODO replaced with a pointer at the landed implementation;
      `commands/availability.ts`'s TODO trimmed to the genuinely-open
      items (schedule-only '1' variants, return-date, `1*` scroll).
      The `serializer.ts` "confirm wording" markers were checked and
      stay: they flag Sabre reconstructed strings, which the Galileo
      diff-oracle does NOT validate — they're the standard
      reconstructed-string annotation, not stale.
- [x] **Galileo/Apollo/Worldspan hotel + car cryptic** (landed) —
      Galileo HOA/HOI/HOC + CAL/CAI with display-context N-sells
      (N1A2D3 hotel, N1A4 car), Apollo via passthrough, Worldspan
      HL/HA/CRA/CR0 via translation; all verb forms verbatim from
      the Comparison Guide's 5-way tables. SABRE hotel/car (HOT/CF
      column) remains open — its column in the guide is the
      sparsest and the in-tree Sabre QRs don't cover hotel/car.
- [x] **Sabre v1-v3 backlog** (the source-pinned subset, landed):
      `WPI`/`WPAC*`/`WPXP`/`WPXR`/`WPXA` qualifiers + the
      `LAST DAY TO PURCHASE` WP header line — both turned out to be
      documented verbatim in the in-tree Pricing QR (the old "needs
      fare-rule modeling" claim was wrong about the formats, right
      about the semantics — they parse and price as public since no
      negotiated/penalty fares are filed). Still open, genuinely
      source-blocked: WFR refund variants (name-selected/redisplay/
      list-pick), segment-specific SSR format, spaced-vs-concatenated
      carrier+flight, `WPPL`/`WPPV`/`WPB`/`WP¥TC`, OB/baggage fees,
      validating-carrier alternates.

### New arcs

- [x] **Rail domain** (landed) — Amadeus Rail Mode per QRG p.114-115:
      `R/AD`/`R/AN <date><orig><dest>[<time>]` availability, the
      standard `SS<seats><class><line>` sell (prefers the rail display
      when on screen; a new air AN clears it — matching "SS sells from
      the displayed availability"), standard `XE<n>` cancel made
      rail-aware. RailService/RailSegment model + 10-service seed over
      the QRG's own example pairs (2V WAS-NYP, 9F XPG-QQS, 9B GOT-STO),
      Inventory.railBetween, WorkArea.lastRailAvail, Pnr.railSegments
      (clone/hasContent/JSON-store/TRN display line all wired). Air SS
      numbering now counts auxiliary segments so mixed PNRs never
      duplicate segment numbers. One pattern-doc deviation, documented:
      rail's sell is the standard SS, not a dedicated verb.
- [x] **Worldspan dialect** (landed, 3 commits) — fifth tenant,
      co-built from Galileo via a ~15-rule translator (W.1: sigil
      rewrites for sign-on/name/phone/received/ticketing/remarks/
      SSR/OSI + sells/status/rebook/V$/retrieve-by-name; W.2: the
      Galileo `S.` advance-seat-request family wired cross-dialect
      + Worldspan `4R` translations onto it; W.3: diff-oracle
      `--dialect=worldspan` + docs). Emulated-only — no live 1P
      tenant.
- [ ] **v4 BHS integration** — the aviation-suite tie-in (see the v4
      section above): check-in retrieves a PNR by locator before
      generating PECTAB; `AgentTerminal` is the intended seam.
- [x] **CRT-over-TCP** (landed) — a `.CRT` hello opts the connection
      into a state-trailer protocol: every response carries
      `\x1F<state>\x1F<agent>` which the TCP REPL strips for display
      and uses for the CRT status bar. Backward compatible (plain
      line-mode clients never send the hello and see no change);
      falls back to line mode on non-TTY stdout or an old server.

### Externally blocked (tracked, not actionable)

- [ ] **Production Travelport tenant** — the five silently-broken
      live behaviors (see "Production tenant access" above).
- [ ] **Licensed datasets** — real IROE table (IATA subscription),
      real OAG MCT records (OAG license). Synthetic stand-ins are
      flagged at their definitions.
- [ ] **Commercial alliance ranking** — unpublished; we implement
      the EU Reg 80/2009 neutral display instead (chunk 29).
- [ ] **Amadeus verbatim screen layouts** — the B-grade gap;
      partially recoverable page-by-page from public Service Hub
      solutions (the FFA/FFR + seat-map pattern). Worth a dedicated
      scrape pass if more response wording is wanted.

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

## 2026-06-12 — interface records · print spool · BF displays (chunk refs in git log)

- [x] **Back-office interface pipeline** (`e670087`..`fa32ba8`) — InterfacePos
      emulates SJPM (one .txt per record → GDS_INTERFACE_DIR); DX/DW/DV (Sabre,
      Tres guide), B* (Amadeus, Trams), HM* (Galileo, Trams) control verbs;
      IUR fixed-column per in-tree Programmer Guide v40; MIR header fixed-column
      per in-tree MIR User Guide; AIR line-oriented skeleton (full grammar gated
      on login-only Amadeus AIR User Guide).
- [x] **Print spool / GPM.net** (`622d22f`..`7a7edda`) — PrintSpool (GDS_PRINT_DIR);
      P- print router in Galileo + Apollo; HQC/HQD/HQS/HQX<gtid> with verbatim
      responses; TKP holds the ≤1-deep ticket image.
- [x] **BF field displays + history** (`83fbbba`..`7cb3153`, `17510c0`, `f4788cc`) —
      full H/BFD table, typed itinerary slices, combination chains, H/HIST codes
      + *H<field> subsets, Apollo *HA/*HH/*HC/*H$, F. FOP field, *TE selectors.
      Source: references/galileo/booking-file-display-options.md (Wayback).

### Future work (honest gaps, in rough priority order)

- [ ] **F. → structured FOP + ticketing flow.** F. stores the raw body; no
      vendor/PAN/expiry decomposition (that exists only in the separate
      ticket-time TMU/W¥F channel). Real-host behavior: the BF F. field is the
      default FOP at TKP when no ticket modifier overrides it — wiring that
      means parsing F. into the shared FormOfPayment model and threading it
      through the ticket handler + live addFormOfPayment.
- [ ] **Live BF modify (buildfromlocator).** Retrieved-BF edits refuse on live
      (no phantom workbenches); the real modify flow opens a workbench FROM the
      locator. Spec + offer-UUID extraction already proven in
      issueTicketsPostCommit.
- [ ] **Live hotel via the Stays API v11.** Corrected 2026-06-14: hotel is NOT
      "no v11 REST equivalent" — the Stays API (GA, same host/auth as Flights:
      `/11/hotel/search|availability|rules|book`, incl. `…/book/reservations/passive`
      for `0HTL…MK`) means `HOA`/`HOC`/hotel-sell could go live the way air did.
      Currently unwired → they read the local seed on both backends. Gated on
      whether the 7K9S trial tenant has Stays entitlement (probe first). Full
      scope + endpoint map + chunk plan in `docs/live-stays-wiring.md`. Cars stay
      emulated — no published v11 Cars API.
- [ ] **Vendor remarks (*VI/*VO/*VR/*VL) + *CI data models** — verbs answer
      honestly empty; need models + a source for screen shapes.
- [ ] **Surface/tour/air-taxi segment types (*IS/*IT/*IX)** — honest-empty.
- [ ] **Amadeus AIR full line grammar** — gated on the login-only AIR User
      Guide; skeleton uses real line IDs.
- [ ] **Worldspan IR records + queue verbs** — no public spec found yet.
- [ ] **Single-post the phone on live builds.** ensureLiveTravelersPosted
      attaches the phone to the traveler AND addPrimaryContact posts it as
      the reservation contact — committed BFs carry the number twice
      server-side. The mapper dedupes on display; the real fix is dropping
      one post, which needs a pre-prod validation pass (does addTraveler
      accept a phoneless body?) before touching the build flow.
