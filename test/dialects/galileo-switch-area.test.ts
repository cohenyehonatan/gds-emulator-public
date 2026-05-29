import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo SA-SE work-area switch parsing', () => {
  it('parses each of SA SB SC SD SE as switch_area', () => {
    for (const l of ['A', 'B', 'C', 'D', 'E']) {
      const r = parseGalileoEntry(`S${l}`);
      expect(r.kind).toBe('switch_area');
      if (r.kind === 'switch_area') expect(r.targetArea).toBe(l);
    }
  });

  it('SF rejects — Galileo configures 5 areas, not 6', () => {
    expect(() => parseGalileoEntry('SF')).toThrow();
  });

  it('SZ rejects (not a configured letter)', () => {
    expect(() => parseGalileoEntry('SZ')).toThrow();
  });

  it("doesn't claim SO (would collide with sign-off / Sabre's sign-out-all)", () => {
    expect(() => parseGalileoEntry('SO')).toThrow();
  });
});

describe('Galileo dialect — SA-SE through the host', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    wa = host.newWorkArea();
    host.process('SON/ZHA', wa);
  });

  it('SB switches to area B; SA switches back to A', () => {
    expect(wa.area).toBe('A');
    const respB = host.process('SB', wa);
    expect(wa.area).toBe('B');
    expect(respB).toBe('7K9S.7K9S*HA..B');
    const respA = host.process('SA', wa);
    expect(wa.area).toBe('A');
    expect(respA).toBe('7K9S.7K9S*HA..A');
  });

  it('SF returns FORMAT (parser-level — Galileo configures only A-E)', () => {
    const resp = host.process('SF', wa);
    expect(resp).toBe('FORMAT');
    expect(wa.area).toBe('A');
  });

  it('agent stays session-level across switches', () => {
    expect(wa.agent).toBe('HA');
    host.process('SC', wa);
    expect(wa.agent).toBe('HA');
  });

  it("SOF (sign off) in area B leaves A's machine-state alone", () => {
    host.process('SB', wa);
    host.process('SOF', wa);
    // After SOF in B, B's machine returns to SIGNED_OFF.
    // A still has its independent machine.
    host.process('SA', wa);
    // A was signed in via SON/ZHA at beforeEach; should still be EMPTY.
    // (resp is the signature line; we check via the state.)
    expect(wa.state().toString()).toContain('EMPTY');
  });
});
