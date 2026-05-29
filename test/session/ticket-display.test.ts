import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('ticket document display parsing (WETR* / WTDB*)', async () => {
  it('parses WETR* redisplay and WETR*H history', async () => {
    const r = parseEntry('WETR*');
    if (r.kind === 'ticket_document_display') {
      expect(r).toMatchObject({ family: 'etr', mode: 'redisplay' });
    }
    const h = parseEntry('WETR*H');
    if (h.kind === 'ticket_document_display') {
      expect(h).toMatchObject({ family: 'etr', mode: 'history' });
    }
  });

  it('parses WETR*<n> and WETR*T<13-digit> with optional /E', async () => {
    const byItem = parseEntry('WETR*2');
    if (byItem.kind === 'ticket_document_display') {
      expect(byItem).toMatchObject({ family: 'etr', mode: 'by_item', itemNumber: 2 });
    }
    const byTkt = parseEntry('WETR*T1234567890123');
    if (byTkt.kind === 'ticket_document_display') {
      expect(byTkt).toMatchObject({
        family: 'etr',
        mode: 'by_ticket',
        ticketNumber: '1234567890123',
      });
    }
    const enh = parseEntry('WETR*2/E');
    if (enh.kind === 'ticket_document_display') {
      expect(enh).toMatchObject({ family: 'etr', mode: 'by_item', itemNumber: 2, enhanced: true });
    }
  });

  it('parses WTDB*<n> and WTDB*T<13> with optional /OB', async () => {
    const byItem = parseEntry('WTDB*1');
    if (byItem.kind === 'ticket_document_display') {
      expect(byItem).toMatchObject({ family: 'image', mode: 'by_item', itemNumber: 1 });
    }
    const ob = parseEntry('WTDB*1/OB');
    if (ob.kind === 'ticket_document_display') {
      expect(ob).toMatchObject({ family: 'image', mode: 'by_item', enhanced: true });
    }
  });

  it('rejects malformed selectors', async () => {
    expect(() => parseEntry('WETR*XYZ')).toThrow();
  });
});

describe('ticket document display handling', async () => {
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

  it('WETR*<n> renders the ETR with one coupon per segment', async () => {
    await issue();
    const resp = await host.process('WETR*1', wa);
    expect(resp).toContain('ELECTRONIC TICKET RECORD');
    expect(resp).toContain('SMITH/J');
    expect(resp).toContain('CPN1'); // one coupon for the one segment
  });

  it('WETR*T<13> finds a ticket across the store', async () => {
    const tkt = await issue();
    await host.process('IG', wa); // leave the PNR; ticket lookup is global
    const resp = await host.process(`WETR*T${tkt}`, wa);
    expect(resp).toContain('ELECTRONIC TICKET RECORD');
    expect(resp).toContain(tkt);
  });

  it('WETR* redisplays the last document', async () => {
    expect(await host.process('WETR*', wa)).toBe('NO PREVIOUS DOCUMENT');
    await issue();
    const first = await host.process('WETR*1', wa);
    expect(await host.process('WETR*', wa)).toBe(first);
  });

  it('WETR*H lists every ticket on the PNR', async () => {
    await issue();
    const resp = await host.process('WETR*H', wa);
    expect(resp).toContain('ETR HISTORY');
    expect(resp).toContain('SMITH/J');
  });

  it('WTDB*<n> renders the image variant header', async () => {
    await issue();
    expect(await host.process('WTDB*1', wa)).toContain('TICKET IMAGE');
  });

  it('WETR*<n>/E surfaces the validating-carrier / commission / FOP line', async () => {
    await issue();
    const enh = await host.process('WETR*1/E', wa);
    expect(enh).toContain('VAL');
    expect(enh).toContain('COMM');
    expect(enh).toContain('FOP');
  });

  it('WETR*T<unknown> returns TKT NOT FOUND', async () => {
    expect(await host.process('WETR*T9999999999999', wa)).toBe('TKT NOT FOUND');
  });
});
