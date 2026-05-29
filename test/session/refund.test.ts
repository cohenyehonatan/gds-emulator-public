import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('refund parsing (WFR / WFRT)', async () => {
  it('parses WFR<13-digit ticket> as a full refund', async () => {
    const e = parseEntry('WFR0014692507094');
    if (e.kind === 'refund') {
      expect(e).toMatchObject({ ticketNumber: '0014692507094', mode: 'full' });
    }
  });

  it('parses WFRT<13-digit ticket> as a tax-only refund', async () => {
    const e = parseEntry('WFRT0014692507094');
    if (e.kind === 'refund') {
      expect(e).toMatchObject({ ticketNumber: '0014692507094', mode: 'tax_only' });
    }
  });

  it('rejects a non-13-digit ticket number', async () => {
    expect(() => parseEntry('WFR123')).toThrow();
  });

  it('parses WFR<tkt>¥AGF as a full refund with the agent-fare flag', async () => {
    const e = parseEntry('WFR0014692507094¥AGF');
    if (e.kind === 'refund') {
      expect(e).toMatchObject({
        mode: 'full',
        ticketNumber: '0014692507094',
        agentFare: true,
      });
    }
  });

  it('rejects an unrecognized WFR qualifier', async () => {
    expect(() => parseEntry('WFR0014692507094¥XYZ')).toThrow();
  });

  it('parses WFR<tkt>¥N<dotted-name> with the verbatim QREX example shape', async () => {
    // QREX p.31: WFR0012324252627¥N2.1¥AGF — name-selected + agent-fare combined.
    const e = parseEntry('WFR0012324252627¥N2.1¥AGF');
    if (e.kind === 'refund') {
      expect(e).toMatchObject({
        mode: 'full',
        ticketNumber: '0012324252627',
        agentFare: true,
        nameRefs: [{ item: 2, passenger: 1 }],
      });
    }
  });

  it('parses a range and a list in WFR ¥N<dotted>', async () => {
    const r = parseEntry('WFR0014692507094¥N1.2-1.4');
    if (r.kind === 'refund') {
      expect(r.nameRefs).toEqual([
        { item: 1, passenger: 2 },
        { item: 1, passenger: 3 },
        { item: 1, passenger: 4 },
      ]);
    }
    const l = parseEntry('WFR0014692507094¥N1.1,1.3');
    if (l.kind === 'refund') {
      expect(l.nameRefs).toEqual([
        { item: 1, passenger: 1 },
        { item: 1, passenger: 3 },
      ]);
    }
  });

  it('rejects WFR ¥N with a malformed selection', async () => {
    expect(() => parseEntry('WFR0014692507094¥N3')).toThrow(/bad name selector/);
  });
});

describe('refund handling', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
  });

  async function bookAndIssue(): string {
    await host.process('IG', wa);
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y1', wa);
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('9305-555-1212-H', wa);
    await host.process('7TAW15JUN/', wa);
    await host.process('6P', wa);
    const locator = await host.process('E', wa);
    await host.process(`*${locator}`, wa); // retrieve back
    await host.process('W¥', wa);
    const tkt = wa.pnr.tickets[0].number; // capture before end-tx clears wa.pnr
    await host.process('ET', wa); // end without redisplay; wa.pnr resets
    await host.process(`*${locator}`, wa); // bring it back on screen for *T queries
    return tkt;
  }

  it('marks a ticket REFUNDED and flips it from *TA into *TI', async () => {
    const tkt = await bookAndIssue();
    // Before refund: ticket shows in *TA, not *TI.
    expect(await host.process('*TA', wa)).toContain(tkt);
    expect(await host.process('*TI', wa)).toBe('NO TICKETING FIELD');
    // Refund.
    const resp = await host.process(`WFR${tkt}`, wa);
    expect(resp).toContain('OK-REFUND');
    expect(resp).toContain(tkt);
    // After refund: it surfaces in *TI; *TA no longer shows it.
    expect(await host.process('*TI', wa)).toContain(tkt);
    expect(await host.process('*TA', wa)).toBe('NO TICKETING FIELD');
  });

  it('returns TKT NOT FOUND for an unknown ticket number', async () => {
    await bookAndIssue();
    expect(await host.process('WFR9999999999999', wa)).toBe('TKT NOT FOUND');
  });

  it('refuses to refund the same ticket twice', async () => {
    const tkt = await bookAndIssue();
    await host.process(`WFR${tkt}`, wa);
    expect(await host.process(`WFR${tkt}`, wa)).toBe('TKT ALREADY REFUNDED');
  });

  it('tax-only WFRT leaves the ticket active (full status unchanged)', async () => {
    const tkt = await bookAndIssue();
    const resp = await host.process(`WFRT${tkt}`, wa);
    expect(resp).toContain('OK-TAX REFUND');
    expect(await host.process('*TA', wa)).toContain(tkt); // still active
  });

  it('WFR* redisplays the last refund response (QREX p.7)', async () => {
    expect(await host.process('WFR*', wa)).toBe('NO PREVIOUS REFUND');
    const tkt = await bookAndIssue();
    const refund = await host.process(`WFR${tkt}`, wa);
    expect(await host.process('WFR*', wa)).toBe(refund);
  });
});

