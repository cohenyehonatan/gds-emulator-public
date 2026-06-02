import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';

describe('Galileo SI. cryptic parsing', () => {
  it('SI.VGML — code only, all pax all segs', () => {
    const r = parseGalileoEntry('SI.VGML');
    expect(r.kind).toBe('ssr');
    if (r.kind === 'ssr') {
      expect(r.code).toBe('VGML');
      expect(r.nameRef).toBeUndefined();
      expect(r.text).toBeUndefined();
      expect(r.carrier).toBe('YY');
    }
  });

  it('SI.P1/VGML — pax-1 scope', () => {
    const r = parseGalileoEntry('SI.P1/VGML');
    expect(r.kind).toBe('ssr');
    if (r.kind === 'ssr') {
      expect(r.code).toBe('VGML');
      expect(r.nameRef).toEqual({ item: 1 });
    }
  });

  it('SI.S3/VGML — segment-3 scope (S<n> parsed but not stored on local model)', () => {
    const r = parseGalileoEntry('SI.S3/VGML');
    expect(r.kind).toBe('ssr');
    if (r.kind === 'ssr') {
      expect(r.code).toBe('VGML');
      expect(r.nameRef).toBeUndefined();
    }
  });

  it('SI.P2S3/VGMLBK — combined pax+segment scope', () => {
    const r = parseGalileoEntry('SI.P2S3/VGMLBK');
    expect(r.kind).toBe('ssr');
    if (r.kind === 'ssr') {
      expect(r.code).toBe('VGMLBK');
      expect(r.nameRef).toEqual({ item: 2 });
    }
  });

  it('SI.SPML*NO EGGS — free text via asterisk', () => {
    const r = parseGalileoEntry('SI.SPML*NO EGGS');
    expect(r.kind).toBe('ssr');
    if (r.kind === 'ssr') {
      expect(r.code).toBe('SPML');
      expect(r.text).toBe('NO EGGS');
    }
  });

  it('SI.P3/CHLD*12JAN19 — Mini Guide v2 verbatim: child DOB', () => {
    const r = parseGalileoEntry('SI.P3/CHLD*12JAN19');
    expect(r.kind).toBe('ssr');
    if (r.kind === 'ssr') {
      expect(r.code).toBe('CHLD');
      expect(r.nameRef).toEqual({ item: 3 });
      expect(r.text).toBe('12JAN19');
    }
  });

  it('rejects SI with no code', () => {
    expect(() => parseGalileoEntry('SI.')).toThrow();
    expect(() => parseGalileoEntry('SI.P1/')).toThrow();
  });

  it('rejects SI with malformed scope', () => {
    // 'PX' is neither P<n> nor S<n> — should reject.
    expect(() => parseGalileoEntry('SI.PX/VGML')).toThrow();
  });
});

describe('Galileo SI. dispatch — local-only', () => {
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

  it('SI.VGML pushes onto wa.pnr.ssrs and renders an echo', async () => {
    const resp = await host.process('SI.VGML', wa);
    expect(wa.pnr.ssrs).toHaveLength(1);
    expect(wa.pnr.ssrs[0].code).toBe('VGML');
    expect(wa.pnr.ssrs[0].status).toBe('NN');
    expect(resp).toContain('SI.VGML');
  });

  it('multiple SI. entries accumulate; render shows them in order', async () => {
    await host.process('SI.VGML', wa);
    await host.process('SI.WCHR', wa);
    expect(wa.pnr.ssrs).toHaveLength(2);
    const resp = await host.process('SI.SPML*NO EGGS', wa);
    expect(wa.pnr.ssrs).toHaveLength(3);
    expect(resp).toContain('VGML');
    expect(resp).toContain('WCHR');
    expect(resp).toContain('SPML');
    expect(resp).toContain('NO EGGS');
  });

  it('SI.P1/VGML with no name in PNR returns FORMAT', async () => {
    expect(wa.pnr.names).toHaveLength(0);
    const resp = await host.process('SI.P1/VGML', wa);
    expect(resp).toBe('FORMAT');
    expect(wa.pnr.ssrs).toHaveLength(0);
  });

  it('SI.P1/VGML attaches passenger reference when name exists', async () => {
    // Build minimal PNR with one name first.
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    expect(wa.pnr.names).toHaveLength(1);

    await host.process('SI.P1/VGML', wa);
    expect(wa.pnr.ssrs).toHaveLength(1);
    expect(wa.pnr.ssrs[0].nameRef).toEqual({ item: 1 });
  });

  it('SI. flips the queue dirty flag when in queue context', async () => {
    // Force queue context.
    wa.currentQueue = '43';
    expect(wa.queueCurrentDirty).toBeFalsy();

    await host.process('SI.VGML', wa);
    expect(wa.queueCurrentDirty).toBe(true);
  });
});
