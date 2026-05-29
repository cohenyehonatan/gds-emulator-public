import { describe, it, expect } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';

describe('WV void entry parsing', () => {
  it('parses WV<n> as by_item', () => {
    const r = parseEntry('WV2');
    expect(r.kind).toBe('void');
    if (r.kind === 'void') {
      expect(r).toMatchObject({ mode: 'by_item', itemNumber: 2 });
    }
  });

  it('parses the manual form (¥ form, 6 slash-fields)', () => {
    const r = parseEntry('WV¥0577136789012/USD500.00/JMKQLM/03JUN/CA/1');
    if (r.kind === 'void') {
      expect(r).toMatchObject({
        mode: 'manual',
        ticketNumber: '0577136789012',
        amount: 'USD500.00',
        fop: 'JMKQLM',
        date: '03JUN',
        carrier: 'CA',
        count: 1,
      });
    }
  });

  it('accepts ‡ as a synonym for the cross of Lorraine in manual form', () => {
    const r = parseEntry('WV‡0577136789012/USD500.00/JMKQLM/03JUN/CA/1');
    if (r.kind === 'void') {
      expect(r.mode).toBe('manual');
      expect(r.ticketNumber).toBe('0577136789012');
    }
  });

  it('parses WV* as list_month', () => {
    const r = parseEntry('WV*');
    if (r.kind === 'void') expect(r.mode).toBe('list_month');
  });

  it('parses WV*DT<date> as list_day', () => {
    const r = parseEntry('WV*DT15SEP');
    if (r.kind === 'void') {
      expect(r).toMatchObject({ mode: 'list_day', fromDate: '15SEP' });
    }
  });

  it('parses WV*DT<from>-<to> as list_range', () => {
    const r = parseEntry('WV*DT15SEP-30SEP');
    if (r.kind === 'void') {
      expect(r).toMatchObject({
        mode: 'list_range',
        fromDate: '15SEP',
        toDate: '30SEP',
      });
    }
  });

  it('rejects malformed by_item / list / manual selectors', () => {
    expect(() => parseEntry('WVABC')).toThrow();
    expect(() => parseEntry('WV*XYZ')).toThrow(); // missing DT
    expect(() => parseEntry('WV*DT')).toThrow(); // empty date
    expect(() => parseEntry('WV¥0577136789012/USD500.00/JMKQLM/03JUN/CA')).toThrow(); // 5 fields
    expect(() => parseEntry('WV¥0577136789012/USD500.00/JMKQLM/03JUN/CA/0')).toThrow(); // count 0
    expect(() => parseEntry('WV¥123/USD500.00/JMKQLM/03JUN/CA/1')).toThrow(); // bad ticket
  });
});
