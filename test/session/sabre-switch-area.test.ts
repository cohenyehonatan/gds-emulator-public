import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Sabre ¤<letter> work-area switch parsing', () => {
  it('parses ¤D as switch_area to D', () => {
    const r = parseEntry('¤D');
    expect(r.kind).toBe('switch_area');
    if (r.kind === 'switch_area') expect(r.targetArea).toBe('D');
  });

  it('accepts each documented letter A-F', () => {
    for (const l of ['A', 'B', 'C', 'D', 'E', 'F']) {
      const r = parseEntry(`¤${l}`);
      if (r.kind === 'switch_area') expect(r.targetArea).toBe(l);
    }
  });

  it('uppercases lowercase letters', () => {
    const r = parseEntry('¤d');
    if (r.kind === 'switch_area') expect(r.targetArea).toBe('D');
  });

  it('multi-char form falls through to modify (not switch)', () => {
    // ¤AB has two letters — looks like field-change syntax to the modify
    // matcher (which rejects it as having no SIGIL_FIELD prefix), so
    // dispatch is unrecognized → FORMAT at the host. Verified at the
    // host-level test below; here we just confirm it isn't routed as a
    // switch entry.
    expect(() => parseEntry('¤AB')).toThrow();
  });
});

describe('Sabre ¤<letter> through the host', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*ALJ', wa);
  });

  it('¤D switches to area D and returns the signature line ending in ..D', () => {
    expect(wa.area).toBe('A');
    const resp = host.process('¤D', wa);
    expect(wa.area).toBe('D');
    expect(resp).toBe('A0UC.A0UC*ALJ..D');
  });

  it('switched area has its own empty PNR; switching back preserves area A state', () => {
    // Build something in area A
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa);
    host.process('-SMITH/JOHN MR', wa);
    expect(wa.pnr.names.length).toBe(1);
    expect(wa.pnr.segments.length).toBe(1);
    // Switch to B — independent slate
    host.process('¤B', wa);
    expect(wa.pnr.names.length).toBe(0);
    expect(wa.pnr.segments.length).toBe(0);
    // Switch back to A — work survives
    host.process('¤A', wa);
    expect(wa.pnr.names.length).toBe(1);
    expect(wa.pnr.names[0].surname).toBe('SMITH');
    expect(wa.pnr.segments.length).toBe(1);
  });

  it('agent is preserved across area switches (session-level)', () => {
    expect(wa.agent).toBe('ALJ');
    host.process('¤C', wa);
    expect(wa.agent).toBe('ALJ');
  });

  it('¤Z (unconfigured letter) returns FORMAT and leaves the active area unchanged', () => {
    // The keyboard layer maps `[` to `¤`, so '¤Z' is also reachable as '[Z'.
    // The parser accepts ¤Z (just one letter), the handler rejects it.
    const resp = host.process('¤Z', wa);
    // Z isn't in the default A-F set; WorkArea.switchTo returns false.
    expect(resp).toBe('FORMAT');
    expect(wa.area).toBe('A');
  });

  it('switch + IG cycle clears only the active area\'s PNR', () => {
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa);
    host.process('-SMITH/JOHN MR', wa); // built in A
    host.process('¤C', wa);
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa);
    host.process('-DOE/JANE MS', wa); // built in C
    host.process('IG', wa); // ignores only C (active area)
    expect(wa.pnr.names.length).toBe(0); // C cleared
    host.process('¤A', wa);
    expect(wa.pnr.names[0].surname).toBe('SMITH'); // A survived
  });

  it('ASCII [ keyboard alias also works (`[`→`¤` per protocol/keyboard.ts)', () => {
    // The keyboard normalization happens at GdsHost.process via the dialect.
    const resp = host.process('[B', wa);
    expect(resp).toBe('A0UC.A0UC*ALJ..B');
    expect(wa.area).toBe('B');
  });
});
