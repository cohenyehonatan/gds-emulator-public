import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('ticketing parsing', () => {
  it('parses W¥, TTP, W¥PQ<n>, W¥N<item>', () => {
    const all = parseEntry('W¥');
    if (all.kind === 'ticket') expect(all).toMatchObject({ source: 'pnr' });
    const ttp = parseEntry('TTP');
    if (ttp.kind === 'ticket') expect(ttp).toMatchObject({ source: 'pnr' });
    const pq = parseEntry('W¥PQ2');
    if (pq.kind === 'ticket') expect(pq).toMatchObject({ source: 'pq', pqRecord: 2 });
    const name = parseEntry('W¥N1');
    if (name.kind === 'ticket') expect(name).toMatchObject({ source: 'pnr', nameItem: 1 });
  });

  it('does not capture WP pricing entries', () => {
    expect(parseEntry('WP').kind).toBe('pricing');
    expect(parseEntry('WPNC').kind).toBe('pricing');
  });

  it('parses ¥-separated qualifiers (W¥PQ1¥KP0¥ALH from the source example)', () => {
    const e = parseEntry('W¥PQ1¥KP0¥ALH');
    expect(e.kind).toBe('ticket');
    if (e.kind === 'ticket') {
      expect(e).toMatchObject({
        source: 'pq',
        pqRecord: 1,
        commissionPercent: 0,
        validatingCarrier: 'LH',
      });
    }
  });

  it('parses a bare qualifier (W¥KP10) with no PQ/N base', () => {
    const e = parseEntry('W¥KP10');
    expect(e.kind).toBe('ticket');
    if (e.kind === 'ticket') {
      expect(e).toMatchObject({ source: 'pnr', commissionPercent: 10 });
    }
  });

  it('rejects a qualifier whose source still isn’t pinned (e.g. W¥F<fop>)', () => {
    // Form of payment, segment selection, paper ticket, void/refund all
    // need the Issue-Tickets QR which isn't in references/ yet.
    expect(() => parseEntry('W¥FVISA')).toThrow();
  });
});

describe('e-ticket issuance', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*4321', wa);
  });

  function book(seats = 1): void {
    host.process('115JUNJFKLAX', wa);
    host.process(`0${seats}Y1`, wa);
  }

  it('issues one e-ticket per passenger, pricing as booked', () => {
    book();
    host.process('-SMITH/JOHN MR', wa);
    const resp = host.process('W¥', wa);
    expect(resp).toContain('TKT/TIME LIMIT');
    expect(resp).toContain('TE '); // electronic ticket line
    expect(resp).toContain('SMITH/J');
    expect(resp).toMatch(/TE \d{13}-AT SMITH\/J A0UC\*4321 \d{4}\/\d+[A-Z]{3} D/);
    expect(wa.pnr.tickets).toHaveLength(1);
    expect(wa.pnr.tickets[0].number).toMatch(/^\d{13}$/);
    expect(wa.pnr.tickets[0].total).toBeGreaterThan(0);
  });

  it('surfaces issued tickets in the *T ticketing field', () => {
    book();
    host.process('-SMITH/JOHN MR', wa);
    host.process('7TAW15JUN/', wa);
    host.process('W¥', wa);
    const t = host.process('*T', wa);
    expect(t).toContain('1.TAW15JUN/'); // ticketing arrangement stays
    expect(t).toContain('SMITH/J'); // issued ticket added below it
  });

  it('issues a distinct number per passenger', () => {
    book(2);
    host.process('-2MURRAY/FRED MR/HANA MRS', wa);
    host.process('W¥', wa);
    expect(wa.pnr.tickets.map((t) => t.passenger)).toEqual(['MURRAY/F', 'MURRAY/H']);
    const nums = wa.pnr.tickets.map((t) => t.number);
    expect(new Set(nums).size).toBe(2); // unique serials
  });

  it('issues from a stored PQ record (W¥PQ<n>)', () => {
    book();
    host.process('-SMITH/JOHN MR', wa);
    host.process('WP', wa);
    host.process('PQ', wa); // store PQ 1
    const resp = host.process('W¥PQ1', wa);
    expect(resp).toContain('TE ');
    expect(wa.pnr.tickets).toHaveLength(1);
  });

  it('marks an international journey with tariff I', () => {
    host.process('115JUNDFWLHR', wa); // BA DFW-LHR
    host.process('01Y1', wa);
    host.process('-SMITH/JOHN MR', wa);
    const resp = host.process('W¥', wa);
    expect(resp).toMatch(/ I$/m); // tariff basis I, not D
    expect(wa.pnr.tickets[0].tariff).toBe('I');
  });

  it('TTP is a synonym for W¥', () => {
    book();
    host.process('-SMITH/JOHN MR', wa);
    expect(host.process('TTP', wa)).toContain('TE ');
    expect(wa.pnr.tickets).toHaveLength(1);
  });

  it('rejects issuance without an itinerary or without names', () => {
    expect(host.process('W¥', wa)).toContain('ITINERARY'); // empty work area
    book();
    expect(host.process('W¥', wa)).toContain('NAME'); // itinerary but no name
  });

  it('refuses to re-issue once tickets exist', () => {
    book();
    host.process('-SMITH/JOHN MR', wa);
    host.process('W¥', wa);
    expect(host.process('W¥', wa)).toBe('TICKETS ALREADY ISSUED');
  });

  it('A<carrier> overrides the validating carrier — ticket-number prefix changes', () => {
    book();
    host.process('-SMITH/JOHN MR', wa);
    host.process('WP', wa); // price (sets fq.validatingCarrier from the itinerary)
    host.process('W¥ALH', wa); // override to Lufthansa
    const ticket = wa.pnr.tickets[0];
    expect(ticket.validatingCarrier).toBe('LH');
    expect(ticket.number.startsWith('220')).toBe(true); // 220 is LH's airline code
  });

  it('KP<n> applies a commission percentage to the base fare', () => {
    book();
    host.process('-SMITH/JOHN MR', wa);
    host.process('WP', wa);
    host.process('W¥KP10', wa);
    const ticket = wa.pnr.tickets[0];
    expect(ticket.commission).toBeCloseTo(ticket.base * 0.1, 2);
  });

  it('K<amount> applies a flat commission', () => {
    book();
    host.process('-SMITH/JOHN MR', wa);
    host.process('WP', wa);
    host.process('W¥K12.50', wa);
    expect(wa.pnr.tickets[0].commission).toBe(12.5);
  });
});
