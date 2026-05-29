import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('move / insert segments (/)', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
  });

  async function bookTwo(): void {
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y1', wa); // seg 1: B6 615 JFK-LAX
    await host.process('120JUNLAXJFK', wa);
    await host.process('01Y1', wa); // seg 2: DL 422 LAX-JFK
  }

  it('parses /<after>/<from>[-<to>]', async () => {
    const e = parseEntry('/0/2');
    expect(e.kind).toBe('move');
    if (e.kind === 'move') expect(e).toMatchObject({ after: 0, from: 2, to: undefined });
    const r = parseEntry('/0/2-4');
    if (r.kind === 'move') expect(r).toMatchObject({ after: 0, from: 2, to: 4 });
  });

  it('moves a segment to the front (/0/2) and renumbers', async () => {
    await bookTwo();
    await host.process('/0/2', wa);
    expect(wa.pnr.segments[0].carrier).toBe('DL'); // moved to front
    expect(wa.pnr.segments[1].carrier).toBe('B6');
    expect(wa.pnr.segments.map((s) => s.segmentNumber)).toEqual([1, 2]);
  });

  it('rejects a move with a bad segment number / no itinerary', async () => {
    await bookTwo();
    expect(await host.process('/0/9', wa)).toContain('SEGMENT');
    const fresh = host.newWorkArea();
    await host.process('SI*4321', fresh);
    expect(await host.process('/0/1', fresh)).toContain('NO ITINERARY');
  });
});
