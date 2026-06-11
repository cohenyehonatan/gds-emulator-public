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
import { createMouseFilter } from './mouse.js';
import { LiveTravelportBackend, liveTravelportFromEnv } from '../backends/live-travelport-backend.js';
import { EmulatedBackend, type Backend } from '../backends/backend.js';
import { JsonFilePnrStore } from '../store/json-file-pnr-store.js';
import { JsonFileQueues } from '../store/json-file-queues.js';
import { AgentTerminal } from './agent-terminal.js';

export async function startRepl(dialect?: Dialect, backend?: Backend): Promise<void> {
  // Auto-pick a live backend if env vars are present and the caller
  // didn't explicitly pass one — keeps `npm run start:terminal:galileo`
  // ergonomic when creds are set. Falls back to EmulatedBackend (with
  // optional JSON-file PNR persistence) otherwise.
  let effectiveBackend = backend ?? liveTravelportFromEnv();
  if (!effectiveBackend) {
    const pnrFile = process.env.PNR_STORE_FILE;
    effectiveBackend = pnrFile
      ? new EmulatedBackend({
          pnrStore: new JsonFilePnrStore(pnrFile),
          queues: new JsonFileQueues(pnrFile.replace(/\.json$/, '') + '.queues.json'),
        })
      : new EmulatedBackend();
  }
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
    '  Seeded markets: HELP MARKETS (Galileo/Apollo/Worldspan) or HE MARKETS (Amadeus).',
  ];
}

/**
 * CRT input plumbing: stdin → mouse filter → readline. Wheel on the
 * response area scrolls the CRT scrollback; wheel on the input row
 * becomes arrow-up/down (readline command history). Returns the
 * filtered stream to hand readline, plus a cleanup for raw mode.
 */
function wireCrtMouse(
  screen: CrtScreen,
  redraw: () => void,
): { input: NodeJS.ReadableStream; cleanup: () => void } {
  const filter = createMouseFilter({
    inputRow: () => screen.inputRow(),
    onScroll: (dir) => {
      if (dir === 1) screen.scrollUp();
      else screen.scrollDown();
      redraw();
    },
  });
  process.stdin.pipe(filter);
  // The filter isn't a TTY, so readline won't manage raw mode — do it
  // here and restore on close.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const cleanup = () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.unpipe(filter);
  };
  return { input: filter, cleanup };
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

  // Mouse wheel: response area scrolls the CRT scrollback; the input
  // row scrolls readline command history (arrow-key substitution).
  const mouse = wireCrtMouse(screen, () => redraw());
  const rl = readline.createInterface({ input: mouse.input, output: out, prompt: '› ', terminal: true });

  const redraw = () => {
    screen.render(`AAA ${wa.agent ?? '----'}   [${wa.state()}]`);
    readline.cursorTo(out, screen.inputCol() - 1, screen.inputRow() - 1);
    rl.prompt(true);
  };

  redraw();

  // CRT polish — keep the input row's right border intact during live typing.
  // WRAP_OFF means characters typed past column W-1 pile up at the right
  // edge and overwrite `│`. Re-emit it after each keypress (deferred via
  // setImmediate so readline's own write completes first, then we restore
  // the border and the cursor position).
  readline.emitKeypressEvents(mouse.input);
  mouse.input.on('keypress', () => {
    setImmediate(() => screen.redrawRightBorder());
  });

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
      mouse.cleanup();
      screen.leave();
      console.log('Session ended.');
      resolve();
    });
  });
}

/**
 * TCP-client terminal: connect to a remote GdsHost (run via
 * `npx tsx src/index.ts server`) and forward cryptic entries over the
 * socket via AgentTerminal. The remote host owns the dialect, work area,
 * and PNR state; the local terminal is just a thin line-mode I/O loop.
 *
 * Defaults: localhost:5555 (matches `start:server`). Override via
 * --host=<h> and --port=<p> CLI flags or the GDS_HOST / GDS_PORT env
 * vars.
 *
 * No CRT mode yet — the local terminal doesn't have visibility into
 * `wa.state()` for the status bar (that lives on the server). v1 ships
 * plain line-mode for simplicity; CRT-over-TCP is a follow-up.
 */
