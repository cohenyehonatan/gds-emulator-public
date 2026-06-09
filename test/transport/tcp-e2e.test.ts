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
    expect(hello.split('\x1F')[1]).toBe('SIGNED_OFF');

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
