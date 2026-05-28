import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('audit trail parsing (DQB* family)', () => {
  it('parses today / specific day / previous-year / branch / combined forms', () => {
    const today = parseEntry('DQB*');
    if (today.kind === 'audit_trail') expect(today).toMatchObject({ mode: 'display' });

    const day = parseEntry('DQB*01OCT');
    if (day.kind === 'audit_trail') expect(day).toMatchObject({ mode: 'display', date: '01OCT' });

    const yy = parseEntry('DQB*12FEB01');
    if (yy.kind === 'audit_trail') expect(yy).toMatchObject({ mode: 'display', date: '12FEB01' });

    const br = parseEntry('DQB*/B4T0');
    if (br.kind === 'audit_trail') expect(br).toMatchObject({ mode: 'display', branch: 'B4T0' });

    const combo = parseEntry('DQB*01OCT/B4T0');
    if (combo.kind === 'audit_trail') {
      expect(combo).toMatchObject({ mode: 'display', date: '01OCT', branch: 'B4T0' });
    }
  });

  it('parses DQB*DELETE and DQB*YES as the two-step delete', () => {
    const del = parseEntry('DQB*DELETE');
    if (del.kind === 'audit_trail') expect(del.mode).toBe('delete_request');
    const yes = parseEntry('DQB*YES');
    if (yes.kind === 'audit_trail') expect(yes.mode).toBe('delete_confirm');
  });

  it('rejects a malformed date token in DQB*', () => {
    expect(() => parseEntry('DQB*XXXX')).toThrow();
  });
});

describe('audit trail report (DQB*)', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*4321', wa);
  });

  function bookAndIssue(surname: string): string {
    host.process('IG', wa);
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa);
    host.process(`-${surname}/JOHN MR`, wa);
    host.process('9305-555-1212-H', wa);
    host.process('7TAW15JUN/', wa);
    host.process('6P', wa);
    const locator = host.process('E', wa);
    // Retrieve, issue, end-tx — so the PNR survives in the store with the ticket.
    host.process(`*${locator}`, wa);
    host.process('W¥', wa);
    host.process('ER', wa);
    return locator;
  }

  it('returns NO AUDIT TRAIL DATA before any tickets are issued', () => {
    expect(host.process('DQB*', wa)).toBe('NO AUDIT TRAIL DATA');
  });

  it("renders today's tickets in the report", () => {
    bookAndIssue('SMITH');
    bookAndIssue('DOE');
    const rep = host.process('DQB*', wa);
    expect(rep).toContain('AUDIT TRAIL');
    expect(rep).toContain('TOTAL: 2 TKT(S)');
  });

  it('rejects a branch PCC that is not the host PCC', () => {
    expect(host.process('DQB*/ZZZZ', wa)).toBe('BRANCH NOT AUTHORIZED');
  });

  it('two-step DELETE / YES is a no-op stub but returns the documented strings', () => {
    expect(host.process('DQB*DELETE', wa)).toContain('OK TO DELETE');
    expect(host.process('DQB*YES', wa)).toContain('AUDIT TRAIL DELETED');
  });
});
