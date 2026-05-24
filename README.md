# gds-emulator

Emulator for a **Sabre-style GDS host** — cryptic-entry parsing, an AAA
work-area session FSM, and the core PNR lifecycle. Built as a sibling to
[`pectab-printer-emulator`](../pectab-printer-emulator): same TypeScript/ESM
stack, table-driven state machine, pluggable TCP transport, command-handler
registry, declarative scenarios, and a reference counterparty.

Where the printer emulator emulates a **device** (the ATBPR) driven by a host,
this emulates the **host** (the GDS) driven by an **agent terminal**.

## Run

```bash
npm install
npm run dev          # demo: host + terminal + booking scenario
npm run start:server # GDS host only (TCP, port 9600)
npm run start:terminal # full-screen green-screen CRT terminal (line-mode fallback off-TTY)
npm test             # vitest
```

## Architecture

| Layer | Files | Role |
|---|---|---|
| transport | `src/transport/` | TCP server/client + framing (length-prefix for clients, CRLF for raw `telnet`) |
| protocol | `src/protocol/` | sigil-dispatch parser, entry types, green-screen serializer, per-entry parsers |
| session | `src/session/` | work-area FSM, work area, entry→handler dispatch, the `GdsHost` |
| models | `src/models/` | PNR, segment, name/phone elements, record locator, availability result |
| store | `src/store/` | seed flight inventory, PNR store (keyed by locator) |
| terminal | `src/terminal/` | reference agent terminal, REPL, scenarios + runner |

### Key design points

- **Sigil dispatch.** Sabre entries are sigil-prefixed free-form strings, not
  fixed-width codes, so `parser.ts` dispatches by longest-prefix match
  (multi-char `SI`/`ER`/`ET`/`IG` before single-char `E`/`I`).
- **The PRINT rule.** End Transaction commits only when Phone, Received-from,
  Itinerary, Name, and Ticketing are present (`Pnr.missingMandatory()`); a
  missing field yields a canned `NEED …` rejection and leaves the work area
  intact — the analog of the printer refusing to print.
- **Availability context.** A `1` display is cached on the work area so a
  later `0` sell can resolve a line number.
- **Keyboard / end-item.** Sabre's special keys are accepted via ASCII aliases
  (`\`→`§` end-item, `[`→`¤` change, `'`→`¥`), and an entry chained with the
  end-item runs as one transmission — e.g. build a whole PNR in one line:
  `-SMITH/JOHN MR\9305-555-1212-H\7TAW15JUN/\6P\ER`.

## v1 scope & roadmap

- **v1 (this scaffold):** sign-in, availability, sell, name/phone/ticketing/
  received-from, end-transaction with validation, retrieve/modify, REPL + TCP.
- **v2:** pricing & fares (`WP`), a fare engine.
- **v3:** queues and e-ticketing.
- **v4:** BHS integration — check-in retrieves a PNR before generating PECTAB.

## Fidelity

Formats and the PRINT rule are grounded in
`references/Sabre-Basic-Reservation-Course.pdf` (*Working in the Sabre System*,
Training Workbook Ed. 2.7, © Sabre Inc.). Spots where exact response wording or
column layout still needs pinning against the source are marked `TODO` in code.
