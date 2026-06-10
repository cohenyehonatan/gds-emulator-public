/**
 * GDS Host Emulator
 *
 * CLI entry point. Run the host and an agent terminal in one process for a
 * demo, run them separately as services, or open an interactive REPL.
 *
 * Usage:
 *   npx tsx src/index.ts                       # demo: host + terminal + scenario
 *   npx tsx src/index.ts server                # GDS host only (TCP)
 *   npx tsx src/index.ts terminal              # interactive REPL (Sabre, default)
 *   npx tsx src/index.ts terminal sabre        # explicit Sabre dialect
 *   npx tsx src/index.ts terminal galileo      # Galileo (1G) — skeleton only
 *   npx tsx src/index.ts scenario              # run the booking scenario
 */

import { GdsHost } from './session/gds-host.js';
import { AgentTerminal } from './terminal/agent-terminal.js';
import { ScenarioRunner } from './terminal/scenarios/scenario-runner.js';
import { bookRoundtripScenario } from './terminal/scenarios/book-roundtrip.scenario.js';
import { startRepl, startReplTcp } from './terminal/repl.js';
import type { Dialect } from './dialects/dialect.js';
import { GalileoDialect } from './dialects/galileo/index.js';
import { ApolloDialect } from './dialects/apollo/index.js';
import { AmadeusDialect } from './dialects/amadeus/index.js';
import { WorldspanDialect } from './dialects/worldspan/index.js';
import { DEFAULT_PORT } from './protocol/constants.js';
import { Logger } from './logging/logger.js';

/**
 * Resolve a CLI dialect name to a Dialect instance, or undefined for the host
 * default (SabreDialect). Throws on an unknown name so a typo'd `terminal
 * sabree` exits cleanly instead of silently falling back to Sabre.
 */
function pickDialect(name: string | undefined): Dialect | undefined {
  switch (name) {
    case undefined:
    case 'sabre':
      return undefined; // host default
    case 'galileo':
      return new GalileoDialect();
    case 'apollo':
      return new ApolloDialect();
    case 'amadeus':
      return new AmadeusDialect();
    case 'worldspan':
      return new WorldspanDialect();
    default:
      throw new Error(`Unknown dialect: '${name}'. Known: sabre, galileo, apollo, amadeus, worldspan.`);
  }
}

const logger = new Logger('MAIN', 'info');

async function runDemo(): Promise<void> {
  logger.section('Sabre GDS Host Emulator Demo');
  const port = DEFAULT_PORT;

  const host = new GdsHost({ port, logLevel: 'info' });
  await host.start();
  await new Promise((r) => setTimeout(r, 100));

  const terminal = new AgentTerminal({ host: '127.0.0.1', port, logLevel: 'info' });
  await terminal.connect();

  const runner = new ScenarioRunner(terminal);
  const result = await runner.run(bookRoundtripScenario);

  logger.info(`Book Round Trip: ${result.success ? 'PASSED' : 'FAILED'}`, {
    steps: `${result.stepsCompleted}/${result.totalSteps}`,
  });
  if (!result.success) logger.error(result.error ?? 'unknown failure');

  // Show the final PNR display (last exchange response).
  const last = result.exchanges[result.exchanges.length - 1];
  if (last) {
    logger.section('Committed PNR');
    console.log(last.response);
  }

  terminal.disconnect();
  await host.stop();
  process.exit(result.success ? 0 : 1);
}

async function startServer(): Promise<void> {
  const port = parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const host = new GdsHost({ port, logLevel: 'debug' });
  await host.start();
  logger.info('GDS host running. Press Ctrl+C to stop.');
  process.on('SIGINT', async () => {
    await host.stop();
    process.exit(0);
  });
}

/**
 * `npm start` — the front door. Prints a directory of every npm
 * script and what it gets you, so a newcomer doesn't have to read
 * package.json to find the five terminals.
 */
function printDirectory(): void {
  console.log(`
gds-emulator — multi-dialect GDS host emulator
══════════════════════════════════════════════

TERMINALS (interactive REPL, full-screen CRT on a TTY)
  npm run start:terminal             Sabre (default dialect)
  npm run start:terminal:sabre       Sabre — the source-grounded reference
  npm run start:terminal:galileo     Galileo (1G) — full PNR lifecycle; live
                                     Travelport wire when TVP_* env vars set
  npm run start:terminal:apollo      Apollo (1V) — Galileo co-build (translator)
  npm run start:terminal:amadeus     Amadeus — ~150 verbs, hotel/car/rail,
                                     e-ticketing, HE help system
  npm run start:terminal:worldspan   Worldspan (1P) — Galileo co-build

CLIENT / SERVER
  npm run start:server               GDS host on TCP (port 9600)
  npm run start:terminal:tcp         connect a terminal to a remote host
                                     (GDS_HOST / GDS_PORT env; CRT status bar
                                     negotiates automatically)

DEMO / TESTS
  npm run dev                        scripted demo: host + terminal + booking
  npm test                           unit suite (~1500 tests)
  npm run typecheck                  tsc --noEmit

LIVE VALIDATION (needs TVP_CLIENT_ID/SECRET/USERNAME/PASSWORD)
  npm run validate:creds             OAuth + single-endpoint smoke
  npm run validate:live-galileo      full Galileo handler chain vs pre-prod
    …:capture / …:replay             record to / replay from tvp-recording.jsonl
  npm run validate:diff-oracle       emulated-vs-live wording calibration
    …:apollo / …:worldspan           same harness through each translator

TIPS
  Inside any terminal: type HELP (Galileo/Apollo/Worldspan), HE (Amadeus)
  for the in-terminal verb directory. Sabre help lives in Format Finder
  (web), so Sabre has no help verb — by the book. Quit with .q
`);
}

const command = process.argv[2];

switch (command) {
  case 'directory':
    printDirectory();
    break;
  case 'server':
    startServer().catch((err) => {
      logger.error(err.message);
      process.exit(1);
    });
    break;
  case 'terminal': {
    // pickDialect throws synchronously on an unknown name, so it can't be
    // chained through .catch alone — wrap it explicitly.
    let dialect: Dialect | undefined;
    try {
      dialect = pickDialect(process.argv[3]);
    } catch (err) {
      logger.error((err as Error).message);
      process.exit(1);
    }
    startRepl(dialect).catch((err) => {
      logger.error(err.message);
      process.exit(1);
    });
    break;
  }
  case 'terminal:tcp': {
    // TCP client: connect to a remote GdsHost. The server owns the dialect
    // (pick it at server startup); we just push entries over the wire.
    const host = process.env.GDS_HOST ?? 'localhost';
    const port = Number(process.env.GDS_PORT ?? DEFAULT_PORT);
    startReplTcp({ host, port }).catch((err) => {
      logger.error(err.message);
      process.exit(1);
    });
    break;
  }
  case 'scenario':
  default:
    runDemo().catch((err) => {
      logger.error(err.message);
      process.exit(1);
    });
    break;
}
