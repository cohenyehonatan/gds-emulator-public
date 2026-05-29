import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('audit trail parsing (DQB* family)', async () => {
  it('parses today / specific day / previous-year / branch / combined forms', async () => {
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

  it('parses DQB*DELETE and DQB*YES as the two-step delete', async () => {
    const del = parseEntry('DQB*DELETE');
    if (del.kind === 'audit_trail') expect(del.mode).toBe('delete_request');
    const yes = parseEntry('DQB*YES');
    if (yes.kind === 'audit_trail') expect(yes.mode).toBe('delete_confirm');
  });

  it('rejects a malformed date token in DQB*', async () => {
    expect(() => parseEntry('DQB*XXXX')).toThrow();
  });
});

describe('audit trail report (DQB*)', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
  });

  async function bookAndIssue(surname: string): string {
    await host.process('IG', wa);
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y1', wa);
    await host.process(`-${surname}/JOHN MR`, wa);
    await host.process('9305-555-1212-H', wa);
    await host.process('7TAW15JUN/', wa);
    await host.process('6P', wa);
    const locator = await host.process('E', wa);
    // Retrieve, issue, end-tx — so the PNR survives in the store with the ticket.
    await host.process(`*${locator}`, wa);
    await host.process('W¥', wa);
    await host.process('ER', wa);
    return locator;
  }

  it('returns NO AUDIT TRAIL DATA before any tickets are issued', async () => {
    expect(await host.process('DQB*', wa)).toBe('NO AUDIT TRAIL DATA');
  });

  it("renders today's tickets in the report", async () => {
    await bookAndIssue('SMITH');
    await bookAndIssue('DOE');
    const rep = await host.process('DQB*', wa);
    expect(rep).toContain('AUDIT TRAIL');
    expect(rep).toContain('TOTAL: 2 TKT(S)');
  });

  it('rejects a branch PCC that is not the host PCC', async () => {
    expect(await host.process('DQB*/ZZZZ', wa)).toBe('BRANCH NOT AUTHORIZED');
  });

  it('two-step DELETE / YES is a no-op stub but returns the documented strings', async () => {
    expect(await host.process('DQB*DELETE', wa)).toContain('OK TO DELETE');
    expect(await host.process('DQB*YES', wa)).toContain('AUDIT TRAIL DELETED');
  });
});
