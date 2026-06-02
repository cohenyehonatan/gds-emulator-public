import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';

describe('Galileo SI. — OSI vs SSR discrimination', () => {
  it('SI.YY*1 CHD AGED 5 — 2-char carrier → OSI (Smartpoint Cloud verbatim)', () => {
    const r = parseGalileoEntry('SI.YY*1 CHD AGED 5');
    expect(r.kind).toBe('osi');
    if (r.kind === 'osi') {
      expect(r.carrier).toBe('YY');
      expect(r.text).toBe('1 CHD AGED 5');
    }
  });

  it('SI.KL*VIP STONE/- RMR FILM STAR — 2-char carrier → OSI', () => {
    const r = parseGalileoEntry('SI.KL*VIP STONE/- RMR FILM STAR');
    expect(r.kind).toBe('osi');
    if (r.kind === 'osi') {
      expect(r.carrier).toBe('KL');
      expect(r.text).toBe('VIP STONE/- RMR FILM STAR');
    }
  });

  it('SI.VGML — 4-char code → SSR', () => {
    const r = parseGalileoEntry('SI.VGML');
    expect(r.kind).toBe('ssr');
    if (r.kind === 'ssr') {
      expect(r.code).toBe('VGML');
    }
  });

  it('SI.SPML*NO EGGS — 4-char SSR code with free text → SSR (not OSI)', () => {
    const r = parseGalileoEntry('SI.SPML*NO EGGS');
    expect(r.kind).toBe('ssr');
  });

  it('SI.P1/VGML — scoped → SSR (OSIs do not carry P/S scope)', () => {
    const r = parseGalileoEntry('SI.P1/VGML');
    expect(r.kind).toBe('ssr');
  });

  it('SI.<carrier> without free text is rejected (OSI requires text)', () => {
    expect(() => parseGalileoEntry('SI.YY')).toThrow();
    expect(() => parseGalileoEntry('SI.KL*')).toThrow();
  });
});

describe('Galileo OSI dispatch', () => {
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

  it('SI.YY*<text> pushes onto pnr.osis (not pnr.ssrs)', async () => {
    const resp = await host.process('SI.YY*1 CHD AGED 5', wa);
    expect(wa.pnr.osis).toHaveLength(1);
    expect(wa.pnr.ssrs).toHaveLength(0);
    expect(wa.pnr.osis[0]).toEqual({ carrier: 'YY', text: '1 CHD AGED 5' });
    expect(resp).toContain('OSI');
    expect(resp).toContain('YY');
  });

  it('OSI and SSR can coexist on the same PNR (separate buckets)', async () => {
    // Build minimal PNR with a name so SI.P1/WCHR can attach.
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);

    await host.process('SI.VGML', wa);
    await host.process('SI.YY*GENERAL INFO', wa);
    await host.process('SI.P1/WCHR', wa);
    expect(wa.pnr.ssrs).toHaveLength(2);
    expect(wa.pnr.osis).toHaveLength(1);
  });

  it('OSI flips queue dirty flag in queue context', async () => {
    wa.currentQueue = '43';
    await host.process('SI.UA*RUSH TICKETING', wa);
    expect(wa.queueCurrentDirty).toBe(true);
  });
});
