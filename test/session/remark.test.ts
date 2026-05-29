import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('remarks parsing', async () => {
  it('classifies general, form-of-payment, and historical remarks', async () => {
    expect((parseEntry('5DIFFICULT PAX') as any).remarkType).toBe('general');
    const fop = parseEntry('5-CASH');
    if (fop.kind === 'remark') expect(fop).toMatchObject({ remarkType: 'fop', text: 'CASH' });
    const h = parseEntry('5H-ADVISED OF PENALTY');
    if (h.kind === 'remark') expect(h).toMatchObject({ remarkType: 'historical', text: 'ADVISED OF PENALTY' });
  });
});

describe('remarks in the work area', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
  });

  it('adds remarks and shows them via *P5', async () => {
    await host.process('5PLEASE CALL HOME FIRST', wa);
    await host.process('5-CASH', wa);
    await host.process('5H-PASSPORT NOTED', wa);
    expect(wa.pnr.remarks).toHaveLength(3);
    const p5 = await host.process('*P5', wa);
    expect(p5).toContain('REMARKS');
    expect(p5).toContain('1.PLEASE CALL HOME FIRST');
    expect(p5).toContain('2.-CASH');
    expect(p5).toContain('3.H-PASSPORT NOTED');
  });

  it('changes and deletes remarks by line via ¤', async () => {
    await host.process('5ONE', wa);
    await host.process('5TWO', wa);
    await host.process('5THREE', wa);
    await host.process('51¤FIRST CHANGED', wa); // change line 1
    expect(wa.pnr.remarks[0].text).toBe('FIRST CHANGED');
    await host.process('52-3¤', wa); // delete lines 2-3
    expect(wa.pnr.remarks).toHaveLength(1);
    expect(wa.pnr.remarks[0].text).toBe('FIRST CHANGED');
  });

  it('keeps remarks through commit and retrieval', async () => {
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y1', wa);
    await host.process('5VIP - HANDLE WITH CARE', wa);
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('9305-555-1212-H', wa);
    await host.process('7TAW15JUN/', wa);
    await host.process('6P', wa);
    const locator = await host.process('E', wa);
    expect(await host.process(`*${locator}`, wa)).toContain('VIP - HANDLE WITH CARE');
  });
});
