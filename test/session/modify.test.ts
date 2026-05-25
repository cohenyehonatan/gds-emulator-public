import { describe, it, expect, beforeEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

/** Field change / delete via the '¤' change key (workbook p.36-37). */
describe('field modify (¤ change/delete)', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*4321', wa);
  });

  it('changes a name in place', () => {
    host.process('-SMITH/JOHN MR', wa);
    host.process('-1¤JENSEN/KURT MR', wa);
    expect(wa.pnr.names[0].surname).toBe('JENSEN');
    expect(wa.pnr.names[0].passengers[0]).toEqual({ firstName: 'KURT', title: 'MR' });
  });

  it('changes a name to a multi-passenger item', () => {
    host.process('-SMITH/JOHN MR', wa);
    host.process('-1¤2MURRAY/FRED MR/HANA MRS', wa);
    expect(wa.pnr.names[0].count).toBe(2);
    expect(wa.pnr.passengerCount()).toBe(2);
  });

  it('deletes the only name with -¤', () => {
    host.process('-SMITH/JOHN MR', wa);
    expect(host.process('-¤', wa)).toBe('NO NAMES');
    expect(wa.pnr.names).toHaveLength(0);
  });

  it('deletes a specific name when several exist', () => {
    host.process('-SMITH/JOHN MR', wa);
    host.process('-JONES/MARY MS', wa);
    host.process('-2¤', wa);
    expect(wa.pnr.names).toHaveLength(1);
    expect(wa.pnr.names[0].surname).toBe('SMITH');
  });

  it('refuses a bare -¤ when more than one name exists', () => {
    host.process('-SMITH/JOHN MR', wa);
    host.process('-JONES/MARY MS', wa);
    expect(host.process('-¤', wa)).toBe('FORMAT');
    expect(wa.pnr.names).toHaveLength(2);
  });

  it('changes a phone, including via the [ alias for ¤', () => {
    host.process('9305-555-1212-H', wa);
    host.process('91[214-555-2121-H', wa); // '[' → '¤'
    expect(wa.pnr.phones[0].number).toBe('214-555-2121');
  });

  it('deletes phones by range', () => {
    host.process('9305-555-1111-H', wa);
    host.process('9305-555-2222-B', wa);
    host.process('9305-555-3333-M', wa);
    host.process('91-2¤', wa); // delete phones 1 and 2
    expect(wa.pnr.phones).toHaveLength(1);
    expect(wa.pnr.phones[0].number).toBe('305-555-3333');
  });

  it('changes ticketing and received-from', () => {
    host.process('7TAW15JUN/', wa);
    host.process('7¤TAW17FEB/', wa);
    expect(wa.pnr.ticketing).toBe('TAW17FEB/');
    host.process('6P', wa);
    host.process('6¤JENS HANSON', wa);
    expect(wa.pnr.receivedFrom).toBe('JENS HANSON');
  });

  it('changes a name and a phone in one chained entry', () => {
    host.process('-SMITH/JOHN MR', wa);
    host.process('9305-555-1212-H', wa);
    host.process('-1¤BROWN/SUE MS§91¤305-555-9999-B', wa);
    expect(wa.pnr.names[0].surname).toBe('BROWN');
    expect(wa.pnr.phones[0].number).toBe('305-555-9999');
  });

  it('changes one passenger within a multi-pax name item (-1.2¤)', () => {
    host.process('-2MURRAY/FRED MR/HANA MRS', wa);
    host.process('-1.2¤JANE MISS', wa);
    const item = wa.pnr.names[0];
    expect(item.surname).toBe('MURRAY'); // surname unchanged
    expect(item.count).toBe(2);
    expect(item.passengers[1]).toEqual({ firstName: 'JANE', title: 'MISS' });
  });

  it('deletes one passenger within an item and decrements the count', () => {
    host.process('-2MURRAY/FRED MR/HANA MRS', wa);
    host.process('-1.2¤', wa);
    expect(wa.pnr.names[0].count).toBe(1);
    expect(wa.pnr.names[0].passengers).toEqual([{ firstName: 'FRED', title: 'MR' }]);
  });

  it('removes the item when its last passenger is deleted', () => {
    host.process('-SMITH/JOHN MR', wa);
    expect(host.process('-1.1¤', wa)).toBe('NO NAMES');
    expect(wa.pnr.names).toHaveLength(0);
  });

  it('rejects an out-of-range passenger reference', () => {
    host.process('-SMITH/JOHN MR', wa);
    expect(host.process('-1.5¤', wa)).toBe('FORMAT');
  });

  it('adds, changes, and deletes a name reference number', () => {
    host.process('-SMITH/LAUREN*5467', wa);
    expect(wa.pnr.names[0].reference).toBe('5467');
    expect(host.process('*N', wa)).toContain('1.1SMITH/LAUREN*5467');

    host.process('-1¤*AN9999', wa); // change reference data
    expect(wa.pnr.names[0].reference).toBe('AN9999');

    host.process('-1¤*', wa); // delete reference data
    expect(wa.pnr.names[0].reference).toBeUndefined();
  });

  it('sets a passenger-level name reference (-1.2¤*)', () => {
    host.process('-2MURRAY/FRED MR/HANA MRS', wa);
    host.process('-1.2¤*ABC', wa);
    expect(wa.pnr.names[0].passengers[1].reference).toBe('ABC');
  });

  it('rejects a modify when the work area is empty', () => {
    expect(host.process('91¤214-555-2121-H', wa)).toBe('NO PNR IN AAA');
  });
});