export async function startReplTcp(opts: { host: string; port: number }): Promise<void> {
  const terminal = new AgentTerminal({
    host: opts.host,
    port: opts.port,
    logLevel: 'warn',
  });
  try {
    await terminal.connect();
  } catch (err) {
    console.error(
      `Failed to connect to GDS host ${opts.host}:${opts.port} — ${err instanceof Error ? err.message : String(err)}`
    );
    console.error(`Is the server running? Try \`npm run start:server\` in another terminal.`);
    process.exit(1);
  }
  console.log(`Connected to GDS host at ${opts.host}:${opts.port}.`);

  // CRT-over-TCP (v6): opt into the server's state-trailer protocol
  // with the `.CRT` hello. Every response then carries
  // `\x1F<state>\x1F<agent>` which we strip for display and use for
  // the CRT status bar. Falls back to plain line-mode when the hello
  // isn't acknowledged (older server) or stdout isn't a TTY.
  let crt = false;
  try {
    const hello = await terminal.enter('.CRT');
    crt = hello.startsWith('CRT OK') && process.stdout.isTTY === true;
  } catch {
    crt = false;
  }

  const splitTrailer = (response: string): { body: string; state: string; agent: string } => {
    const parts = response.split('\x1F');
    return {
      body: parts[0],
      state: parts[1] ?? '?',
      agent: parts[2] && parts[2].length > 0 ? parts[2] : '----',
    };
  };

  if (crt) {
    const out = process.stdout;
    const screen = new CrtScreen(out, 'REMOTE GDS (TCP)');
    screen.enter();
    screen.print('── BACKEND: REMOTE (TCP, CRT mode) ──');
    screen.print('  Server owns the dialect, work area, and PNR state;');
    screen.print('  the status bar reflects the remote work-area state.');
    screen.print('');

    const mouse = wireCrtMouse(screen, () => redraw());
    const rl = readline.createInterface({ input: mouse.input, output: out, prompt: '› ', terminal: true });
    let lastState = '?';
    let lastAgent = '----';
    const redraw = () => {
      screen.render(`AAA ${lastAgent}   [${lastState}]`);
      readline.cursorTo(out, screen.inputCol() - 1, screen.inputRow() - 1);
      rl.prompt(true);
    };
    redraw();

    readline.emitKeypressEvents(mouse.input);
    mouse.input.on('keypress', () => {
      setImmediate(() => screen.redrawRightBorder());
    });

    rl.on('line', async (line) => {
      const entry = line.trim();
      if (isQuit(entry)) {
        rl.close();
        return;
      }
      if (entry.length > 0) {
        screen.printEntry(entry);
        try {
          const { body, state, agent } = splitTrailer(await terminal.enter(entry));
          lastState = state;
          lastAgent = agent;
          screen.print(body);
        } catch (err) {
          screen.print(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        screen.print('');
      }
      redraw();
    });

    out.on('resize', redraw);

    return new Promise<void>((resolve) => {
      rl.on('close', () => {
        mouse.cleanup();
        screen.leave();
        terminal.disconnect();
        console.log('Session ended.');
        resolve();
      });
    });
  }

  console.log('── BACKEND: REMOTE (TCP) ──');
  console.log('  Entries forward to the server over the socket; responses');
  console.log('  return verbatim. Server owns the dialect, work area, and PNR state.');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => process.stdout.write('\n› ');
  prompt();

  rl.on('line', async (line) => {
    const entry = line.trim();
    if (isQuit(entry)) {
      rl.close();
      return;
    }
    if (entry.length > 0) {
      try {
        const response = await terminal.enter(entry);
        // Tolerate a state trailer if the hello succeeded but TTY
        // detection forced line-mode — strip it for clean output.
        console.log(crt || !response.includes('\x1F') ? response : response.split('\x1F')[0]);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    prompt();
  });

  return new Promise<void>((resolve) => {
    rl.on('close', () => {
      terminal.disconnect();
      console.log('\nSession ended.');
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
