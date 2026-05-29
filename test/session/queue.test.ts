import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('queue parsing', async () => {
  it('parses place, access, remove, and exit', async () => {
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

  it('rejects a malformed queue entry', async () => {
    expect(() => parseEntry('QZ123')).toThrow();
  });
});

describe('queue place / access / work', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
  });

  /** Build + commit a one-segment PNR for the given surname; returns the locator. */
  async function commit(surname: string): string {
    await host.process('IG', wa); // start from an empty work area
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y1', wa);
    await host.process(`-${surname}/JOHN MR`, wa);
    await host.process('9305-555-1212-H', wa);
    await host.process('7TAW15JUN/', wa);
    await host.process('6P', wa);
    return await host.process('E', wa);
  }

  it('places a retrieved PNR on a queue and accesses it from another area', async () => {
    const loc = await commit('SMITH');
    await host.process(`*${loc}`, wa); // bring it back on screen
    expect(await host.process('QP/100', wa)).toBe('QUEUED 100');
    expect(host.context.backend.queues.get('100')).toEqual([loc]);

    const w2 = host.newWorkArea();
    await host.process('SI*9999', w2);
    const accessed = await host.process('Q/100', w2);
    expect(accessed).toContain('QUEUE 100 - 1 PNR');
    expect(accessed).toContain('SMITH/JOHN');
    expect(accessed).toContain(loc);
    expect(w2.currentQueue).toBe('100');

    expect(await host.process('*Q', w2)).toBe('QUEUE 100 - 1 PNR');

    // QR removes the on-screen PNR and the queue is now empty.
    expect(await host.process('QR', w2)).toBe('QUEUE 100 EMPTY');
    expect(w2.currentQueue).toBeUndefined();
    expect(host.context.backend.queues.get('100')).toEqual([]);
  });

  it('works through multiple PNRs in placement order', async () => {
    const a = await commit('ABLE');
    await host.process(`*${a}`, wa);
    await host.process('QP/50', wa);
    const b = await commit('BAKER');
    await host.process(`*${b}`, wa);
    await host.process('QP/50', wa);

    const w2 = host.newWorkArea();
    await host.process('SI*9999', w2);
    expect(await host.process('Q/50', w2)).toContain('ABLE/JOHN'); // first placed, first served
    expect(await host.process('QR', w2)).toContain('BAKER/JOHN'); // advance to the next
    expect(await host.process('QR', w2)).toBe('QUEUE 50 EMPTY'); // none left
  });

  it('does not place the same PNR twice', async () => {
    const loc = await commit('SMITH');
    await host.process(`*${loc}`, wa);
    await host.process('QP/100', wa);
    await host.process('QP/100', wa);
    expect(host.context.backend.queues.get('100')).toEqual([loc]);
  });

  it('refuses to place a PNR that has not been committed', async () => {
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y1', wa);
    await host.process('-SMITH/JOHN MR', wa);
    expect(await host.process('QP/100', wa)).toBe('FINISH OR IGNORE');
  });

  it('reports an empty queue and a missing access context', async () => {
    expect(await host.process('Q/77', wa)).toBe('QUEUE 77 EMPTY');
    // Empty-queue access leaves no context (cursor model: nothing to point at).
    expect(await host.process('QR', wa)).toBe('NO QUEUE ACCESSED');
    expect(await host.process('*Q', host.newWorkArea())).toBe('NO QUEUE ACCESSED');
  });

  it('exits a queue with QX', async () => {
    await commit('SMITH');
    const loc = host.context.backend.pnrs.findBySurname('SMITH')[0].locator!;
    host.context.backend.queues.set('100', [loc]);
    await host.process('Q/100', wa);
    expect(wa.currentQueue).toBe('100');
    expect(await host.process('QX', wa)).toBe('QUEUE 100 EXITED');
    expect(wa.currentQueue).toBeUndefined();
    expect(await host.process('QX', wa)).toBe('NO QUEUE ACCESSED');
  });

  it('places a PNR on multiple queues in one entry (QP/G¥S¥T)', async () => {
    const loc = await commit('SMITH');
    await host.process(`*${loc}`, wa); // bring committed PNR back to the work area
    // Cross of Lorraine separates targets; first target = primary, rest = additional.
    expect(await host.process('QP/G¥S¥T', wa)).toBe('QUEUED G S T');
    expect(host.context.backend.queues.get('G')).toContain(loc);
    expect(host.context.backend.queues.get('S')).toContain(loc);
    expect(host.context.backend.queues.get('T')).toContain(loc);
  });

  it('supports branch-PCC placement (QP/2EA0G) and chained branch placements', async () => {
    const loc = await commit('SMITH');
    await host.process(`*${loc}`, wa);
    expect(await host.process('QP/2EA0G¥5OT0S¥A', wa)).toBe('QUEUED 2EA0G 5OT0S A');
    expect(host.context.backend.queues.get('2EA0G')).toContain(loc);
    expect(host.context.backend.queues.get('5OT0S')).toContain(loc);
    expect(host.context.backend.queues.get('A')).toContain(loc);
  });

  it('rejects more than 9 placement targets', async () => {
    const loc = await commit('SMITH');
    await host.process(`*${loc}`, wa);
    // 10 targets ¥-joined; source caps at 9.
    const targets = ['G', 'S', 'T', 'A', 'L', 'U', '1', '2', '3', '4'].join('¥');
    expect(await host.process(`QP/${targets}`, wa)).toBe('FORMAT');
  });

  it('QXIR exits the queue and redisplays the on-screen PNR', async () => {
    const loc = await commit('SMITH');
    host.context.backend.queues.set('100', [loc]);
    await host.process('Q/100', wa); // PNR now on screen via queue access
    const resp = await host.process('QXIR', wa);
    expect(resp).toContain('SMITH/JOHN'); // PNR redisplayed
    expect(wa.currentQueue).toBeUndefined();
    expect(wa.pnr.locator).toBe(loc); // still on screen
  });

  it('QXER ends the transaction, exits the queue, and redisplays the PNR', async () => {
    const loc = await commit('SMITH');
    host.context.backend.queues.set('100', [loc]);
    await host.process('Q/100', wa);
    // Add a remark (legal modify on a retrieved PNR), then QXER commits.
    await host.process('5GENERAL REMARK', wa);
    const resp = await host.process('QXER', wa);
    expect(resp).toContain('SMITH/JOHN'); // committed PNR rendered
    expect(resp).toContain('GENERAL REMARK'); // the added remark persisted
    expect(wa.currentQueue).toBeUndefined();
  });

  it('QXIR and QXER without a queue context return NO QUEUE ACCESSED', async () => {
    expect(await host.process('QXIR', wa)).toBe('NO QUEUE ACCESSED');
    expect(await host.process('QXER', wa)).toBe('NO QUEUE ACCESSED');
  });

  it('QBI¥N moves the cursor forward without removing PNRs from the queue', async () => {
    const a = await commit('ABLE');
    await host.process('IG', wa);
    const b = await commit('BAKER');
    await host.process('IG', wa);
    const c = await commit('CHARLIE');
    host.context.backend.queues.set('77', [a, b, c]);
    await host.process('Q/77', wa); // loads ABLE; cursor=0
    expect(wa.pnr.locator).toBe(a);
    // Cursor advances 2 → on CHARLIE; queue list unchanged ("ignores", not "removes").
    const resp = await host.process('QBI¥2', wa);
    expect(resp).toContain('CHARLIE');
    expect(host.context.backend.queues.get('77')).toEqual([a, b, c]); // intact
    expect(wa.pnr.locator).toBe(c);
    expect(wa.queueCursor).toBe(2);
  });

  it('QBI-N navigates backward to previously skipped PNRs', async () => {
    const a = await commit('ABLE');
    await host.process('IG', wa);
    const b = await commit('BAKER');
    await host.process('IG', wa);
    const c = await commit('CHARLIE');
    host.context.backend.queues.set('77', [a, b, c]);
    await host.process('Q/77', wa); // ABLE, cursor=0
    await host.process('QBI¥2', wa); // forward 2 → CHARLIE, cursor=2
    const back = await host.process('QBI-2', wa); // back 2 → ABLE, cursor=0
    expect(back).toContain('ABLE');
    expect(wa.pnr.locator).toBe(a);
    expect(wa.queueCursor).toBe(0);
    expect(host.context.backend.queues.get('77')).toEqual([a, b, c]); // still intact
  });

  it('QBI-N clamps to the start of the queue (no underflow)', async () => {
    const loc = await commit('SMITH');
    host.context.backend.queues.set('77', [loc]);
    await host.process('Q/77', wa);
    expect(wa.queueCursor).toBe(0);
    await host.process('QBI-9', wa);
    expect(wa.queueCursor).toBe(0); // still on the same PNR
    expect(wa.pnr.locator).toBe(loc);
  });

  it('QBI¥N past the end exits the queue', async () => {
    const a = await commit('ABLE');
    await host.process('IG', wa);
    const b = await commit('BAKER');
    host.context.backend.queues.set('77', [a, b]);
    await host.process('Q/77', wa);
    expect(await host.process('QBI¥9', wa)).toBe('QUEUE 77 EMPTY');
    expect(wa.currentQueue).toBeUndefined();
  });

  it('QBI without a queue context returns NO QUEUE ACCESSED', async () => {
    expect(await host.process('QBI¥3', wa)).toBe('NO QUEUE ACCESSED');
  });

  it('QL re-queues the current PNR onto LMTC and advances the working queue', async () => {
    const a = await commit('ABLE');
    await host.process('IG', wa);
    const b = await commit('BAKER');
    host.context.backend.queues.set('100', [a, b]);
    await host.process('Q/100', wa); // loads ABLE
    expect(wa.pnr.locator).toBe(a);
    const resp = await host.process('QL', wa);
    // ABLE moves from 100 to LMTC; BAKER becomes the on-screen queue front.
    expect(host.context.backend.queues.get('100')).toEqual([b]);
    expect(host.context.backend.queues.get('LMTC')).toContain(a);
    expect(resp).toContain('BAKER');
    expect(wa.pnr.locator).toBe(b);
  });

  it('QU-MSG logs the message as a general remark on the PNR', async () => {
    const loc = await commit('SMITH');
    host.context.backend.queues.set('77', [loc]);
    await host.process('Q/77', wa);
    await host.process('QU-LINE ENGAGED', wa);
    const pnr = host.context.backend.pnrs.get(loc)!;
    expect(pnr.remarks.some((r) => r.text.includes('LINE ENGAGED'))).toBe(true);
    expect(host.context.backend.queues.get('UTR')).toContain(loc);
  });

  it('QL/QU without a queue context return NO QUEUE ACCESSED', async () => {
    expect(await host.process('QL', wa)).toBe('NO QUEUE ACCESSED');
    expect(await host.process('QU', wa)).toBe('NO QUEUE ACCESSED');
  });
});
