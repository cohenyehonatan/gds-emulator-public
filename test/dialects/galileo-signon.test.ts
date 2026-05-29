import { describe, it, expect } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';
import { SessionState } from '../../src/session/session-state.js';

describe('Galileo parser — SON / SOF', () => {
  it('parses SON/Z<usercode> as sign_in', () => {
    const r = parseGalileoEntry('SON/ZHA');
    expect(r.kind).toBe('sign_in');
    if (r.kind === 'sign_in') expect(r.argument).toBe('HA');
  });

  it('captures PCC+initials in the argument when present (legacy form)', () => {
    const r = parseGalileoEntry('SON/ZGL4HA');
    if (r.kind === 'sign_in') expect(r.argument).toBe('GL4HA');
  });

  it('tolerates internal whitespace ("SON / ZHA")', () => {
    const r = parseGalileoEntry('SON / ZHA');
    if (r.kind === 'sign_in') expect(r.argument).toBe('HA');
  });

  it('parses SOF as sign_out (single area, not all)', () => {
    const r = parseGalileoEntry('SOF');
    expect(r.kind).toBe('sign_out');
    if (r.kind === 'sign_out') expect(r.allAreas).toBe(false);
  });

  it('parses SOF/Z<override> as sign_out (override form, also single-area)', () => {
    const r = parseGalileoEntry('SOF/ZGL4HA');
    if (r.kind === 'sign_out') expect(r.allAreas).toBe(false);
  });

  it('rejects malformed sign-on entries', () => {
    expect(() => parseGalileoEntry('SON/Z')).toThrow(); // empty usercode
    expect(() => parseGalileoEntry('SON')).toThrow(); // missing /Z
    expect(() => parseGalileoEntry('SOX')).toThrow(); // wrong sigil
    expect(() => parseGalileoEntry('')).toThrow();
  });
});

describe('Galileo dialect — SON / SOF through the host', () => {
  function newHost(): { host: GdsHost; wa: WorkArea } {
    const host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    return { host, wa: host.newWorkArea() };
  }

  it('SON/Z transitions session to EMPTY (signed in, no PNR) and returns a signature line', () => {
    const { host, wa } = newHost();
    expect(wa.state()).toBe(SessionState.SIGNED_OFF);
    const resp = host.process('SON/ZHA', wa);
    expect(wa.state()).toBe(SessionState.EMPTY); // FSM's name for "signed in, work area empty"
    expect(wa.agent).toBe('HA');
    expect(resp).toContain('HA');
    expect(resp).toContain('7K9S');
    expect(resp).toContain('SIGNED ON');
  });

  it('SOF transitions back to SIGNED_OFF, resets the work area, returns a signoff line', () => {
    const { host, wa } = newHost();
    host.process('SON/ZHA', wa);
    expect(wa.agent).toBe('HA');
    const resp = host.process('SOF', wa);
    expect(wa.state()).toBe(SessionState.SIGNED_OFF);
    // wa.reset() doesn't currently clear `agent` — the signoff response is rendered
    // with the captured agent before reset, which is what we test next.
    expect(resp).toContain('SIGNED OFF');
    expect(resp).toContain('7K9S');
    expect(resp).toContain('HA'); // agent name preserved in the signoff line
  });

  it('SOF/Z<override> also signs off (override form acts like plain SOF)', () => {
    const { host, wa } = newHost();
    host.process('SON/ZHA', wa);
    const resp = host.process('SOF/ZGL4HA', wa);
    expect(wa.state()).toBe(SessionState.SIGNED_OFF);
    expect(resp).toContain('SIGNED OFF');
  });

  it('unrecognized entry returns FORMAT', () => {
    const { host, wa } = newHost();
    expect(host.process('NOPE', wa)).toBe('FORMAT');
  });

  it('a now-supported verb (availability) no longer returns FORMAT', () => {
    const { host, wa } = newHost();
    host.process('SON/ZHA', wa);
    const resp = host.process('A15JUNJFKLAX', wa);
    expect(resp).not.toBe('FORMAT');
    expect(resp).toContain('JFK');
    expect(resp).toContain('LAX');
  });

  it("the dialect's chain-halting set includes FORMAT and NOT IMPLEMENTED", () => {
    const d = new GalileoDialect();
    expect(d.isErrorResponse('FORMAT')).toBe(true);
    expect(d.isErrorResponse('NOT IMPLEMENTED — galileo dialect')).toBe(true);
    expect(d.isErrorResponse('HA SIGNED ON AT 7K9S')).toBe(false);
  });

  it('GdsHost still defaults to Sabre when no dialect is injected', () => {
    const host = new GdsHost({ port: 0, logLevel: 'error' });
    expect(host.dialect.id).toBe('sabre');
  });
});