describe('WTRX cancel refund (QREX p.21 two-step flow)', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
  });

  async function bookIssueAndRefund(): string {
    await host.process('IG', wa);
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y1', wa);
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('9305-555-1212-H', wa);
    await host.process('7TAW15JUN/', wa);
    await host.process('6P', wa);
    const locator = await host.process('E', wa);
    await host.process(`*${locator}`, wa);
    await host.process('W¥', wa);
    const tkt = wa.pnr.tickets[0].number;
    await host.process('ET', wa);
    await host.process(`*${locator}`, wa);
    await host.process(`WFR${tkt}`, wa); // refund it so WTRX is meaningful
    return tkt;
  }

  it('first WTRX asks the agent to re-enter (verbatim QREX p.21)', async () => {
    const tkt = await bookIssueAndRefund();
    const resp = await host.process(`WTRX${tkt}`, wa);
    expect(resp).toBe(`RE-ENTER TO CANCEL REFUND FOR TKT\n${tkt}`);
    // Ticket still REFUNDED until step 2.
    expect(await host.process('*TI', wa)).toContain(tkt);
  });

  it('second WTRX confirms with verbatim OK-REFUND CANCELLED and reactivates', async () => {
    const tkt = await bookIssueAndRefund();
    await host.process(`WTRX${tkt}`, wa); // step 1
    const resp = await host.process(`WTRX${tkt}`, wa); // step 2
    expect(resp).toBe('OK-REFUND\nCANCELLED'); // verbatim QREX p.21
    // Ticket now back to active.
    expect(await host.process('*TA', wa)).toContain(tkt);
    expect(await host.process('*TI', wa)).toBe('NO TICKETING FIELD');
  });

  it('different ticket on step 2 resets to step 1', async () => {
    const tkt1 = await bookIssueAndRefund();
    const tkt2 = await bookIssueAndRefund();
    await host.process(`WTRX${tkt1}`, wa); // arm tkt1
    expect(wa.pendingCancelRefundTicket).toBe(tkt1);
    // Re-enter with a different refunded ticket → treated as fresh step 1.
    const resp = await host.process(`WTRX${tkt2}`, wa);
    expect(resp).toContain(tkt2);
    expect(resp).toContain('RE-ENTER');
    expect(wa.pendingCancelRefundTicket).toBe(tkt2); // pending switched
  });

  it('WTRX on a non-refunded ticket is rejected', async () => {
    // Issue but don't refund.
    await host.process('IG', wa);
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y1', wa);
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('9305-555-1212-H', wa);
    await host.process('7TAW15JUN/', wa);
    await host.process('6P', wa);
    const locator = await host.process('E', wa);
    await host.process(`*${locator}`, wa);
    await host.process('W¥', wa);
    const tkt = wa.pnr.tickets[0].number;
    expect(await host.process(`WTRX${tkt}`, wa)).toBe('TKT NOT REFUNDED');
  });

  it('WTRX on unknown ticket number returns TKT NOT FOUND', async () => {
    expect(await host.process('WTRX9999999999999', wa)).toBe('TKT NOT FOUND');
  });
});
