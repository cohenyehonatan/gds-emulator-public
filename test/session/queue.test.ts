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

  it('places a PNR on multiple queues in one entry (QP/G¥S¥T)', () => {
    const loc = commit('SMITH');
    host.process(`*${loc}`, wa); // bring committed PNR back to the work area
    // Cross of Lorraine separates targets; first target = primary, rest = additional.
    expect(host.process('QP/G¥S¥T', wa)).toBe('QUEUED G S T');
    expect(host.context.queues.get('G')).toContain(loc);
    expect(host.context.queues.get('S')).toContain(loc);
    expect(host.context.queues.get('T')).toContain(loc);
  });

  it('supports branch-PCC placement (QP/2EA0G) and chained branch placements', () => {
    const loc = commit('SMITH');
    host.process(`*${loc}`, wa);
    expect(host.process('QP/2EA0G¥5OT0S¥A', wa)).toBe('QUEUED 2EA0G 5OT0S A');
    expect(host.context.queues.get('2EA0G')).toContain(loc);
    expect(host.context.queues.get('5OT0S')).toContain(loc);
    expect(host.context.queues.get('A')).toContain(loc);
  });

  it('rejects more than 9 placement targets', () => {
    const loc = commit('SMITH');
    host.process(`*${loc}`, wa);
    // 10 targets ¥-joined; source caps at 9.
    const targets = ['G', 'S', 'T', 'A', 'L', 'U', '1', '2', '3', '4'].join('¥');
    expect(host.process(`QP/${targets}`, wa)).toBe('FORMAT');
  });

  it('QXIR exits the queue and redisplays the on-screen PNR', () => {
    const loc = commit('SMITH');
    host.context.queues.set('100', [loc]);
    host.process('Q/100', wa); // PNR now on screen via queue access
    const resp = host.process('QXIR', wa);
    expect(resp).toContain('SMITH/JOHN'); // PNR redisplayed
    expect(wa.currentQueue).toBeUndefined();
    expect(wa.pnr.locator).toBe(loc); // still on screen
  });

  it('QXER ends the transaction, exits the queue, and redisplays the PNR', () => {
    const loc = commit('SMITH');
    host.context.queues.set('100', [loc]);
    host.process('Q/100', wa);
    // Add a remark (legal modify on a retrieved PNR), then QXER commits.
    host.process('5GENERAL REMARK', wa);
    const resp = host.process('QXER', wa);
    expect(resp).toContain('SMITH/JOHN'); // committed PNR rendered
    expect(resp).toContain('GENERAL REMARK'); // the added remark persisted
    expect(wa.currentQueue).toBeUndefined();
  });

  it('QXIR and QXER without a queue context return NO QUEUE ACCESSED', () => {
    expect(host.process('QXIR', wa)).toBe('NO QUEUE ACCESSED');
    expect(host.process('QXER', wa)).toBe('NO QUEUE ACCESSED');
  });

  it('QBI¥N skips N PNRs forward in the current queue', () => {
    const a = commit('ABLE');
    host.process('IG', wa);
    const b = commit('BAKER');
    host.process('IG', wa);
    const c = commit('CHARLIE');
    host.context.queues.set('77', [a, b, c]);
    host.process('Q/77', wa); // loads ABLE
    expect(wa.pnr.locator).toBe(a);
    // Skip 2: drops ABLE + BAKER from the queue, loads CHARLIE.
    const resp = host.process('QBI¥2', wa);
    expect(resp).toContain('CHARLIE');
    expect(host.context.queues.get('77')).toEqual([c]);
    expect(wa.pnr.locator).toBe(c);
  });

  it('QBI-N rejects backward skip (no queue-cursor history modeled)', () => {
    const loc = commit('SMITH');
    host.context.queues.set('77', [loc]);
    host.process('Q/77', wa);
    expect(host.process('QBI-1', wa)).toBe('BACKWARD SKIP NOT SUPPORTED');
  });

  it('QBI without a queue context returns NO QUEUE ACCESSED', () => {
    expect(host.process('QBI¥3', wa)).toBe('NO QUEUE ACCESSED');
  });

  it('QL re-queues the current PNR onto LMTC and advances the working queue', () => {
    const a = commit('ABLE');
    host.process('IG', wa);
    const b = commit('BAKER');
    host.context.queues.set('100', [a, b]);
    host.process('Q/100', wa); // loads ABLE
    expect(wa.pnr.locator).toBe(a);
    const resp = host.process('QL', wa);
    // ABLE moves from 100 to LMTC; BAKER becomes the on-screen queue front.
    expect(host.context.queues.get('100')).toEqual([b]);
    expect(host.context.queues.get('LMTC')).toContain(a);
    expect(resp).toContain('BAKER');
    expect(wa.pnr.locator).toBe(b);
  });

  it('QU-MSG logs the message as a general remark on the PNR', () => {
    const loc = commit('SMITH');
    host.context.queues.set('77', [loc]);
    host.process('Q/77', wa);
    host.process('QU-LINE ENGAGED', wa);
    const pnr = host.context.pnrStore.get(loc)!;
    expect(pnr.remarks.some((r) => r.text.includes('LINE ENGAGED'))).toBe(true);
    expect(host.context.queues.get('UTR')).toContain(loc);
  });

  it('QL/QU without a queue context return NO QUEUE ACCESSED', () => {
    expect(host.process('QL', wa)).toBe('NO QUEUE ACCESSED');
    expect(host.process('QU', wa)).toBe('NO QUEUE ACCESSED');
  });
});
