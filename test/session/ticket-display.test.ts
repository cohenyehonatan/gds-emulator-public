import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('ticket document display parsing (WETR* / WTDB*)', () => {
  it('parses WETR* redisplay and WETR*H history', () => {
    const r = parseEntry('WETR*');
    if (r.kind === 'ticket_document_display') {
      expect(r).toMatchObject({ family: 'etr', mode: 'redisplay' });
    }
    const h = parseEntry('WETR*H');
    if (h.kind === 'ticket_document_display') {
      expect(h).toMatchObject({ family: 'etr', mode: 'history' });
    }
  });

  it('parses WETR*<n> and WETR*T<13-digit> with optional /E', () => {
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

  it('parses WTDB*<n> and WTDB*T<13> with optional /OB', () => {
    const byItem = parseEntry('WTDB*1');
    if (byItem.kind === 'ticket_document_display') {
      expect(byItem).toMatchObject({ family: 'image', mode: 'by_item', itemNumber: 1 });
    }
    const ob = parseEntry('WTDB*1/OB');
    if (ob.kind === 'ticket_document_display') {
      expect(ob).toMatchObject({ family: 'image', mode: 'by_item', enhanced: true });
    }
  });

  it('rejects malformed selectors', () => {
    expect(() => parseEntry('WETR*XYZ')).toThrow();
  });
});

describe('ticket document display handling', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*4321', wa);
  });

  function issue(): string {
    host.process('IG', wa);
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa);
    host.process('-SMITH/JOHN MR', wa);
    host.process('9305-555-1212-H', wa);
    host.process('7TAW15JUN/', wa);
    host.process('6P', wa);
    const locator = host.process('E', wa);
    host.process(`*${locator}`, wa);
    host.process('W¥', wa);
    return wa.pnr.tickets[0].number;
  }

  it('WETR*<n> renders the ETR with one coupon per segment', () => {
    issue();
    const resp = host.process('WETR*1', wa);
    expect(resp).toContain('ELECTRONIC TICKET RECORD');
    expect(resp).toContain('SMITH/J');
    expect(resp).toContain('CPN1'); // one coupon for the one segment
  });

  it('WETR*T<13> finds a ticket across the store', () => {
    const tkt = issue();
    host.process('IG', wa); // leave the PNR; ticket lookup is global
    const resp = host.process(`WETR*T${tkt}`, wa);
    expect(resp).toContain('ELECTRONIC TICKET RECORD');
    expect(resp).toContain(tkt);
  });

  it('WETR* redisplays the last document', () => {
    expect(host.process('WETR*', wa)).toBe('NO PREVIOUS DOCUMENT');
    issue();
    const first = host.process('WETR*1', wa);
    expect(host.process('WETR*', wa)).toBe(first);
  });

  it('WETR*H lists every ticket on the PNR', () => {
    issue();
    const resp = host.process('WETR*H', wa);
    expect(resp).toContain('ETR HISTORY');
    expect(resp).toContain('SMITH/J');
  });

  it('WTDB*<n> renders the image variant header', () => {
    issue();
    expect(host.process('WTDB*1', wa)).toContain('TICKET IMAGE');
  });

  it('WETR*<n>/E surfaces the validating-carrier / commission / FOP line', () => {
    issue();
    const enh = host.process('WETR*1/E', wa);
    expect(enh).toContain('VAL');
    expect(enh).toContain('COMM');
    expect(enh).toContain('FOP');
  });

  it('WETR*T<unknown> returns TKT NOT FOUND', () => {
    expect(host.process('WETR*T9999999999999', wa)).toBe('TKT NOT FOUND');
  });
});
