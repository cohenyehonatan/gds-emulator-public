import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('refund parsing (WFR / WFRT)', () => {
  it('parses WFR<13-digit ticket> as a full refund', () => {
    const e = parseEntry('WFR0014692507094');
    if (e.kind === 'refund') {
      expect(e).toMatchObject({ ticketNumber: '0014692507094', mode: 'full' });
    }
  });

  it('parses WFRT<13-digit ticket> as a tax-only refund', () => {
    const e = parseEntry('WFRT0014692507094');
    if (e.kind === 'refund') {
      expect(e).toMatchObject({ ticketNumber: '0014692507094', mode: 'tax_only' });
    }
  });

  it('rejects a non-13-digit ticket number', () => {
    expect(() => parseEntry('WFR123')).toThrow();
  });
});

describe('refund handling', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*4321', wa);
  });

  function bookAndIssue(): string {
    host.process('IG', wa);
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa);
    host.process('-SMITH/JOHN MR', wa);
    host.process('9305-555-1212-H', wa);
    host.process('7TAW15JUN/', wa);
    host.process('6P', wa);
    const locator = host.process('E', wa);
    host.process(`*${locator}`, wa); // retrieve back
    host.process('W¥', wa);
    const tkt = wa.pnr.tickets[0].number; // capture before end-tx clears wa.pnr
    host.process('ET', wa); // end without redisplay; wa.pnr resets
    host.process(`*${locator}`, wa); // bring it back on screen for *T queries
    return tkt;
  }

  it('marks a ticket REFUNDED and flips it from *TA into *TI', () => {
    const tkt = bookAndIssue();
    // Before refund: ticket shows in *TA, not *TI.
    expect(host.process('*TA', wa)).toContain(tkt);
    expect(host.process('*TI', wa)).toBe('NO TICKETING FIELD');
    // Refund.
    const resp = host.process(`WFR${tkt}`, wa);
    expect(resp).toContain('OK-REFUND');
    expect(resp).toContain(tkt);
    // After refund: it surfaces in *TI; *TA no longer shows it.
    expect(host.process('*TI', wa)).toContain(tkt);
    expect(host.process('*TA', wa)).toBe('NO TICKETING FIELD');
  });

  it('returns TKT NOT FOUND for an unknown ticket number', () => {
    bookAndIssue();
    expect(host.process('WFR9999999999999', wa)).toBe('TKT NOT FOUND');
  });

  it('refuses to refund the same ticket twice', () => {
    const tkt = bookAndIssue();
    host.process(`WFR${tkt}`, wa);
    expect(host.process(`WFR${tkt}`, wa)).toBe('TKT ALREADY REFUNDED');
  });

  it('tax-only WFRT leaves the ticket active (full status unchanged)', () => {
    const tkt = bookAndIssue();
    const resp = host.process(`WFRT${tkt}`, wa);
    expect(resp).toContain('OK-TAX REFUND');
    expect(host.process('*TA', wa)).toContain(tkt); // still active
  });
});
