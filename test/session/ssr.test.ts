import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('SSR / OSI parsing', async () => {
  it('parses an SSR with a passenger name reference', async () => {
    const e = parseEntry('3VGML-1.1');
    expect(e.kind).toBe('ssr');
    if (e.kind === 'ssr') {
      expect(e.code).toBe('VGML');
      expect(e.carrier).toBe('YY');
      expect(e.nameRef).toEqual({ item: 1, passenger: 1 });
    }
  });

  it('parses a bare SSR and an AA-specific one', async () => {
    expect((parseEntry('3WCHR') as any).code).toBe('WCHR');
    const aa = parseEntry('4VGML-2');
    if (aa.kind === 'ssr') {
      expect(aa.carrier).toBe('AA');
      expect(aa.nameRef).toEqual({ item: 2, passenger: undefined });
    }
  });

  it('parses OSI with and without a carrier', async () => {
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

describe('SSR / OSI in the work area', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
    await host.process('-SMITH/JOHN MR', wa);
  });

  it('adds an SSR with a name reference and shows it in the PNR', async () => {
    await host.process('3VGML-1.1', wa);
    expect(wa.pnr.ssrs).toHaveLength(1);
    expect(wa.pnr.ssrs[0]).toMatchObject({ code: 'VGML', carrier: 'YY', status: 'NN' });
    expect(await host.process('*A', wa)).toContain('SSR VGML YY NN -1.1');
  });

  it('adds an OSI and shows it in the PNR', async () => {
    await host.process('3OSI DL HAS BROKEN LEG', wa);
    expect(wa.pnr.osis[0]).toEqual({ carrier: 'DL', text: 'HAS BROKEN LEG' });
    expect(await host.process('*A', wa)).toContain('OSI DL HAS BROKEN LEG');
  });

  it('rejects an SSR referencing a passenger that does not exist', async () => {
    expect(await host.process('3VGML-2.1', wa)).toBe('FORMAT'); // only one name in PNR
    expect(wa.pnr.ssrs).toHaveLength(0);
  });

  it('keeps SSR/OSI through commit and retrieval', async () => {
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y1', wa);
    await host.process('3WCHR-1.1', wa);
    await host.process('3OSI YY VIP PAX', wa);
    await host.process('9305-555-1212-H', wa);
    await host.process('7TAW15JUN/', wa);
    await host.process('6P', wa);
    const locator = await host.process('E', wa);
    const display = await host.process(`*${locator}`, wa);
    expect(display).toContain('SSR WCHR YY NN -1.1');
    expect(display).toContain('OSI YY VIP PAX');
  });
});
