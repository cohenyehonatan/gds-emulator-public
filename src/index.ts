/**
 * Sabre-style GDS Host Emulator
 *
 * CLI entry point. Run the host and an agent terminal in one process for a
 * demo, run them separately as services, or open an interactive REPL.
 *
 * Usage:
 *   npx tsx src/index.ts              # demo: host + terminal + scenario
 *   npx tsx src/index.ts server       # GDS host only (TCP)
 *   npx tsx src/index.ts terminal     # interactive green-screen REPL (in-process)
 *   npx tsx src/index.ts scenario     # run the booking scenario
 */

import { GdsHost } from './session/gds-host.js';
import { AgentTerminal } from './terminal/agent-terminal.js';
import { ScenarioRunner } from './terminal/scenarios/scenario-runner.js';
import { bookRoundtripScenario } from './terminal/scenarios/book-roundtrip.scenario.js';
import { startRepl } from './terminal/repl.js';
import { DEFAULT_PORT } from './protocol/constants.js';
import { Logger } from './logging/logger.js';

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
  case 'terminal':
    startRepl().catch((err) => {
      logger.error(err.message);
      process.exit(1);
    });
    break;
  case 'scenario':
  default:
    runDemo().catch((err) => {
      logger.error(err.message);
      process.exit(1);
    });
    break;
}
