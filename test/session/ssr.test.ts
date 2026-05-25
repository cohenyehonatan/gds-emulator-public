import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('SSR / OSI parsing', () => {
  it('parses an SSR with a passenger name reference', () => {
    const e = parseEntry('3VGML-1.1');
    expect(e.kind).toBe('ssr');
    if (e.kind === 'ssr') {
      expect(e.code).toBe('VGML');
      expect(e.carrier).toBe('YY');
      expect(e.nameRef).toEqual({ item: 1, passenger: 1 });
    }
  });

  it('parses a bare SSR and an AA-specific one', () => {
    expect((parseEntry('3WCHR') as any).code).toBe('WCHR');
    const aa = parseEntry('4VGML-2');
    if (aa.kind === 'ssr') {
      expect(aa.carrier).toBe('AA');
      expect(aa.nameRef).toEqual({ item: 2, passenger: undefined });
    }
  });

  it('parses OSI with and without a carrier', () => {
    const dl = parseEntry('3OSI DL HAS BROKEN LEG');
    if (dl.kind === 'osi') {
      expect(dl.carrier).toBe('DL');
      expect(dl.text).toBe('HAS BROKEN LEG');
    }
    const aa = parseEntry('4OSI NEEDS ASSISTANCE');
    if (aa.kind === 'osi') {
      expect(aa.carrier).toBe('AA');
      expect(aa.text).toBe('NEEDS ASSISTANCE');
    }
  });
});

describe('SSR / OSI in the work area', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*4321', wa);
    host.process('-SMITH/JOHN MR', wa);
  });

  it('adds an SSR with a name reference and shows it in the PNR', () => {
    host.process('3VGML-1.1', wa);
    expect(wa.pnr.ssrs).toHaveLength(1);
    expect(wa.pnr.ssrs[0]).toMatchObject({ code: 'VGML', carrier: 'YY', status: 'NN' });
    expect(host.process('*A', wa)).toContain('SSR VGML YY NN -1.1');
  });

  it('adds an OSI and shows it in the PNR', () => {
    host.process('3OSI DL HAS BROKEN LEG', wa);
    expect(wa.pnr.osis[0]).toEqual({ carrier: 'DL', text: 'HAS BROKEN LEG' });
    expect(host.process('*A', wa)).toContain('OSI DL HAS BROKEN LEG');
  });

  it('rejects an SSR referencing a passenger that does not exist', () => {
    expect(host.process('3VGML-2.1', wa)).toBe('FORMAT'); // only one name in PNR
    expect(wa.pnr.ssrs).toHaveLength(0);
  });

  it('keeps SSR/OSI through commit and retrieval', () => {
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa);
    host.process('3WCHR-1.1', wa);
    host.process('3OSI YY VIP PAX', wa);
    host.process('9305-555-1212-H', wa);
    host.process('7TAW15JUN/', wa);
    host.process('6P', wa);
    const locator = host.process('E', wa);
    const display = host.process(`*${locator}`, wa);
    expect(display).toContain('SSR WCHR YY NN -1.1');
    expect(display).toContain('OSI YY VIP PAX');
  });
});
