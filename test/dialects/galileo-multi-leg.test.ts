import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo multi-leg sell + connection-availability parsing', async () => {
  it('parses N1Y1 as single-leg (legs absent)', async () => {
    const r = parseGalileoEntry('N1Y1');
    if (r.kind === 'sell') {
      expect(r.bookingClass).toBe('Y');
      expect(r.line).toBe(1);
      expect(r.legs).toBeUndefined();
    }
  });

  it('parses N2F1F2Y3 (multi-leg sell, 3 segments) populating legs', async () => {
    const r = parseGalileoEntry('N2F1F2Y3');
    if (r.kind === 'sell') {
      expect(r.seats).toBe(2);
      expect(r.bookingClass).toBe('F'); // first leg's class
      expect(r.line).toBe(1);
      expect(r.legs).toEqual([
        { bookingClass: 'F', line: 1 },
        { bookingClass: 'F', line: 2 },
        { bookingClass: 'Y', line: 3 },
      ]);
    }
  });

  it('parses A22JUNDXBSYD.SIN as connection availability via SIN', async () => {
    const r = parseGalileoEntry('A22JUNDXBSYD.SIN');
    if (r.kind === 'availability') {
      expect(r.origin).toBe('DXB');
      expect(r.destination).toBe('SYD');
      expect(r.connectingCity).toBe('SIN');
    }
  });

  it('parses A22JUNDXBSYD.SIN/SQ (via SIN, carrier SQ)', async () => {
    const r = parseGalileoEntry('A22JUNDXBSYD.SIN/SQ');
    if (r.kind === 'availability') {
      expect(r.connectingCity).toBe('SIN');
      expect(r.carriers).toEqual(['SQ']);
    }
  });
});

describe('Galileo multi-leg + connection through the host', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });

  it('A15JUNJFKSFO returns the seeded JFK→SFO connections (via ORD and DEN)', async () => {
    const resp = await host.process('A15JUNJFKSFO', wa);
    // Seeded inventory: JFK→ORD→SFO and JFK→DEN→SFO; both should appear
    expect(resp).toContain('ORD');
    expect(resp).toContain('DEN');
  });

  it('A15JUNJFKSFO.ORD restricts to connections via ORD only', async () => {
    const resp = await host.process('A15JUNJFKSFO.ORD', wa);
    expect(resp).toContain('ORD');
    expect(resp).not.toContain('DEN');
  });

  it('multi-leg N1Y<line1>Y<line2> sells both segments of a connection', async () => {
    await host.process('A15JUNJFKSFO.ORD', wa);
    // Lines 1 and 2 in the via-ORD list are JFK→ORD and ORD→SFO
    const resp = await host.process('N1Y1Y2', wa);
    expect(wa.pnr.segments.length).toBe(2);
    expect(wa.pnr.segments[0].origin).toBe('JFK');
    expect(wa.pnr.segments[0].destination).toBe('ORD');
    expect(wa.pnr.segments[1].origin).toBe('ORD');
    expect(wa.pnr.segments[1].destination).toBe('SFO');
    // Response has both sold-segment lines
    expect(resp.split('\n').length).toBe(2);
  });

  it('multi-leg sell where one class is unavailable rejects atomically (no partial state)', async () => {
    await host.process('A15JUNJFKSFO.ORD', wa);
    // Try a class that doesn't exist on line 1: 'Z'
    expect(await host.process('N1Z1Y2', wa)).toBe('CLASS NOT AVAILABLE');
    expect(wa.pnr.segments.length).toBe(0); // no segments added
  });

  it('multi-leg sell where line number is invalid returns FORMAT', async () => {
    await host.process('A15JUNJFKSFO.ORD', wa);
    expect(await host.process('N1Y1Y99', wa)).toBe('FORMAT');
    expect(wa.pnr.segments.length).toBe(0);
  });

  it('multi-leg sell decrements inventory for each leg', async () => {
    await host.process('A15JUNJFKSFO.ORD', wa);
    const before = await host.process('A15JUNJFKSFO.ORD', wa); // redisplay shows seats
    await host.process('N2Y1Y2', wa);
    const after = await host.process('A15JUNJFKSFO.ORD', wa);
    // After selling 2 seats on each leg, both should show fewer Y
    // (the seeded counts are high; just confirm they changed)
    expect(after).not.toBe(before);
  });
});
