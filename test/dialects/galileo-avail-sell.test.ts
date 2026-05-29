import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo availability parsing (A...)', () => {
  it('parses A<DDMMM><orig><dest> as basic availability', () => {
    const r = parseGalileoEntry('A22JUNBRUATH');
    expect(r.kind).toBe('availability');
    if (r.kind === 'availability') {
      expect(r.mode).toBe('display');
      expect(r.origin).toBe('BRU');
      expect(r.destination).toBe('ATH');
      expect(r.date?.raw).toBe('22JUN');
    }
  });

  it('parses the carrier-filter form A<DDMMM><orig><dest>/<carrier>', () => {
    const r = parseGalileoEntry('A20JUNAMSSIN/KL');
    if (r.kind === 'availability') {
      expect(r.carriers).toEqual(['KL']);
    }
  });

  it('accepts the AD/AJ/AA/AF sort-prefix forms', () => {
    for (const p of ['AD', 'AJ', 'AA', 'AF']) {
      const r = parseGalileoEntry(`${p}22JUNJFKLAX`);
      expect(r.kind).toBe('availability');
    }
  });

  it('rejects unknown prefixes', () => {
    expect(() => parseGalileoEntry('AZ22JUNJFKLAX')).toThrow();
    expect(() => parseGalileoEntry('A22JUNJFK')).toThrow(); // missing dest
    expect(() => parseGalileoEntry('AJFK')).toThrow(); // bare letters
  });
});

describe('Galileo sell parsing (N...)', () => {
  it('parses N<seats><class><line>', () => {
    const r = parseGalileoEntry('N1Y1');
    expect(r.kind).toBe('sell');
    if (r.kind === 'sell') {
      expect(r.seats).toBe(1);
      expect(r.bookingClass).toBe('Y');
      expect(r.line).toBe(1);
      expect(r.mode).toBe('availability');
    }
  });

  it('rejects N0Y1 (zero seats), NY1 (no seats digit), N1Y0 (zero line)', () => {
    expect(() => parseGalileoEntry('N0Y1')).toThrow();
    expect(() => parseGalileoEntry('NY1')).toThrow();
    expect(() => parseGalileoEntry('N1Y0')).toThrow();
  });
});

describe('Galileo dialect — availability + sell through the host', () => {
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

  it('A15JUNJFKLAX renders an availability with a recognizably Galileo header', () => {
    const resp = host.process('A15JUNJFKLAX', wa);
    expect(resp).toContain('JFK-LAX'); // Galileo uses dash, not slash
    expect(resp).toContain('15JUN');
    // The seeded inventory has B6/AA/UA on JFK-LAX:
    expect(resp).toMatch(/B6 615|AA 100|UA 240/);
  });

  it('A...//<carrier> filters availability to the named carrier', () => {
    const resp = host.process('A15JUNJFKLAX/AA', wa);
    expect(resp).toContain('AA');
    expect(resp).not.toMatch(/^\s*\d+ B6/m);
    expect(resp).not.toMatch(/^\s*\d+ UA/m);
  });

  it('A15JUNXXXYYY (no flights) returns NO FLIGHTS', () => {
    expect(host.process('A15JUNXXXYYY', wa)).toBe('NO FLIGHTS');
  });

  it('availability is cached so a subsequent N<seats><class><line> works', () => {
    host.process('A15JUNJFKLAX', wa);
    // Pick line 1 (B6 615) and book 1 seat Y class
    const resp = host.process('N1Y1', wa);
    expect(resp).toContain('B6');
    expect(resp).toContain('615');
    expect(resp).toContain('Y');
    expect(wa.pnr.segments.length).toBe(1);
    expect(wa.pnr.segments[0].carrier).toBe('B6');
    expect(wa.pnr.segments[0].bookingClass).toBe('Y');
    expect(wa.pnr.segments[0].seats).toBe(1);
    expect(wa.pnr.segments[0].status).toBe('SS');
  });

  it('N<line> without a cached avail returns NO AVAILABILITY DISPLAYED', () => {
    expect(host.process('N1Y1', wa)).toBe('NO AVAILABILITY DISPLAYED');
  });

  it('N<class> targeting a class with zero seats returns CLASS NOT AVAILABLE', () => {
    host.process('A15JUNJFKLAX', wa);
    // The seed has UA 240 line 3 with M=2; ask for 9 seats — should refuse
    expect(host.process('N9M3', wa)).toBe('CLASS NOT AVAILABLE');
  });

  it('cross-area state: availability cached in A does NOT leak into B', () => {
    host.process('A15JUNJFKLAX', wa);
    expect(wa.lastAvailability).toBeDefined();
    host.process('SB', wa);
    expect(wa.lastAvailability).toBeUndefined();
    expect(host.process('N1Y1', wa)).toBe('NO AVAILABILITY DISPLAYED');
  });

  it('cross-axis: same dialect+backend yields a sold segment in the slot A PNR', () => {
    host.process('A15JUNJFKLAX', wa);
    host.process('N1Y1', wa);
    expect(wa.pnr.segments[0].origin).toBe('JFK');
    expect(wa.pnr.segments[0].destination).toBe('LAX');
  });
});
