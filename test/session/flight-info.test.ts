import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('flight info / verify parsing', () => {
  it('parses FLIFO, V*, VA*, VI*', () => {
    const flifo = parseEntry('2AA100/15JUN');
    expect(flifo.kind).toBe('flight_info');
    if (flifo.kind === 'flight_info') {
      expect(flifo).toMatchObject({ source: 'flight', carrier: 'AA', flightNumber: '100', date: '15JUN' });
    }
    const v = parseEntry('V*CY312/10MAR');
    if (v.kind === 'flight_info') expect(v).toMatchObject({ source: 'flight', carrier: 'CY', flightNumber: '312' });
    const va = parseEntry('VA*1-3');
    if (va.kind === 'flight_info') expect(va).toMatchObject({ source: 'availability', lines: [1, 2, 3] });
    const viAll = parseEntry('VI*');
    if (viAll.kind === 'flight_info') expect(viAll).toMatchObject({ source: 'itinerary', lines: undefined });
    const vi2 = parseEntry('VI*2');
    if (vi2.kind === 'flight_info') expect(vi2.lines).toEqual([2]);
  });
});

describe('flight info / verify in the work area', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
  });

  it('FLIFO looks up a flight from the schedule with elapsed time', () => {
    const resp = host.process('2AA100/15JUN', wa); // JFK-LAX 0800-1100
    expect(resp).toContain('AA100');
    expect(resp).toContain('JFKLAX 0800 1100 738');
    expect(resp).toContain('3.00'); // 3-hour elapsed
  });

  it('reports an unknown flight', () => {
    expect(host.process('2ZZ999/15JUN', wa)).toContain('FLIGHT NOT FOUND');
  });

  it('VI* verifies a booked segment, computing overnight elapsed', () => {
    host.process('SI*4321', wa);
    host.process('115JUNDFWLHR', wa); // BA 192 1720 -> 0800 next day
    host.process('01Y1', wa);
    const resp = host.process('VI*1', wa);
    expect(resp).toContain('BA192');
    expect(resp).toContain('14.40'); // overnight elapsed
  });

  it('VA* verifies an availability line', () => {
    host.process('SI*4321', wa);
    host.process('115JUNJFKLAX', wa);
    expect(host.process('VA*2', wa)).toContain('AA100'); // line 2 is AA 100
  });

  it('VCT* validates a healthy connection', () => {
    host.process('SI*4321', wa);
    host.process('115JUNJFKSFO', wa);
    host.process('01Y1*', wa); // AA300 + AA350, 90-min connect
    expect(host.process('VCT*', wa)).toBe('MINIMUM CONNECT TIME EDIT VALID FOR ALL CONNECTIONS');
  });

  it('VCT* flags a too-short connection', () => {
    host.process('SI*4321', wa);
    host.process('115JUNJFKORD', wa);
    host.process('01Y1', wa); // AA300 arrives ORD 1000A
    host.process('0AA360Y15JUNORDSFOSS1', wa); // AA360 departs ORD 1020A (20 min)
    expect(host.process('VCT*', wa)).toBe('INVALID CONNECT TIME SEGS 1 AND 2 - MINIMUM IS 45 MINUTES');
  });
});
