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

- [ ] **Field change/delete key `¤`** — e.g. `91¤<new phone>` change phone 1;
      delete a field by index. (Fiddliest modify; lowest urgency.)
- [ ] **Pick from similar-name list** — entry to select line N after `*-SMITH`.
- [ ] **Infants** — `-I/3OBI/MARY/JUNE/BRANDON`; `3INFT/ANDY/MARY/09JAN11-1.1`.
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
- [ ] **`NEED …` end-transaction error wording** — the one open item. The
      workbook teaches the PRINT rule but never prints the literal rejection
      strings, so these stay reconstructed (flagged in `constants.ts`). Needs
      Format Finder or a live screen to verify.
- [ ] Exact itinerary column widths + next-day arrival-date rendering (the
      workbook mixes 12h/24h and spaced/concatenated carrier+flight across
      sections; current output follows the sold-segment example). Low priority.

## Richer availability & sell

- [ ] Availability scroll `1*`, return-date, connections, schedule-only display.
- [ ] Long sell by flight number — `0BA074Y14FEBLOSLHRNN2`.
- [ ] Waitlist `…LL`, passive `GK`/`BK`, open segments `0AFOPENJ9JULLOSCDGDS2`.

## v2 — Pricing & fares

- [ ] `WP` fare quote; stored fares (`WPNCB`, …); fare display.
- [ ] Fare engine + tariff seed (`models/fare.ts`, `store/tariff.ts`).

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
