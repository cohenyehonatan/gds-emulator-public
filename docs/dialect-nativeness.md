# How native are the dialect integrations?

"Native" is **three independent questions**. A dialect can score high on one
axis and low on another, so this doc rates each separately and then gives the
combined verdict. Source for the per-dialect facts: `src/dialects/*`,
`references/*`, and the multi-GDS section of `CLAUDE.md`.

- **Axis 1 — Cryptic surface:** does the dialect own its parser/serializer, or
  borrow another dialect's?
- **Axis 2 — Backend:** do answers come from a real vendor wire, or local
  emulation?
- **Axis 3 — Source-fidelity:** do formats and screen strings trace to a
  first-party reference, or are they reconstructed / synthesized?

## The matrix

| Dialect | Cryptic surface | Backend | Source-fidelity |
|---|---|---|---|
| **Galileo (1G)** | Native (~6.8k LOC, own parser/serializer/dispatch/responses/help/encode-decode) | **Native live** (Travelport REST) + emulated | High — 5 PDFs, 11/12 categories; **live-validated** via diff-oracle |
| **Sabre (1B)** | Native (logic in `protocol/` + `session/handlers/`; `sabre/` is a 241-LOC adapter) | Emulated only | Highest — 11 first-party Sabre PDFs; defines the fidelity bar |
| **Amadeus** | Native (4.3k-LOC `index.ts`, shares nothing with Galileo; chain sep `;`) | Emulated only | High **format** / synthesized **behavior** |
| **Apollo (1V)** | Borrowed — 267-LOC Galileo translator (3 syntactic deltas) | Native live (inherits the 1G wire) | Derived — rides Galileo + Format Comparison Guide |
| **Worldspan (1P)** | Hybrid — translate-in (→Galileo), render-out (native screens) | Emulated only | High **screens** / borrowed **semantics** |

## Axis 1 — Cryptic surface

- **Sabre** — fully native. The reference dialect; parser/serializer live in
  `protocol/` and `session/handlers/`. The `sabre/` dir is a thin (241-LOC)
  `Dialect` adapter onto them.
- **Galileo** — fully native. Its own `parser.ts` / `serializer.ts` /
  `dispatch.ts` / `responses.ts` / `help.ts` / `encode-decode.ts` (~6.8k LOC).
- **Amadeus** — fully native, largest single surface (4.3k-LOC `index.ts`,
  ~160 verbs). Shares nothing with Galileo; chain separator is `;`.
- **Apollo** — borrowed. 267 LOC. Reuses Galileo's parser/dispatch/serializer
  wholesale and pre-translates three syntactic deltas before parse
  (`0n`→`Nn` sell, `.n`→`@n` status, `A…+cxr`→`A…/cxr` qualifier).
- **Worldspan** — hybrid. `translateWorldspanToGalileo()` rewrites ~15 sigils
  into Galileo and dispatches through Galileo's handlers for the shared
  Travelport PNR semantics, but **screens render natively**
  (`renderWorldspanSchedule/Availability/Pnr/SoldSegment/Help`) from the
  first-party Go! Res manual. Evolution rule: translate until a source proves a
  divergence, then go native exactly there.

## Axis 2 — Backend

| Dialect | Emulated | Live (Travelport REST) |
|---|---|---|
| **Galileo (1G)** | yes | yes — full PNR lifecycle against pre-prod (search/sell/N./P./FQ/TKP/SI/cancel/ER/retrieve/queues). Server-side ticket *creation* gated on a production tenant. |
| **Apollo (1V)** | yes | yes — inherits Galileo's `LiveTravelportBackend` (set a 1V PCC); translator gets live coverage via `validate:diff-oracle:apollo`. |
| **Sabre (1B)** | yes | no |
| **Worldspan (1P)** | yes | no — no live 1P tenant. |
| **Amadeus** | yes | no — different vendor, no creds path. |

## Axis 3 — Source-fidelity

All five clear the **12-category fidelity bar** (input grammar, screen layouts,
end-tx rule, error wording, special chars, worked examples, time formats,
pricing, queues, status codes, passenger association, display sub-sections), but
how they clear it differs sharply.

- **Sabre — highest, the reference standard.** 11 in-tree first-party Sabre Inc.
  PDFs. Almost nothing is reconstructed; the known exceptions are enumerated in
  `protocol/constants.ts` (received-from / no-names / no-itinerary EOT
  rejections, queue host screens, no-PQ ticket responses, WV void screens).
  Weakest category: error wording (Format Finder gap).
- **Galileo — high, and the only one with a live oracle.** 5 PDFs covering
  11/12 categories. Fidelity is **empirically validated against pre-prod**: 22
  stateless wording probes in the diff-oracle all categorize IDENTICAL vs the
  live host — proof no other dialect has. Weakest category: error wording (same
  gap as Sabre, partially mitigated by provoking live errors).
- **Amadeus — split verdict.** *Format* fidelity is A-grade: the 276-pp Cryptic
  Entries Reference Guide (11/12 categories in one PDF) + Amadeus's own
  ~10,000-entry Predefined Host Messages dump, augmented by Service Hub pages
  with verbatim host screens (AN availability + RT PNR display calibrated to
  published samples). But the **behavior layer has no first-party source** —
  NUC rounding, EMS brackets, HIP/BHC, layered MCT, EU ranking were landed from
  public *secondary* sources; real IROE/OAG data + commercial alliance ranking
  remain unmodeled. So: format-faithful, behavior-synthesized, and flagged as
  such in code.
- **Worldspan — high on screens, borrowed on semantics.** Native screens
  calibrate against the first-party Go! Res manual 4022 (Wayback-recovered:
  availability, schedule, sold-segment, PNR display, seating — verbatim). The
  semantics underneath are Galileo's (shared Travelport PNR model); the input
  grammar traces to the Comparison Guide's Rosetta.
- **Apollo — derived fidelity.** No standalone reference corpus; fidelity is
  inherited from Galileo plus the 3 deltas documented verbatim in the Format
  Comparison Guide. Its trust rests on Galileo's. The translator gets real
  traffic coverage via `validate:diff-oracle:apollo`.

## Bottom line per dialect

- **Galileo** — native on all three axes, and the only one whose fidelity is
  proven against a live host. The flagship.
- **Sabre** — native cryptic + highest source-fidelity (it defines the bar),
  but emulated-only backend.
- **Amadeus** — native cryptic, largest surface, excellent *format* fidelity,
  but emulated-only and behavior is honestly-flagged synthesis.
- **Apollo** — least native on input (a Galileo veneer) and derived fidelity,
  but gets a real live backend nearly for free.
- **Worldspan** — deliberately hybrid: borrowed Galileo semantics under verbatim
  first-party Worldspan screens; emulated-only.

The cleanest summary: **Galileo is the one place all three "native" axes line
up.** Sabre is the fidelity gold-standard but emulated. Amadeus is
native-and-broad but synthesized underneath. Apollo and Worldspan are explicit
translation strategies that lean on Galileo, each going native only where a
source forces it.
