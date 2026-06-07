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
    default:
      throw new Error(`Unknown dialect: '${name}'. Known: sabre, galileo, apollo, amadeus.`);
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

const command = process.argv[2];

switch (command) {
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
