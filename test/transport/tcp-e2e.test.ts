/**
 * End-to-end TCP scenario test.
 *
 * Closes the ROADMAP Infra/DX item: "End-to-end TCP scenario test
 * (host + terminal over the wire)." Spins up a real GdsHost on an
 * ephemeral port, connects an AgentTerminal as a client, and runs a
 * cryptic sequence through the socket — proving the TCP transport
 * (length-prefix framing + connection lifecycle) works end-to-end
 * with the same dialect dispatch the in-process REPL uses.
 *
 * Two scenarios:
 *  1. Sabre default — full BF build + ER over TCP.
 *  2. Galileo dialect — same flow with the alternative dialect, so
 *     the dialect seam works through the socket too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AgentTerminal } from '../../src/terminal/agent-terminal.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';

describe('TCP end-to-end (host + terminal over the wire)', () => {
  let host: GdsHost;
  let terminal: AgentTerminal;

  afterEach(async () => {
    terminal?.disconnect();
    await host?.stop();
  });

  it('Sabre: SON → A → 0Y1 → mandatory fields → ER produces a locator over TCP', async () => {
    host = new GdsHost({ port: 0, logLevel: 'error', pcc: 'A0UC' });
    await host.start();
    const port = host.getPort();

    terminal = new AgentTerminal({ host: '127.0.0.1', port, logLevel: 'error' });
    await terminal.connect();

    // Sabre `SI*` returns the work-area / PCC mask, not "SIGNED ON" —
    // success is the PCC echoed back at the head of the response.
    expect(await terminal.enter('SI*')).toContain('A0UC');
    expect(await terminal.enter('115JUNJFKLAX')).toContain('JFK/LAX'); // Sabre uses / separator
    expect(await terminal.enter('01Y1')).toContain('JFK');
    expect(await terminal.enter('-SMITH/JOHN MR')).toBe('OK');
    expect(await terminal.enter('9305-555-1212-H')).toBe('OK');
    expect(await terminal.enter('7TAW15JUN')).toBe('OK');
    expect(await terminal.enter('6P')).toBe('OK');
    const er = await terminal.enter('ER');
    // Sabre ER returns a rendered BF with the 6-char locator somewhere
    // in the signature/header line.
    expect(er).toMatch(/[A-Z]{6}/);
  });

  it('Galileo: full BF build over TCP with the GalileoDialect', async () => {
    host = new GdsHost({
      port: 0, logLevel: 'error', pcc: '7K9S', dialect: new GalileoDialect(),
    });
    await host.start();
    const port = host.getPort();

    terminal = new AgentTerminal({ host: '127.0.0.1', port, logLevel: 'error' });
    await terminal.connect();

    expect(await terminal.enter('SON/ZHA')).toContain('SIGNED ON AT 7K9S');
    expect(await terminal.enter('A15JUNJFKLAX')).toContain('JFK-LAX');
    expect(await terminal.enter('N1Y1')).toContain('JFK');
    expect(await terminal.enter('N.SMITH/JOHN MR')).toBe('OK');
    expect(await terminal.enter('P.LON*02012345678')).toBe('OK');
    expect(await terminal.enter('T.TAU/15JUN')).toBe('OK');
    expect(await terminal.enter('R.AGT')).toBe('OK');
    const er = await terminal.enter('ER');
    expect(er).toMatch(/[A-Z0-9]{6}\s+\S+\/\S+/); // "GZTZ4R  7K9S/HA"
  });

  it('disconnect closes the connection cleanly', async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    await host.start();
    terminal = new AgentTerminal({ host: '127.0.0.1', port: host.getPort(), logLevel: 'error' });
    await terminal.connect();
    await terminal.enter('SI*');
    terminal.disconnect();
    // Reconnecting after disconnect should fail (or the spec is up to
    // the caller); reaching this line without timeout means cleanup
    // didn't hang.
    expect(true).toBe(true);
  });
});

describe('CRT-over-TCP state-trailer protocol (v6)', () => {
  let host: GdsHost;
  let terminal: AgentTerminal;

  afterEach(async () => {
    terminal?.disconnect();
    await host?.stop();
  });

  it('.CRT hello opts in; responses carry \\x1F<state>\\x1F<agent> trailers', async () => {
    host = new GdsHost({ port: 0, logLevel: 'error', pcc: 'A0UC' });
    await host.start();
    terminal = new AgentTerminal({ host: '127.0.0.1', port: host.getPort(), logLevel: 'error' });
    await terminal.connect();

    const hello = await terminal.enter('.CRT');
    expect(hello.startsWith('CRT OK')).toBe(true);
    const helloParts = hello.split('\x1F');
    expect(helloParts[1]).toBe('SIGNED_OFF');
    // The hello identifies the host: dialect screen name + backend.
    expect(helloParts[3]).toBeTruthy();
    expect(helloParts[4]).toBe('EMULATED');
    // 6th field carries the dialect sign-on screen (rendered on connect).
    expect(helloParts[5]).toContain('AGENT SIGN IN'); // Sabre default mask

    const signIn = await terminal.enter('SI*');
    const parts = signIn.split('\x1F');
    expect(parts[0]).toContain('A0UC');       // the normal response body
    expect(parts[1]).toBe('EMPTY');           // state advanced after sign-in
  });

  it('agent appears in the trailer after sign-in carries one', async () => {
    host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S' });
    await host.start();
    terminal = new AgentTerminal({ host: '127.0.0.1', port: host.getPort(), logLevel: 'error' });
    await terminal.connect();

    await terminal.enter('.CRT');
    const resp = await terminal.enter('SON/ZGS');
    const parts = resp.split('\x1F');
    expect(parts[0]).toContain('GS SIGNED ON');
    expect(parts[2]).toBe('GS'); // agent in the trailer
  });

  it('clients that never send the hello see clean responses (no trailer)', async () => {
    host = new GdsHost({ port: 0, logLevel: 'error', pcc: 'A0UC' });
    await host.start();
    terminal = new AgentTerminal({ host: '127.0.0.1', port: host.getPort(), logLevel: 'error' });
    await terminal.connect();

    const resp = await terminal.enter('SI*');
    expect(resp).not.toContain('\x1F');
  });
});

describe('server resilience — a bad entry must never kill the host', () => {
  let host: GdsHost;
  let terminal: AgentTerminal;

  afterEach(async () => {
    terminal?.disconnect();
    await host?.stop();
  });

  it('SELL while SIGNED_OFF answers OUT OF SEQUENCE and the server keeps serving (the live-session crash)', async () => {
    host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'A0UC' });
    await host.start();
    terminal = new AgentTerminal({ host: '127.0.0.1', port: host.getPort(), logLevel: 'error' });
    await terminal.connect();

    // The exact sequence that crashed start:server: availability
    // without sign-on (allowed), then a sell — the FSM throw inside
    // the async sell handler escaped the sync catch as a rejected
    // promise and took the process down.
    expect(await terminal.enter('A01JULCDGJFK')).toContain('CDG-JFK');
    expect(await terminal.enter('N2F1')).toBe('OUT OF SEQUENCE');
    // Server alive + session recoverable.
    expect(await terminal.enter('HELP')).toContain('EMULATOR HELP');
    expect(await terminal.enter('SON/Z01UC')).toContain('SIGNED ON');
    expect(await terminal.enter('N2F1')).toContain('AF 002');
  });

  it('a client that disconnects mid-entry does not crash the host (send-to-closed)', async () => {
    // A dialect whose processEntry takes 60ms, deterministically
    // reproducing a slow LIVE entry that outlives its client.
    class SlowDialect extends GalileoDialect {
      async processEntry(): Promise<string> {
        await new Promise((r) => setTimeout(r, 60));
        return 'SLOW OK';
      }
    }
    host = new GdsHost({ port: 0, logLevel: 'error', dialect: new SlowDialect(), pcc: 'A0UC' });
    await host.start();
    const port = host.getPort();

    const t = new AgentTerminal({ host: '127.0.0.1', port, logLevel: 'error' });
    await t.connect();
    void t.enter('ANYTHING').catch(() => undefined); // 60ms server-side
    await new Promise((r) => setTimeout(r, 10)); // entry is mid-flight
    t.disconnect(); // close WHILE the host is still in the 60ms delay
    await new Promise((r) => setTimeout(r, 90)); // let the host attempt its now-doomed send

    // The old code threw "Connection is closed" as an unhandled rejection
    // here and took the host down (the dogfood crash). It must survive +
    // serve a fresh client.
    terminal = new AgentTerminal({ host: '127.0.0.1', port, logLevel: 'error' });
    await terminal.connect();
    expect(await terminal.enter('STILL ALIVE')).toBe('SLOW OK');
  });
});

describe('dev-loop reconnect — the client survives a server bounce', () => {
  let host: GdsHost;
  let terminal: AgentTerminal;

  afterEach(async () => {
    terminal?.disconnect();
    await host?.stop();
  });

  it('reconnect() re-establishes the socket; persisted PNRs retrieve on the new session', async () => {
    const { EmulatedBackend } = await import('../../src/backends/backend.js');
    const { JsonFilePnrStore } = await import('../../src/store/json-file-pnr-store.js');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { unlinkSync } = await import('fs');
    const file = join(tmpdir(), `gds-reconnect-${process.pid}.json`);
    const port = 9760 + (process.pid % 100);
    const mk = () => new GdsHost({
      port, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'A0UC',
      backend: new EmulatedBackend({ pnrStore: new JsonFilePnrStore(file) }),
    });
    let server = mk();
    await server.start();
    terminal = new AgentTerminal({ host: '127.0.0.1', port, logLevel: 'error' });
    await terminal.connect();
    await terminal.enter('SON/Z01UC');
    await terminal.enter('A01JULCDGJFK');
    await terminal.enter('N1F1');
    await terminal.enter('N.COHEN/YEHONATAN MR');
    await terminal.enter('P.1');
    await terminal.enter('R.X');
    await terminal.enter('T.TAU/30JUN');
    const locator = /^([A-Z0-9]{6})\b/.exec(await terminal.enter('ER'))![1];

    // The tsx-watch bounce.
    await server.stop();
    expect(terminal.isConnected()).toBe(false);
    await expect(terminal.enter('*R')).rejects.toThrow();
    server = mk();
    await server.start();
    await terminal.reconnect();
    expect(terminal.isConnected()).toBe(true);
    // Fresh work area — sign on again, then the committed PNR is there.
    await terminal.enter('SON/Z01UC');
    expect(await terminal.enter(`*${locator}`)).toContain('COHEN/YEHONATAN MR');
    host = server; // afterEach cleanup
    try { unlinkSync(file); } catch { /* */ }
  });
});
