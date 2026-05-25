import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('queue parsing', () => {
  it('parses place, access, remove, and exit', () => {
    const place = parseEntry('QP/100');
    if (place.kind === 'queue') expect(place).toMatchObject({ op: 'place', queue: '100' });
    const placePic = parseEntry('QP/44/9');
    if (placePic.kind === 'queue') expect(placePic).toMatchObject({ op: 'place', queue: '44', pic: '9' });
    const access = parseEntry('Q/10');
    if (access.kind === 'queue') expect(access).toMatchObject({ op: 'access', queue: '10' });
    expect(parseEntry('QR').kind).toBe('queue');
    if (parseEntry('QR').kind === 'queue') expect((parseEntry('QR') as any).op).toBe('remove');
    if (parseEntry('QXI').kind === 'queue') expect((parseEntry('QXI') as any).op).toBe('exit');
  });

  it('rejects a malformed queue entry', () => {
    expect(() => parseEntry('QZ123')).toThrow();
  });
});

describe('queue place / access / work', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*4321', wa);
  });

  /** Build + commit a one-segment PNR for the given surname; returns the locator. */
  function commit(surname: string): string {
    host.process('IG', wa); // start from an empty work area
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa);
    host.process(`-${surname}/JOHN MR`, wa);
    host.process('9305-555-1212-H', wa);
    host.process('7TAW15JUN/', wa);
    host.process('6P', wa);
    return host.process('E', wa);
  }

  it('places a retrieved PNR on a queue and accesses it from another area', () => {
    const loc = commit('SMITH');
    host.process(`*${loc}`, wa); // bring it back on screen
    expect(host.process('QP/100', wa)).toBe('QUEUED 100');
    expect(host.context.queues.get('100')).toEqual([loc]);

    const w2 = host.newWorkArea();
    host.process('SI*9999', w2);
    const accessed = host.process('Q/100', w2);
    expect(accessed).toContain('QUEUE 100 - 1 PNR');
    expect(accessed).toContain('SMITH/JOHN');
    expect(accessed).toContain(loc);
    expect(w2.currentQueue).toBe('100');

    expect(host.process('*Q', w2)).toBe('QUEUE 100 - 1 PNR');

    // QR removes the on-screen PNR and the queue is now empty.
    expect(host.process('QR', w2)).toBe('QUEUE 100 EMPTY');
    expect(w2.currentQueue).toBeUndefined();
    expect(host.context.queues.get('100')).toEqual([]);
  });

  it('works through multiple PNRs in placement order', () => {
    const a = commit('ABLE');
    host.process(`*${a}`, wa);
    host.process('QP/50', wa);
    const b = commit('BAKER');
    host.process(`*${b}`, wa);
    host.process('QP/50', wa);

    const w2 = host.newWorkArea();
    host.process('SI*9999', w2);
    expect(host.process('Q/50', w2)).toContain('ABLE/JOHN'); // first placed, first served
    expect(host.process('QR', w2)).toContain('BAKER/JOHN'); // advance to the next
    expect(host.process('QR', w2)).toBe('QUEUE 50 EMPTY'); // none left
  });

  it('does not place the same PNR twice', () => {
    const loc = commit('SMITH');
    host.process(`*${loc}`, wa);
    host.process('QP/100', wa);
    host.process('QP/100', wa);
    expect(host.context.queues.get('100')).toEqual([loc]);
  });

  it('refuses to place a PNR that has not been committed', () => {
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa);
    host.process('-SMITH/JOHN MR', wa);
    expect(host.process('QP/100', wa)).toBe('FINISH OR IGNORE');
  });

  it('reports an empty queue and a missing access context', () => {
    expect(host.process('Q/77', wa)).toBe('QUEUE 77 EMPTY');
    expect(host.process('QR', wa)).toBe('QUEUE 77 EMPTY'); // currentQueue=77 but empty
    expect(host.process('*Q', host.newWorkArea())).toBe('NO QUEUE ACCESSED');
  });

  it('exits a queue with QX', () => {
    commit('SMITH');
    const loc = host.context.pnrStore.findBySurname('SMITH')[0].locator!;
    host.context.queues.set('100', [loc]);
    host.process('Q/100', wa);
    expect(wa.currentQueue).toBe('100');
    expect(host.process('QX', wa)).toBe('QUEUE 100 EXITED');
    expect(wa.currentQueue).toBeUndefined();
    expect(host.process('QX', wa)).toBe('NO QUEUE ACCESSED');
  });
});
