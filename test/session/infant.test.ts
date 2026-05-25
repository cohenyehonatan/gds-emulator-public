import { describe, it, expect, beforeEach } from 'vitest';
import { parseNameText } from '../../src/models/name-element.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('infant name field (-I/)', () => {
  it('parses single and multiple infant names', () => {
    const one = parseNameText('I/ADAMS/MARY');
    expect(one.infant).toBe(true);
    expect(one.surname).toBe('ADAMS');
    expect(one.count).toBe(1);

    const many = parseNameText('I/3OBI/MARY/JUNE/BRANDON');
    expect(many.infant).toBe(true);
    expect(many.count).toBe(3);
    expect(many.passengers).toHaveLength(3);
  });

  it('does not treat an I-surname as an infant', () => {
    expect(parseNameText('IRVINE/JOHN').infant).toBeFalsy();
  });

  let host: GdsHost;
  let wa: WorkArea;
  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*4321', wa);
  });

  it('displays an infant name with the I/ marker', () => {
    host.process('-SMITH/JOHN MR', wa);
    host.process('-I/ADAMS/MARY', wa);
    expect(host.process('*N', wa)).toContain('2.I/1ADAMS/MARY');
  });

  it('excludes infants from the seat count at end transaction', () => {
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa); // 1 seat
    host.process('-SMITH/JOHN MR', wa); // 1 adult
    host.process('-I/SMITH/BABY', wa); // infant, no seat
    host.process('3INFT/SMITH/BABY/09JAN24-1.1', wa); // infant SSR (foundation already parses it)
    host.process('9305-555-1212-H', wa);
    host.process('7TAW15JUN/', wa);
    host.process('6P', wa);
    expect(wa.pnr.passengerCount()).toBe(1); // infant not counted
    expect(host.process('E', wa)).toMatch(/^[A-Z]{6}$/); // commits (1 adult == 1 seat)
  });

  it('the infant SSR is captured', () => {
    host.process('-SMITH/JOHN MR', wa);
    host.process('-I/SMITH/BABY', wa);
    host.process('3INFT/SMITH/BABY/09JAN24-1.1', wa);
    expect(wa.pnr.ssrs[0]).toMatchObject({ code: 'INFT', text: 'SMITH/BABY/09JAN24' });
  });
});
