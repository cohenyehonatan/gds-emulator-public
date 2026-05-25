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
- [ ] **Pick from similar-name list** — entry to select line N after `*-SMITH`.
- [x] **Infants** — done (see SSR / OSI section): `-I/` name field + `3INFT` SSR.
- [ ] **Passive cancel** — `.(segment selection)XK`.
- [ ] **Cancel & rebook in one entry** — `X1¥0(seats)(class)(line)`, `X1¥00(date)`.

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
- [ ] Availability **scroll** `1*`, **return-date** (`1R¥15`),
      **connecting-city**, and **direct-only** (`/D`) qualifiers.

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
- [ ] Name selection `¥N1.1` and `¥`-separated qualifier combinations
      (`WPPC03¥S2/4¥N1.2`); other WP qualifiers (WPI/WPAC/WPM/WPT*/WPA/WPB).
- [x] **Stored fares (PQ records)** — `PQ` stores the last quote (one record per
      passenger type), `WPRQ` prices + stores in one entry, `*PQ` / `*PQ<n>`
      displays them. Records live on the PNR (survive commit/retrieve), up to 99.
      Grounded in `references/Sabre-Fares-and-Pricing-Course-Zenon.pdf`.
- [ ] Fare-calc display `WPDF`, validating-carrier alternates, OB/baggage fees,
      name qualifier `¥N…`, manual PQ (`PQM`), PQ delete, ticketing from PQ (v3).

## v3 — Queues & ticketing

- [ ] Queue placement/count/work (`QP`, `Q/`, `QC`).
- [ ] E-ticket issuance (`W‡`/`TTP`), ticket records (`models/ticket.ts`).

## v4 — Aviation-suite integration (optional)

- [ ] BHS check-in retrieves a PNR by locator before generating PECTAB; the
      `AgentTerminal` client is the seam. (Not a current dependency.)

## Infra / DX

- [ ] `start:terminal:tcp` — drive the CRT over a real socket via `AgentTerminal`.
- [ ] JSON-file persistence backend for `PnrStore`.
- [ ] End-to-end TCP scenario test (host + terminal over the wire).
- [ ] CRT polish: keep the input row's right border intact during live typing.
