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

export async function startRepl(dialect?: Dialect): Promise<void> {
  const host = new GdsHost({ port: 0, logLevel: 'warn', dialect }); // in-process, port unused
  const wa = host.newWorkArea();
  return process.stdout.isTTY ? startCrtMode(host, wa) : startLineMode(host, wa);
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
  console.log(host.dialect.bannerText + '\n');
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
