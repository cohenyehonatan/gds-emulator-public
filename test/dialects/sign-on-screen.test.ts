import { describe, it, expect } from 'vitest';
import { SabreDialect } from '../../src/dialects/sabre/index.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { ApolloDialect } from '../../src/dialects/apollo/index.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';
import { WorldspanDialect } from '../../src/dialects/worldspan/index.js';
import type { Dialect } from '../../src/dialects/dialect.js';

/**
 * Every dialect provides a sign-on screen (shown on (re-)connect before
 * any functional entry). Sabre's is the verbatim AGENT SIGN IN mask; the
 * other four are reconstructed prompts that must embed their sourced
 * sign-on command so the operator knows exactly what to type.
 */
describe('Dialect.signOnScreen', () => {
  const dialects: Dialect[] = [
    new SabreDialect(),
    new GalileoDialect(),
    new ApolloDialect(),
    new AmadeusDialect(),
    new WorldspanDialect(),
  ];

  it('every dialect provides a non-empty multi-line sign-on screen', () => {
    for (const d of dialects) {
      expect(d.signOnScreen.length, d.id).toBeGreaterThan(0);
      expect(d.signOnScreen.includes('\n'), d.id).toBe(true);
    }
  });

  it('Sabre renders the verbatim AGENT SIGN IN mask', () => {
    const s = new SabreDialect().signOnScreen;
    expect(s).toContain('AGENT SIGN IN');
    expect(s).toContain('CURRENT PASSCODE');
    expect(s).toContain('DUTY CODE');
    expect(s).toContain('SI*'); // the sign-in entry
  });

  it('each dialect embeds its sourced sign-on command', () => {
    expect(new GalileoDialect().signOnScreen).toContain('SON/Z');
    expect(new ApolloDialect().signOnScreen).toContain('SON/Z');
    expect(new AmadeusDialect().signOnScreen).toMatch(/JI<.*>|JI\*/);
    expect(new WorldspanDialect().signOnScreen).toContain('BSI');
  });

  it('each screen announces sign-on is required (so the gate is discoverable)', () => {
    for (const d of dialects) {
      expect(d.signOnScreen.toUpperCase(), d.id).toMatch(/SIGN ?ON|SIGN IN/);
    }
  });
});
