import { describe, it, expect, beforeEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

/**
 * Workbook-grounded response formats: sign-in/out screens, the segment "/E"
 * marker, and the PNR signature line.
 */
describe('fidelity — workbook response formats', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' }); // default PCC A0UC
    wa = host.newWorkArea();
  });

  it('sign-in returns the PCC/agent signature screen', () => {
    const resp = host.process('SI*4321', wa);
    expect(resp).toContain('A0UC.A0UC*4321');
    expect(resp).toContain('A.B.C.D.E.F');
    expect(wa.agent).toBe('4321'); // leading '*' stripped
  });

  it('signs out of the current and all work areas', () => {
    host.process('SI*4321', wa);
    expect(host.process('SO', wa)).toBe('A SIGNED OUT');
    host.process('SI*4321', wa);
    expect(host.process('SO*', wa)).toBe('A.B.C.D.E.F..SIGNED OUT');
  });

  function bookComplete(): string {
    host.process('SI*4321', wa);
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa);
    host.process('-SMITH/JOHN MR', wa);
    host.process('9305-555-1212-H', wa);
    host.process('7TAW15JUN/', wa);
    host.process('6P', wa);
    return host.process('ER', wa); // redisplay
  }

  it('sold-segment lines carry the /E end-item marker', () => {
    host.process('SI*4321', wa);
    host.process('115JUNJFKLAX', wa);
    expect(host.process('01Y1', wa)).toMatch(/SS1 .* \/E$/);
  });

  it('committed PNR redisplay shows the signature line with the locator', () => {
    const display = bookComplete();
    // A0UC.A0UC*4321 <time>/<date> <LOCATOR>
    expect(display).toMatch(/A0UC\.A0UC\*4321 \d{4}\/\d{2}[A-Z]{3}\d{2} [A-Z]{6}$/m);
    expect(display).toContain('TKT/TIME LIMIT');
    expect(display).toContain('PHONES');
    expect(display).toContain('RECEIVED FROM - P');
  });
});
