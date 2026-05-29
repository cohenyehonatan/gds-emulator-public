import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo FQ + TKP parsing', async () => {
  it('parses FQ as pricing with store=true', async () => {
    const r = parseGalileoEntry('FQ');
    expect(r.kind).toBe('pricing');
    if (r.kind === 'pricing') {
      expect(r.store).toBe(true);
      expect(r.mode).toBe('price');
    }
  });

  it('parses TKP1 as ticket with pqRecord=1', async () => {
    const r = parseGalileoEntry('TKP1');
    expect(r.kind).toBe('ticket');
    if (r.kind === 'ticket') {
      expect(r.source).toBe('pq');
      expect(r.pqRecord).toBe(1);
    }
  });

  it('parses bare TKP as ticket with pqRecord=1 (default)', async () => {
    const r = parseGalileoEntry('TKP');
    if (r.kind === 'ticket') expect(r.pqRecord).toBe(1);
  });

  it('parses TKP3 (filed fare 3)', async () => {
    const r = parseGalileoEntry('TKP3');
    if (r.kind === 'ticket') expect(r.pqRecord).toBe(3);
  });

  it('rejects deferred TKP modifiers', async () => {
    expect(() => parseGalileoEntry('TKP1P2')).toThrow();
    expect(() => parseGalileoEntry('TKP1OKX')).toThrow();
    expect(() => parseGalileoEntry('TKP0')).toThrow();
  });

  it('rejects deferred FQ qualifiers', async () => {
    expect(() => parseGalileoEntry('FQBB')).toThrow();
    expect(() => parseGalileoEntry('FQ-TO')).toThrow();
    expect(() => parseGalileoEntry('FQP2')).toThrow();
  });
});

describe('Galileo FQ + TKP through the host', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });

  async function buildBookedItinerary() {
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
  }

  it('FQ without itinerary returns NEED ITINERARY', async () => {
    expect(await host.process('FQ', wa)).toContain('ITINERARY');
  });

  it('FQ without names returns NEED NAME', async () => {
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    expect(await host.process('FQ', wa)).toContain('NAME');
  });

  it('FQ stores a filed fare on the PNR and returns a fare-quote display', async () => {
    await buildBookedItinerary();
    const resp = await host.process('FQ', wa);
    expect(resp).toContain('FILED FARE 1');
    expect(resp).toContain('ADT');
    expect(wa.pnr.priceQuotes.length).toBe(1);
    expect(wa.pnr.priceQuotes[0].passengers[0].passengerType).toBe('ADT');
  });

  it('a second FQ files a second quote (numbered 2)', async () => {
    await buildBookedItinerary();
    await host.process('FQ', wa);
    const resp = await host.process('FQ', wa);
    expect(resp).toContain('FILED FARE 2');
    expect(wa.pnr.priceQuotes.length).toBe(2);
  });

  it('TKP1 issues tickets from filed fare 1', async () => {
    await buildBookedItinerary();
    await host.process('FQ', wa);
    const resp = await host.process('TKP1', wa);
    expect(resp).toMatch(/^TKT \d{13}/m); // 13-digit ticket number
    expect(resp).toContain('SMITH/J');
    expect(wa.pnr.tickets.length).toBe(1);
    expect(wa.pnr.tickets[0].number).toMatch(/^\d{13}$/);
    expect(wa.pnr.tickets[0].validatingCarrier).toBe('B6');
  });

  it('bare TKP defaults to filed fare 1', async () => {
    await buildBookedItinerary();
    await host.process('FQ', wa);
    const resp = await host.process('TKP', wa);
    expect(resp).toMatch(/^TKT \d{13}/m);
    expect(wa.pnr.tickets.length).toBe(1);
  });

  it('TKP without a filed fare returns FILED FARE NOT FOUND', async () => {
    await buildBookedItinerary();
    expect(await host.process('TKP1', wa)).toBe('FILED FARE NOT FOUND');
    expect(wa.pnr.tickets.length).toBe(0);
  });

  it('TKP9 (non-existent filed fare) returns FILED FARE NOT FOUND', async () => {
    await buildBookedItinerary();
    await host.process('FQ', wa);
    expect(await host.process('TKP9', wa)).toBe('FILED FARE NOT FOUND');
    expect(wa.pnr.tickets.length).toBe(0);
  });

  it('multi-pax PNR: FQ + TKP issues one ticket per passenger', async () => {
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N2Y1', wa); // 2 seats
    await host.process('N.SMITH/JOHN MR/JANE MRS', wa); // 2 passengers, same surname
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    await host.process('FQ', wa);
    const resp = await host.process('TKP1', wa);
    expect(wa.pnr.tickets.length).toBe(2);
    expect(resp.split('\n').length).toBe(2);
  });

  it('cross-area: FQ in B does not surface filed fares in A', async () => {
    await buildBookedItinerary();
    await host.process('FQ', wa);
    expect(wa.pnr.priceQuotes.length).toBe(1);
    await host.process('SB', wa);
    expect(wa.pnr.priceQuotes.length).toBe(0);
    await host.process('SA', wa);
    expect(wa.pnr.priceQuotes.length).toBe(1);
  });
});
