import { describe, it, expect } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import { Pnr } from '../../src/models/pnr.js';

describe('Galileo queue metadata parsing', () => {
  it('QCA parses as count_all without threshold', () => {
    const r = parseGalileoEntry('QCA');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.op).toBe('count_all');
      expect(r.countThreshold).toBeUndefined();
    }
  });

  it('QCA*30 parses as count_all with threshold 30', () => {
    const r = parseGalileoEntry('QCA*30');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') {
      expect(r.op).toBe('count_all');
      expect(r.countThreshold).toBe(30);
    }
  });

  it('QW parses as where', () => {
    const r = parseGalileoEntry('QW');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') expect(r.op).toBe('where');
  });

  it('QPB* parses as display_titles', () => {
    const r = parseGalileoEntry('QPB*');
    expect(r.kind).toBe('queue');
    if (r.kind === 'queue') expect(r.op).toBe('display_titles');
  });

  it('rejects malformed QCA threshold', () => {
    expect(() => parseGalileoEntry('QCA*')).toThrow();
    expect(() => parseGalileoEntry('QCA*abc')).toThrow();
  });
});

describe('Galileo QCA — list all queues with content', () => {
  let host: GdsHost;
  let wa: ReturnType<GdsHost['newWorkArea']>;

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

  it('QCA on an empty system returns NO QUEUES', async () => {
    const resp = await host.process('QCA', wa);
    expect(resp).toBe('NO QUEUES');
  });

  it('QCA lists non-empty queues alphabetically with counts', async () => {
    host.backend.queues.set('43', ['ABC123', 'DEF456']);
    host.backend.queues.set('77', ['GHI789']);
    host.backend.queues.set('99', []); // empty — should be skipped

    const resp = await host.process('QCA', wa);
    const lines = resp.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('QUEUE 43');
    expect(lines[0]).toContain('2 BFS');
    expect(lines[1]).toContain('QUEUE 77');
    expect(lines[1]).toContain('1 BFS');
  });

  it('QCA*30 filters queues with > 30 BFs', async () => {
    host.backend.queues.set('10', new Array(5).fill('AAA111'));   // 5 BFs — excluded
    host.backend.queues.set('20', new Array(30).fill('BBB222'));  // exactly 30 — excluded
    host.backend.queues.set('30', new Array(35).fill('CCC333'));  // 35 BFs — included
    host.backend.queues.set('40', new Array(100).fill('DDD444')); // 100 BFs — included

    const resp = await host.process('QCA*30', wa);
    const lines = resp.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('QUEUE 30');
    expect(lines[1]).toContain('QUEUE 40');
  });
});

describe('Galileo QW — list queues containing on-screen BF', () => {
  let host: GdsHost;
  let wa: ReturnType<GdsHost['newWorkArea']>;

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

  it('QW with no BF on screen returns NO PNR', async () => {
    const resp = await host.process('QW', wa);
    expect(resp).toMatch(/NO/); // NO PNR / NO BOOKING FILE
  });

  it('QW lists all queues containing the on-screen locator', async () => {
    // Seed a PNR onto screen + queue memberships.
    const pnr = new Pnr();
    pnr.locator = 'XYZ987';
    wa.pnr = pnr;

    host.backend.queues.set('10', ['OTHER', 'XYZ987']);
    host.backend.queues.set('20', ['XYZ987']);
    host.backend.queues.set('30', ['OTHER']);

    const resp = await host.process('QW', wa);
    expect(resp).toContain('XYZ987');
    expect(resp).toContain('10');
    expect(resp).toContain('20');
    expect(resp).not.toContain(' 30'); // queue 30 doesn't hold this BF
  });

  it('QW with BF on no queues returns NO QUEUES', async () => {
    const pnr = new Pnr();
    pnr.locator = 'XYZ987';
    wa.pnr = pnr;

    host.backend.queues.set('10', ['OTHER']);

    const resp = await host.process('QW', wa);
    expect(resp).toBe('NO QUEUES');
  });
});

describe('Galileo QPB* — display queue titles (stub)', () => {
  it('returns NO TITLES SET (we do not model titles)', async () => {
    const host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    const wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
    const resp = await host.process('QPB*', wa);
    expect(resp).toBe('NO TITLES SET');
  });
});
