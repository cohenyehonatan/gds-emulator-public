/**
 * Interactive green-screen REPL.
 *
 * Reads cryptic entries from stdin and prints host responses — a green-screen
 * terminal you can type into. Runs the host in-process (no TCP) by default so
 * `npm run start:terminal` is self-contained; point it at a remote host later
 * by swapping in an AgentTerminal.
 */

import * as readline from 'readline';
import { GdsHost } from '../session/gds-host.js';

export async function startRepl(): Promise<void> {
  const host = new GdsHost({ port: 0, logLevel: 'warn' }); // port unused: in-process
  const wa = host.newWorkArea();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => {
    process.stdout.write(`\n[${wa.state()}]\n› `);
  };

  console.log('GDS terminal — type a cryptic entry, or "SI" to sign in, ".q" to quit.\n');
  prompt();

  rl.on('line', (line) => {
    const entry = line.trim();
    if (entry === '.q' || entry === 'QUIT') {
      rl.close();
      return;
    }
    if (entry.length > 0) {
      const response = host.process(entry, wa);
      console.log(response);
    }
    prompt();
  });

  rl.on('close', () => {
    console.log('\nSession ended.');
    process.exit(0);
  });
}
