import { describe, it, expect, beforeEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

/** Connection availability + multi-leg sell (JFK-SFO has no nonstop in the seed). */
describe('connections', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
  });

  it('builds connection itineraries when no nonstop exists', async () => {
    const avail = await host.process('115JUNJFKSFO', wa);
    // via ORD (AA300 + AA350) and via DEN (UA500 + UA550)
    expect(avail).toContain('JFKORD');
    expect(avail).toContain('ORDSFO');
    expect(avail).toContain('JFKDEN');
    expect(avail).toContain('DENSFO');
    // four lines cached, two connection groups
    expect(wa.lastAvailability!.lines).toHaveLength(4);
    const groups = new Set(wa.lastAvailability!.lines.map((l) => l.connectionGroup));
    expect(groups).toEqual(new Set([1, 2]));
  });

  it('sells a full connection with * (both legs, same class)', async () => {
    await host.process('115JUNJFKSFO', wa);
    const resp = await host.process('01Y1*', wa);
    expect(wa.pnr.segments).toHaveLength(2);
    // Chunk 29: connections rank by elapsed journey time per EU Reg
    // 80/2009 Annex I 7(ii). The DEN routing (UA500+UA550, 5h00
    // elapsed) beats ORD (AA300+AA350, 5h45), so line 1 is via DEN.
    expect(wa.pnr.segments[0].destination).toBe('DEN');
    expect(wa.pnr.segments[1].origin).toBe('DEN');
    expect(wa.pnr.segments[1].destination).toBe('SFO');
    expect(wa.pnr.segments.every((s) => s.status === 'SS')).toBe(true);
    expect(resp.split('\n')).toHaveLength(2); // both legs echoed
  });

  it('sells each leg in a different class with explicit pairs (01Y1F2)', async () => {
    await host.process('115JUNJFKSFO', wa);
    await host.process('01Y1F2', wa);
    expect(wa.pnr.segments).toHaveLength(2);
    expect(wa.pnr.segments[0].bookingClass).toBe('Y');
    expect(wa.pnr.segments[1].bookingClass).toBe('F');
  });

  it('rejects * on a line that is not a connection', async () => {
    await host.process('115JUNJFKLAX', wa); // nonstops only
    expect(await host.process('01Y1*', wa)).toContain('NOT A CONNECTION');
    expect(wa.pnr.segments).toHaveLength(0);
  });

  it('connection passenger count still gates end transaction', async () => {
    await host.process('115JUNJFKSFO', wa);
    await host.process('01Y1*', wa); // 1 seat, two legs
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('9305-555-1212-H', wa);
    await host.process('7TAW15JUN/', wa);
    await host.process('6P', wa);
    const resp = await host.process('E', wa);
    expect(resp).toMatch(/^[A-Z]{6}$/); // commits cleanly (1 pax == 1 seat per leg)
  });
});
