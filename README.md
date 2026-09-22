# gds-emulator

A multi-dialect **GDS host emulator** — cryptic-entry parsing, an AAA
work-area session FSM, the core PNR lifecycle, and four implemented
dialects (Sabre, Galileo 1G, Apollo 1V, Amadeus). Same
TypeScript/ESM stack as a companion printer emulator: table-driven
state machine, pluggable TCP transport, command-handler registry,
declarative scenarios, and a reference counterparty.

Where a printer emulator emulates a **device** (an ATB printer) driven by a
host, this emulates the **host** (the GDS) driven by an **agent
terminal**.

> **Educational project.** A learning-focused emulator of GDS host
> behavior. It generates responses locally and is not affiliated with,
> and does not redistribute the documentation of, any GDS vendor.

## Run

```bash
npm install
npm run dev                       # demo: host + terminal + booking scenario
npm run start:server              # GDS host only (TCP, port 5555)
npm run start:terminal            # full-screen green-screen CRT (line-mode fallback off-TTY)
npm run start:terminal:sabre      # explicit Sabre dialect
npm run start:terminal:galileo    # Galileo (1G), full PNR lifecycle + live wire
npm run start:terminal:apollo     # Apollo (1V), co-built from Galileo via translator
npm run start:terminal:amadeus    # Amadeus, emulated, v1-v4 surface
npm run start:terminal:tcp        # connect to a remote start:server over TCP
npm test                          # vitest (~1000 tests)
```

Live Travelport pre-prod validators (need `TVP_CLIENT_ID` +
`TVP_CLIENT_SECRET` + `TVP_USERNAME` + `TVP_PASSWORD` in env):

```bash
npm run validate:creds                  # OAuth + single-endpoint smoke
npm run validate:live-galileo           # full Galileo handler chain end-to-end
npm run validate:live-galileo:capture   # record exchanges to ./tvp-recording.jsonl
npm run validate:live-galileo:replay    # replay without hitting pre-prod (no creds)
npm run validate:diff-oracle            # emulated-vs-live wording calibration (Galileo)
npm run validate:diff-oracle:apollo     # same harness, ApolloDialect (exercises translator)
```

## Dialects

| Dialect | ID | Status |
|---|---|---|
| Sabre | `sabre` | Reference dialect — original v1-v3 surface |
| Galileo (1G) | `galileo` | Full PNR build + Travelport TripServices REST live wire (pre-prod 7K9S) |
| Apollo (1V) | `apollo` | Co-built from Galileo via a 3-pattern translator (0/N sell, ./@ status, +/-/ carrier qualifier). Same live backend |
| Amadeus | `amadeus` | Emulated-only (different vendor). ~120 verbs across v1 sign-on, v2 PNR build, v3 modify+pricing, v4 queues/history/MCT/FF/display/addresses/listing/split |

Adding a new dialect = a file (or dir) in `src/dialects/<name>/` + one
literal-union widening in `DialectId` + one switch case in
`pickDialect`. Live-backed dialects share `LiveTravelportBackend` (PCC
+ access group sets the cryptic-to-REST mapping).

## Architecture

| Layer | Files | Role |
|---|---|---|
| transport | `src/transport/` | TCP server/client + framing (length-prefix for clients, CRLF for raw `telnet`) |
| protocol | `src/protocol/` | sigil-dispatch parser, entry types, green-screen serializer, per-entry parsers |
| session | `src/session/` | work-area FSM, work area, entry→handler dispatch, the `GdsHost` |
| dialects | `src/dialects/` | per-vendor cryptic surface (parser, dispatch, serializer, responses) |
| models | `src/models/` | PNR, segment, name/phone elements, addresses, seat requests, frequent flyer, record locator |
| store | `src/store/` | seed flight inventory, PnrStore + JsonFilePnrStore (shared `PnrStoreLike` interface) |
| backends | `src/backends/` | EmulatedBackend (local) + LiveTravelportBackend (Travelport REST, with vendor pacing + capture-replay) |
| terminal | `src/terminal/` | reference agent terminal, REPL (CRT + line-mode + TCP-client), scenarios + runner |

### Key design points

- **Dialect ⊥ Backend.** Cryptic content (per-vendor) is separate from
  where answers come from (`emulated` vs `live`). The same Galileo
  dispatch runs against either backend; the same `LiveTravelportBackend`
  serves both Galileo and Apollo.
- **Sigil dispatch.** Sabre entries are sigil-prefixed free-form strings,
  so `parser.ts` dispatches by longest-prefix match (multi-char
  `SI`/`ER`/`ET`/`IG` before single-char `E`/`I`). Each dialect owns its
  own parser and longest-prefix table.
- **The PRINT rule.** End Transaction commits only when Phone,
  Received-from, Itinerary, Name, and Ticketing are present
  (`Pnr.missingMandatory()`); a missing field yields a canned `NEED …`
  rejection and leaves the work area intact.
- **Availability context.** A `1` display is cached on the work area so a
  later `0` sell can resolve a line number.
- **Cross-dialect models.** `AddressElement`, `SeatRequest`,
  `FrequentFlyer`, `AirSegment`, etc. live in `src/models/` and round-trip
  through `JsonFilePnrStore`. Any dialect can populate them.
- **Hybrid-coverage explicitness.** Verbs with no v11 REST equivalent
  (`@<n>HK`, `*H` family, `*-<surname>`) append `[LOCAL VIEW ONLY — no
  v11 REST equivalent]` when running on a live backend. Sandbox-caveats
  banner on REPL startup tells operators which backend they're driving.
- **Live-as-oracle calibration.** `validate-galileo-diff-oracle.ts` fires
  the same cryptic at emulated and live backends, classifies responses
  (IDENTICAL / TRAILER-DIFF / LOCATOR-DIFF / STRUCTURAL), and surfaces
  wording mismatches as calibration targets. 22 stateless probes
  currently all IDENTICAL — they double as regression coverage.

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for the full chunk-level history. As of
2026-06-07: v1 core lifecycle, v2 pricing, v3 queues + ticketing, v5
Multi-GDS (Dialect ⊥ Backend) all landed. Amadeus is at v4 chunk 18.

## Fidelity

Each dialect's cryptic grammar and screen formats were developed against
first-party vendor documentation (Sabre, Travelport for Galileo/Apollo,
Amadeus, and Worldspan). **Those third-party reference documents are not
included in this public repository.**

Reconstructed-not-verified strings (where a source doesn't publish the
exact wording) are flagged inline in code with `// reconstructed` or
similar comments.
