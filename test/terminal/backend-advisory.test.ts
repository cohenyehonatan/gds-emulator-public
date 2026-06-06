/**
 * Tests for the sandbox-caveats banner advisory.
 *
 * The REPL prints a `── BACKEND: ... ──` block after the dialect's
 * banner, distinguishing emulated from live mode. For live mode it
 * also surfaces the known trial-tenant silent-failure gaps so an
 * operator doesn't waste time on remarks/fare-rules/canceloffer that
 * won't actually persist on 7K9S.
 *
 * The advisory function is private to repl.ts, so this exercises the
 * REPL's line-mode output by spawning it as a subprocess and grepping
 * stdout. Slower than an isolated unit test but verifies the actual
 * end-user experience.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';

function spawnRepl(args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'src/index.ts', 'terminal', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stdout += d.toString()));
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
    // Send `.q` to terminate.
    setTimeout(() => child.stdin.end('.q\n'), 100);
  });
}

describe('REPL backend advisory banner', () => {
  it('shows EMULATED block when no live env vars are set', async () => {
    const out = await spawnRepl(['galileo'], {
      // Explicitly UNSET live creds so liveTravelportFromEnv() returns undefined.
      TVP_CLIENT_ID: '',
      TVP_CLIENT_SECRET: '',
      TVP_USERNAME: '',
      TVP_PASSWORD: '',
    });
    expect(out).toContain('BACKEND: EMULATED');
    expect(out).toContain('No live REST calls');
    expect(out).not.toContain('BACKEND: LIVE');
  }, 30000);

  it('shows LIVE block + trial-tenant gap list when env vars are set', async () => {
    const out = await spawnRepl(['galileo'], {
      TVP_CLIENT_ID: 'fake',
      TVP_CLIENT_SECRET: 'fake',
      TVP_USERNAME: 'fake',
      TVP_PASSWORD: 'fake',
    });
    expect(out).toContain('BACKEND: LIVE');
    expect(out).toContain('TripServices REST');
    expect(out).toContain('SYNTHETIC inventory');
    expect(out).toContain('addReservationComment');
    expect(out).toContain('documentoverrides commission');
  }, 30000);

  it('Apollo dialect also gets the backend advisory', async () => {
    const out = await spawnRepl(['apollo'], {
      TVP_CLIENT_ID: '',
      TVP_CLIENT_SECRET: '',
      TVP_USERNAME: '',
      TVP_PASSWORD: '',
    });
    expect(out).toContain('Apollo (1V)');
    expect(out).toContain('BACKEND: EMULATED');
  }, 30000);
});
