import { describe, it, expect, beforeEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('WV void handling — two-step confirmation', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
  });

  async function issue(): string {
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
    return wa.pnr.tickets[0].number;
  }

  it('WV<n> on first entry prompts to re-enter and does not flip status', async () => {
    const tkt = await issue();
    const resp = await host.process('WV1', wa);
    expect(resp).toContain('RE-ENTER TO VOID');
    expect(resp).toContain(tkt);
    expect(wa.pnr.tickets[0].status ?? 'OPEN').toBe('OPEN');
    expect(wa.pendingVoid).toEqual({ kind: 'by_item', itemNumber: 1 });
  });

  it('WV<n> twice flips status to VOIDED and clears pending', async () => {
    const tkt = await issue();
    await host.process('WV1', wa);
    const resp = await host.process('WV1', wa);
    expect(resp).toBe(`OK-VOID TKT ${tkt}`);
    expect(wa.pnr.tickets[0].status).toBe('VOIDED');
    expect(wa.pnr.tickets[0].voidedAt).toBeInstanceOf(Date);
    expect(wa.pendingVoid).toBeUndefined();
  });

  it('WV‡<manual> after WV<n> step-1 resets the pending state to the new selector', async () => {
    const tkt = await issue();
    await host.process('WV1', wa);
    expect(wa.pendingVoid).toEqual({ kind: 'by_item', itemNumber: 1 });
    await host.process(`WV¥${tkt}/USD500.00/JMKQLM/15JUN/AA/1`, wa);
    expect(wa.pendingVoid).toEqual({ kind: 'manual', ticketNumber: tkt });
    expect(wa.pnr.tickets[0].status ?? 'OPEN').toBe('OPEN'); // not voided — still step 1
  });

  it('rejects WV on an already-voided ticket', async () => {
    await issue();
    await host.process('WV1', wa);
    await host.process('WV1', wa);
    expect(await host.process('WV1', wa)).toBe('TKT ALREADY VOIDED');
  });

  it('rejects WV on a refunded ticket', async () => {
    const tkt = await issue();
    await host.process(`WFR${tkt}`, wa);
    expect(await host.process('WV1', wa)).toBe('TKT REFUNDED - NOT VOIDABLE');
  });

  it('WV<n> with no on-screen PNR returns NO PNR IN AAA', async () => {
    expect(await host.process('WV1', wa)).toContain('NO PNR');
  });

  it('WV<n> with bad item number returns TKT NOT FOUND', async () => {
    await issue();
    expect(await host.process('WV9', wa)).toBe('TKT NOT FOUND');
  });

  it('WV‡<manual> voids by typed ticket number across the store (two-step)', async () => {
    const tkt = await issue();
    await host.process('IG', wa); // drop the on-screen PNR; manual void is global
    const entry = `WV¥${tkt}/USD500.00/JMKQLM/15JUN/AA/1`;
    expect(await host.process(entry, wa)).toContain('RE-ENTER TO VOID');
    expect(await host.process(entry, wa)).toBe(`OK-VOID TKT ${tkt}`);
    // Re-retrieve and check status:
    await host.process('IG', wa);
    expect(wa.pendingVoid).toBeUndefined();
  });

  it('WV‡<unknown> returns TKT NOT FOUND', async () => {
    expect(
      await host.process('WV¥9999999999999/USD500.00/JMKQLM/15JUN/AA/1', wa)
    ).toBe('TKT NOT FOUND');
  });

  it('IG / E both clear the pendingVoid state (work-area reset)', async () => {
    await issue();
    await host.process('WV1', wa);
    expect(wa.pendingVoid).toBeDefined();
    await host.process('IG', wa);
    expect(wa.pendingVoid).toBeUndefined();
  });
});

describe('WV list display (WV* / WV*DT)', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
  });

  async function issue(): string {
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
    return wa.pnr.tickets[0].number;
  }

  it('WV* with no voided tickets returns NO VOIDS', async () => {
    expect(await host.process('WV*', wa)).toBe('NO VOIDS');
  });

  it('WV* lists tickets voided in the current month', async () => {
    const tkt = await issue();
    await host.process('WV1', wa);
    await host.process('WV1', wa);
    const resp = await host.process('WV*', wa);
    expect(resp).toContain('VOID LIST');
    expect(resp).toContain(tkt);
    expect(resp).toContain('SMITH/J');
  });

  it('WV*DT<today> lists today\'s voids', async () => {
    const tkt = await issue();
    await host.process('WV1', wa);
    await host.process('WV1', wa);
    const t = wa.pnr.tickets[0];
    const today = `${String(t.voidedAt!.getDate()).padStart(2, '0')}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][t.voidedAt!.getMonth()]}`;
    const resp = await host.process(`WV*DT${today}`, wa);
    expect(resp).toContain('VOID LIST');
    expect(resp).toContain(tkt);
  });

  it('WV*DT<some-other-day> returns NO VOIDS', async () => {
    await issue();
    await host.process('WV1', wa);
    await host.process('WV1', wa);
    // Pick a date guaranteed-different: voidedAt + 30 days has a different DDMMM.
    const t = wa.pnr.tickets[0];
    const other = new Date(t.voidedAt!.getTime() + 30 * 86_400_000);
    const otherTok = `${String(other.getDate()).padStart(2, '0')}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][other.getMonth()]}`;
    expect(await host.process(`WV*DT${otherTok}`, wa)).toBe('NO VOIDS');
  });

  it('WV*DT<from>-<to> filters by inclusive date window', async () => {
    const tkt = await issue();
    await host.process('WV1', wa);
    await host.process('WV1', wa);
    const t = wa.pnr.tickets[0];
    const fmt = (d: Date) =>
      `${String(d.getDate()).padStart(2, '0')}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()]}`;
    const before = new Date(t.voidedAt!.getTime() - 86_400_000);
    const after = new Date(t.voidedAt!.getTime() + 86_400_000);
    const resp = await host.process(`WV*DT${fmt(before)}-${fmt(after)}`, wa);
    expect(resp).toContain(tkt);
  });
});
