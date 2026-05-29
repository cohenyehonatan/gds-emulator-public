import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo FQ + TKP parsing', () => {
  it('parses FQ as pricing with store=true', () => {
    const r = parseGalileoEntry('FQ');
    expect(r.kind).toBe('pricing');
    if (r.kind === 'pricing') {
      expect(r.store).toBe(true);
      expect(r.mode).toBe('price');
    }
  });

  it('parses TKP1 as ticket with pqRecord=1', () => {
    const r = parseGalileoEntry('TKP1');
    expect(r.kind).toBe('ticket');
    if (r.kind === 'ticket') {
      expect(r.source).toBe('pq');
      expect(r.pqRecord).toBe(1);
    }
  });

  it('parses bare TKP as ticket with pqRecord=1 (default)', () => {
    const r = parseGalileoEntry('TKP');
    if (r.kind === 'ticket') expect(r.pqRecord).toBe(1);
  });

  it('parses TKP3 (filed fare 3)', () => {
    const r = parseGalileoEntry('TKP3');
    if (r.kind === 'ticket') expect(r.pqRecord).toBe(3);
  });

  it('rejects deferred TKP modifiers', () => {
    expect(() => parseGalileoEntry('TKP1P2')).toThrow();
    expect(() => parseGalileoEntry('TKP1OKX')).toThrow();
    expect(() => parseGalileoEntry('TKP0')).toThrow();
  });

  it('rejects deferred FQ qualifiers', () => {
    expect(() => parseGalileoEntry('FQBB')).toThrow();
    expect(() => parseGalileoEntry('FQ-TO')).toThrow();
    expect(() => parseGalileoEntry('FQP2')).toThrow();
  });
});

describe('Galileo FQ + TKP through the host', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    wa = host.newWorkArea();
    host.process('SON/ZHA', wa);
  });

  function buildBookedItinerary() {
    host.process('A15JUNJFKLAX', wa);
    host.process('N1Y1', wa);
    host.process('N.SMITH/JOHN MR', wa);
    host.process('P.LON*02012345678', wa);
    host.process('T.TAU/10JUN', wa);
    host.process('R.AGT', wa);
  }

  it('FQ without itinerary returns NEED ITINERARY', () => {
    expect(host.process('FQ', wa)).toContain('ITINERARY');
  });

  it('FQ without names returns NEED NAME', () => {
    host.process('A15JUNJFKLAX', wa);
    host.process('N1Y1', wa);
    expect(host.process('FQ', wa)).toContain('NAME');
  });

  it('FQ stores a filed fare on the PNR and returns a fare-quote display', () => {
    buildBookedItinerary();
    const resp = host.process('FQ', wa);
    expect(resp).toContain('FILED FARE 1');
    expect(resp).toContain('ADT');
    expect(wa.pnr.priceQuotes.length).toBe(1);
    expect(wa.pnr.priceQuotes[0].passengers[0].passengerType).toBe('ADT');
  });

  it('a second FQ files a second quote (numbered 2)', () => {
    buildBookedItinerary();
    host.process('FQ', wa);
    const resp = host.process('FQ', wa);
    expect(resp).toContain('FILED FARE 2');
    expect(wa.pnr.priceQuotes.length).toBe(2);
  });

  it('TKP1 issues tickets from filed fare 1', () => {
    buildBookedItinerary();
    host.process('FQ', wa);
    const resp = host.process('TKP1', wa);
    expect(resp).toMatch(/^TKT \d{13}/m); // 13-digit ticket number
    expect(resp).toContain('SMITH/J');
    expect(wa.pnr.tickets.length).toBe(1);
    expect(wa.pnr.tickets[0].number).toMatch(/^\d{13}$/);
    expect(wa.pnr.tickets[0].validatingCarrier).toBe('B6');
  });

  it('bare TKP defaults to filed fare 1', () => {
    buildBookedItinerary();
    host.process('FQ', wa);
    const resp = host.process('TKP', wa);
    expect(resp).toMatch(/^TKT \d{13}/m);
    expect(wa.pnr.tickets.length).toBe(1);
  });

  it('TKP without a filed fare returns FILED FARE NOT FOUND', () => {
    buildBookedItinerary();
    expect(host.process('TKP1', wa)).toBe('FILED FARE NOT FOUND');
    expect(wa.pnr.tickets.length).toBe(0);
  });

  it('TKP9 (non-existent filed fare) returns FILED FARE NOT FOUND', () => {
    buildBookedItinerary();
    host.process('FQ', wa);
    expect(host.process('TKP9', wa)).toBe('FILED FARE NOT FOUND');
    expect(wa.pnr.tickets.length).toBe(0);
  });

  it('multi-pax PNR: FQ + TKP issues one ticket per passenger', () => {
    host.process('A15JUNJFKLAX', wa);
    host.process('N2Y1', wa); // 2 seats
    host.process('N.SMITH/JOHN MR/JANE MRS', wa); // 2 passengers, same surname
    host.process('P.LON*02012345678', wa);
    host.process('T.TAU/10JUN', wa);
    host.process('R.AGT', wa);
    host.process('FQ', wa);
    const resp = host.process('TKP1', wa);
    expect(wa.pnr.tickets.length).toBe(2);
    expect(resp.split('\n').length).toBe(2);
  });

  it('cross-area: FQ in B does not surface filed fares in A', () => {
    buildBookedItinerary();
    host.process('FQ', wa);
    expect(wa.pnr.priceQuotes.length).toBe(1);
    host.process('SB', wa);
    expect(wa.pnr.priceQuotes.length).toBe(0);
    host.process('SA', wa);
    expect(wa.pnr.priceQuotes.length).toBe(1);
  });
});
