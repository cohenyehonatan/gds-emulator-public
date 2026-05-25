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

  it('rejects end transaction with the verified ticketing string', () => {
    host.process('SI*4321', wa);
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa);
    host.process('-SMITH/JOHN MR', wa);
    host.process('9305-555-1212-H', wa);
    host.process('6P', wa); // no ticketing field
    expect(host.process('ER', wa)).toBe('NEED TICKETING/TIMELIMIT - USE 7 OR 8');
  });

  it('rejects when name count does not match seats sold (verified string)', () => {
    host.process('SI*4321', wa);
    host.process('115JUNJFKLAX', wa);
    host.process('02Y1', wa); // 2 seats sold from line 1
    host.process('-SMITH/JOHN MR', wa); // only 1 passenger
    host.process('9305-555-1212-H', wa);
    host.process('7TAW15JUN/', wa);
    host.process('6P', wa);
    expect(host.process('ER', wa)).toBe('NUMBER OF NAMES NOT EQUAL TO RESERVATIONS');
  });

  it('committed PNR redisplay shows the signature line with the locator', () => {
    const display = bookComplete();
    // A0UC.A0UC*4321 <time>/<date> <LOCATOR>
    expect(display).toMatch(/A0UC\.A0UC\*4321 \d{4}\/\d{2}[A-Z]{3}\d{2} [A-Z]{6}$/m);
    expect(display).toContain('TKT/TIME LIMIT');
    expect(display).toContain('PHONES');
    expect(display).toContain('RECEIVED FROM - P');
  });

  it('uses 12h + letter DOW on the sell echo, 24h + numeric DOW elsewhere', () => {
    host.process('SI*4321', wa);
    host.process('115JUNJFKLAX', wa);

    // sell echo: 12-hour + letter day-of-week (workbook "EXAMPLE SOLD SEGMENT")
    const sell = host.process('01Y1', wa); // B6 615 departs 700A
    expect(sell).toContain('700A');
    expect(sell).toMatch(/15JUN [A-Z] JFKLAX/); // single-letter DOW

    // stored itinerary display: 24-hour + numeric day-of-week
    const itin = host.process('*I', wa);
    expect(itin).toContain('0700');
    expect(itin).not.toContain('700A');
    expect(itin).toMatch(/15JUN \d JFKLAX/); // numeric DOW
  });

  it('shows availability times in 24-hour', () => {
    host.process('SI*4321', wa);
    const avail = host.process('115JUNJFKLAX', wa);
    expect(avail).toContain('0700'); // B6 615 07:00
    expect(avail).not.toContain('700A');
  });

  it('prepends the home city to a phone, or an explicit city if entered', () => {
    host.process('SI*4321', wa);
    host.process('9305-555-1212-H', wa); // no city → home city NYC
    expect(host.process('*P', wa)).toContain('1.NYC305-555-1212-H');
    host.process('9LON020-7946-0000-B', wa); // explicit city LON
    const p = host.process('*P', wa);
    expect(p).toContain('2.LON020-7946-0000-B');
  });

  it('renders a next-day arrival on an overnight segment', () => {
    host.process('SI*4321', wa);
    host.process('115JUNDFWLHR', wa); // BA 192 520P → 800A next day
    const sell = host.process('01Y1', wa);
    expect(sell).toMatch(/800A  16JUN [A-Z]\/E$/); // 12h + letter arrival DOW
    const itin = host.process('*I', wa);
    expect(itin).toMatch(/0800  16JUN \d \/E$/); // 24h + numeric arrival DOW
  });
});
