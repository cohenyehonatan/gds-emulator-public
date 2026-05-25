import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('remarks parsing', () => {
  it('classifies general, form-of-payment, and historical remarks', () => {
    expect((parseEntry('5DIFFICULT PAX') as any).remarkType).toBe('general');
    const fop = parseEntry('5-CASH');
    if (fop.kind === 'remark') expect(fop).toMatchObject({ remarkType: 'fop', text: 'CASH' });
    const h = parseEntry('5H-ADVISED OF PENALTY');
    if (h.kind === 'remark') expect(h).toMatchObject({ remarkType: 'historical', text: 'ADVISED OF PENALTY' });
  });
});

describe('remarks in the work area', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*4321', wa);
  });

  it('adds remarks and shows them via *P5', () => {
    host.process('5PLEASE CALL HOME FIRST', wa);
    host.process('5-CASH', wa);
    host.process('5H-PASSPORT NOTED', wa);
    expect(wa.pnr.remarks).toHaveLength(3);
    const p5 = host.process('*P5', wa);
    expect(p5).toContain('REMARKS');
    expect(p5).toContain('1.PLEASE CALL HOME FIRST');
    expect(p5).toContain('2.-CASH');
    expect(p5).toContain('3.H-PASSPORT NOTED');
  });

  it('changes and deletes remarks by line via ¤', () => {
    host.process('5ONE', wa);
    host.process('5TWO', wa);
    host.process('5THREE', wa);
    host.process('51¤FIRST CHANGED', wa); // change line 1
    expect(wa.pnr.remarks[0].text).toBe('FIRST CHANGED');
    host.process('52-3¤', wa); // delete lines 2-3
    expect(wa.pnr.remarks).toHaveLength(1);
    expect(wa.pnr.remarks[0].text).toBe('FIRST CHANGED');
  });

  it('keeps remarks through commit and retrieval', () => {
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa);
    host.process('5VIP - HANDLE WITH CARE', wa);
    host.process('-SMITH/JOHN MR', wa);
    host.process('9305-555-1212-H', wa);
    host.process('7TAW15JUN/', wa);
    host.process('6P', wa);
    const locator = host.process('E', wa);
    expect(host.process(`*${locator}`, wa)).toContain('VIP - HANDLE WITH CARE');
  });
});
