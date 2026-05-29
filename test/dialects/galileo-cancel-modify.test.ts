import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo cancel-family parsing', async () => {
  it('parses X2 as single-segment cancel', async () => {
    const r = parseGalileoEntry('X2');
    expect(r.kind).toBe('cancel');
    if (r.kind === 'cancel') {
      expect(r.mode).toBe('segment');
      expect(r.segments).toEqual([2]);
    }
  });

  it('parses X9-11 as range', async () => {
    const r = parseGalileoEntry('X9-11');
    if (r.kind === 'cancel') {
      expect(r.mode).toBe('range');
      expect(r.segments).toEqual([9, 10, 11]);
    }
  });

  it('parses period-separated list X1.3.5', async () => {
    const r = parseGalileoEntry('X1.3.5');
    if (r.kind === 'cancel') {
      expect(r.mode).toBe('multiple');
      expect(r.segments).toEqual([1, 3, 5]);
    }
  });

  it('parses combined list+range X2.5-7 (Mini Guide example)', async () => {
    const r = parseGalileoEntry('X2.5-7');
    if (r.kind === 'cancel') {
      expect(r.mode).toBe('multiple');
      expect(r.segments).toEqual([2, 5, 6, 7]);
    }
  });

  it('parses XI as itinerary cancel', async () => {
    const r = parseGalileoEntry('XI');
    if (r.kind === 'cancel') expect(r.mode).toBe('itinerary');
  });

  it('parses XA as all-air cancel (note: Sabre uses XIA)', async () => {
    const r = parseGalileoEntry('XA');
    if (r.kind === 'cancel') expect(r.mode).toBe('all_air');
  });

  it('rejects malformed X-forms', async () => {
    expect(() => parseGalileoEntry('X')).toThrow(); // empty
    expect(() => parseGalileoEntry('X0')).toThrow(); // zero segment
    expect(() => parseGalileoEntry('X5-1')).toThrow(); // descending range
    expect(() => parseGalileoEntry('X1.A')).toThrow(); // non-numeric token
  });
});

describe('Galileo modify-family parsing', async () => {
  it('parses @1HK as segment status change', async () => {
    const r = parseGalileoEntry('@1HK');
    expect(r.kind).toBe('segment_status');
    if (r.kind === 'segment_status') {
      expect(r.segment).toBe(1);
      expect(r.status).toBe('HK');
    }
  });

  it('parses @2XK as passive cancel', async () => {
    const r = parseGalileoEntry('@2XK');
    expect(r.kind).toBe('passive_cancel');
    if (r.kind === 'passive_cancel') expect(r.segments).toEqual([2]);
  });

  it('rejects deferred @-forms (class rebook, date change, etc.)', async () => {
    expect(() => parseGalileoEntry('@2/F')).toThrow(); // class rebook deferred
    expect(() => parseGalileoEntry('@2/23JAN')).toThrow(); // date deferred
    expect(() => parseGalileoEntry('@A/J')).toThrow(); // all-segments deferred
    expect(() => parseGalileoEntry('@0HK')).toThrow(); // zero segment
  });
});

describe('Galileo dialect — cancel + modify through the host', async () => {
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

  async function sellTwoSegments() {
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa); // segment 1
    await host.process('A20JUNLAXJFK', wa);
    await host.process('N1Y1', wa); // segment 2
    expect(wa.pnr.segments.length).toBe(2);
  }

  it('X2 cancels segment 2 and renumbers', async () => {
    await sellTwoSegments();
    const resp = await host.process('X2', wa);
    expect(wa.pnr.segments.length).toBe(1);
    expect(wa.pnr.segments[0].segmentNumber).toBe(1);
    expect(resp).toContain('JFK'); // segment 1 still has JFK origin
  });

  it('XI cancels the entire itinerary', async () => {
    await sellTwoSegments();
    const resp = await host.process('XI', wa);
    expect(resp).toBe('ITINERARY CANCELLED');
    expect(wa.pnr.segments.length).toBe(0);
  });

  it('XA cancels all air segments (same as XI when only air)', async () => {
    await sellTwoSegments();
    const resp = await host.process('XA', wa);
    expect(resp).toBe('ITINERARY CANCELLED');
    expect(wa.pnr.segments.length).toBe(0);
  });

  it('X with no itinerary returns NEED_ITINERARY', async () => {
    expect(await host.process('X1', wa)).toContain('ITINERARY');
  });

  it('X9 (segment-out-of-range) returns SEGMENT NOT IN ITINERARY', async () => {
    await sellTwoSegments();
    expect(await host.process('X9', wa)).toBe('SEGMENT NUMBER NOT IN ITINERARY');
    expect(wa.pnr.segments.length).toBe(2); // unchanged
  });

  it('@1HK changes segment 1 status to HK', async () => {
    await sellTwoSegments();
    await host.process('@1HK', wa);
    expect(wa.pnr.segments[0].status).toBe('HK');
    expect(wa.pnr.segments[1].status).toBe('SS'); // unchanged
  });

  it('@1XK passive-cancels segment 1 and renumbers', async () => {
    await sellTwoSegments();
    await host.process('@1XK', wa);
    expect(wa.pnr.segments.length).toBe(1);
    expect(wa.pnr.segments[0].segmentNumber).toBe(1);
    expect(wa.pnr.segments[0].destination).toBe('JFK'); // the original seg 2
  });

  it('@1ZZ (unknown status) returns INVALID STATUS CODE', async () => {
    await sellTwoSegments();
    expect(await host.process('@1ZZ', wa)).toBe('INVALID STATUS CODE');
  });

  it('cross-area: cancel in B does not touch A', async () => {
    await sellTwoSegments();
    await host.process('SB', wa);
    expect(wa.pnr.segments.length).toBe(0);
    // No segments to cancel in B
    expect(await host.process('X1', wa)).toContain('ITINERARY');
    // A still has 2 segments
    await host.process('SA', wa);
    expect(wa.pnr.segments.length).toBe(2);
  });
});
