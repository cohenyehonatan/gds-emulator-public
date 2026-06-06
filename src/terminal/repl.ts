/**
 * Interactive GDS terminal.
 *
 * On a TTY: a full-screen green-screen CRT (CrtScreen) you type cryptic
 * entries into. Off a TTY (pipe/CI): a plain line-mode loop so scripted input
 * still works. Both run the host in-process (no TCP); point at a remote host
 * later by swapping in an AgentTerminal.
 */

import * as readline from 'readline';
import { GdsHost } from '../session/gds-host.js';
import { WorkArea } from '../session/work-area.js';
import type { Dialect } from '../dialects/dialect.js';
import { CrtScreen } from './crt-screen.js';
import { LiveTravelportBackend, liveTravelportFromEnv } from '../backends/live-travelport-backend.js';
import type { Backend } from '../backends/backend.js';

export async function startRepl(dialect?: Dialect, backend?: Backend): Promise<void> {
  // Auto-pick a live backend if env vars are present and the caller
  // didn't explicitly pass one — keeps `npm run start:terminal:galileo`
  // ergonomic when creds are set.
  const effectiveBackend = backend ?? liveTravelportFromEnv();
  const host = new GdsHost({ port: 0, logLevel: 'warn', dialect, backend: effectiveBackend });
  const wa = host.newWorkArea();
  return process.stdout.isTTY ? startCrtMode(host, wa) : startLineMode(host, wa);
}

/**
 * Sandbox advisory shown after the dialect banner. Per ROADMAP item
 * "Sandbox caveats documented — pre-prod = synthetic inventory, no
 * real tickets, trial creds expirable. Make these surface in the
 * banner, not in a comment somewhere."
 *
 * Three messages so the operator can't miss which backend they're
 * driving:
 *   - LIVE on the trial pre-prod tenant — surfaces the synthetic-
 *     inventory + no-real-tickets + known-trial-gap warnings
 *   - LIVE on a non-trial host (production tenant) — minimal advisory
 *     reminding that BFs and tickets are real
 *   - EMULATED — just notes the local-only state
 */
function backendAdvisory(host: GdsHost): string[] {
  if (host.backend instanceof LiveTravelportBackend) {
    return [
      '── BACKEND: LIVE (Travelport TripServices REST) ──',
      '  Cryptic dispatches POST/GET against pre-prod. Real workbenches',
      '  open and close server-side; BF commits produce real locators.',
      '  Pre-prod is SYNTHETIC inventory; tickets do NOT issue against',
      '  the carrier. Known trial-tenant (7K9S) silent-failure gaps:',
      '    addReservationComment / fromfaredisplay / canceloffer per-',
      '    offer / documentoverrides commission. Live ticket issuance',
      '    requires production-tier access. See ROADMAP.md.',
    ];
  }
  return [
    '── BACKEND: EMULATED (local Inventory + PnrStore) ──',
    '  No live REST calls. All state synthesized in-process.',
  ];
}

function isQuit(entry: string): boolean {
  return entry === '.q' || entry.toUpperCase() === 'QUIT';
}

/** Full-screen CRT mode. */
function startCrtMode(host: GdsHost, wa: WorkArea): Promise<void> {
  const out = process.stdout;
  const screen = new CrtScreen(out, host.dialect.screenName);
  screen.enter();
  screen.print(host.dialect.bannerText);
  for (const line of backendAdvisory(host)) screen.print(line);
  screen.print('');

  const rl = readline.createInterface({ input: process.stdin, output: out, prompt: '› ' });

  const redraw = () => {
    screen.render(`AAA ${wa.agent ?? '----'}   [${wa.state()}]`);
    readline.cursorTo(out, screen.inputCol() - 1, screen.inputRow() - 1);
    rl.prompt(true);
  };

  redraw();

  rl.on('line', async (line) => {
    const entry = line.trim();
    if (isQuit(entry)) {
      rl.close();
      return;
    }
    if (entry.length > 0) {
      screen.printEntry(entry);
      screen.print(await host.process(entry, wa));
      screen.print('');
    }
    redraw();
  });

  out.on('resize', redraw);

  return new Promise<void>((resolve) => {
    rl.on('close', () => {
      screen.leave();
      console.log('Session ended.');
      resolve();
    });
  });
}

/** Plain line-mode fallback for non-TTY stdin/stdout. */
function startLineMode(host: GdsHost, wa: WorkArea): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(host.dialect.bannerText);
  for (const line of backendAdvisory(host)) console.log(line);
  console.log('');
  const prompt = () => process.stdout.write(`\n[${wa.state()}]\n› `);
  prompt();

  rl.on('line', (line) => {
    const entry = line.trim();
    if (isQuit(entry)) {
      rl.close();
      return;
    }
    if (entry.length > 0) console.log(host.process(entry, wa));
    prompt();
  });

  return new Promise<void>((resolve) => {
    rl.on('close', () => {
      console.log('\nSession ended.');
      resolve();
    });
  });
}
