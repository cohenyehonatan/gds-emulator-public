/**
 * Amadeus v4 chunk 19 — e-ticket issuance (TTP) + display (TWD/TWH).
 *
 * Per QRG p.211-212 (Amadeus Electronic Ticketing chapter):
 *   TTP        issue tickets for displayed PNR (default electronic)
 *   TTP/ET     force electronic (same as bare TTP in our renderer)
 *   TTP/PT     force paper (changes the TE→TK ticket type field)
 *   TTP/S<n>-<m>  segment-range validation
 *   TWD        display ET records on retrieved PNR
 *   TWD/L<n>   specific ticket line
 *   TWD/<n>    specific line from list (same shape as /L<n>)
 *   TWDRL      redisplay the list (compact)
 *   TWH        history-style summary
 *
 * Response wording reconstructed from QRG conventions — verbatim
 * responses aren't documented in the QRG. Format-faithful to the
 * existing TicketRecord shape that Sabre's W¥ also produces, so a
 * future cross-dialect *T-style display works against either.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

function makeHost() {
  return new GdsHost({
    port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
  });
}

async function buildPricedPnr(host: GdsHost) {
  const wa = host.newWorkArea();
  await host.process('JI2345HA/GS', wa);
  await host.process('AN15JULJFKLAX', wa);
  await host.process('SS1Y1', wa);
  await host.process('NM1SMITH/JOHN MR', wa);
  await host.process('AP020 555-1212-A', wa);
  await host.process('TKOK', wa);
  await host.process('RF AGT', wa);
  await host.process('FXP', wa);
  return wa;
}

describe('TTP — e-ticket issuance', () => {
  it('TTP issues one ticket per seat-occupying pax', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    const resp = await host.process('TTP', wa);
    expect(resp).toContain('OK ETKT');
    expect(wa.pnr.tickets).toHaveLength(1);
    expect(wa.pnr.tickets[0].type).toBe('TE');
    expect(wa.pnr.tickets[0].passenger).toBe('SMITH/J');
    expect(wa.pnr.tickets[0].status).toBe('OPEN');
  });

  it('TTP/ET produces electronic type (same as bare TTP)', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    await host.process('TTP/ET', wa);
    expect(wa.pnr.tickets[0].type).toBe('TE');
  });

  it('TTP/PT produces paper type (TE→TK)', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    await host.process('TTP/PT', wa);
    expect(wa.pnr.tickets[0].type).toBe('TK');
  });

  it('TTP with no priced quote returns NO PRICE QUOTE', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    expect(await host.process('TTP', wa)).toBe('NO PRICE QUOTE');
  });

  it('TTP with no itinerary returns NO ITINERARY', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('TTP', wa)).toContain('NO ITINERARY');
  });

  it('TTP twice returns TICKETS ALREADY ISSUED on the second call', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    await host.process('TTP', wa);
    expect(await host.process('TTP', wa)).toBe('TICKETS ALREADY ISSUED');
  });

  it('TTP/S1 validates segment 1 exists', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    expect(await host.process('TTP/S1', wa)).toContain('OK ETKT');
  });

  it('TTP/S99 returns INVALID SEGMENT', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    expect(await host.process('TTP/S99', wa)).toBe('INVALID SEGMENT');
  });

  it('multi-pax PNR issues one ticket per non-infant pax', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS2Y1', wa);
    await host.process('NM2SMITH/JOHN MR/JANE MRS', wa);
    await host.process('AP020 555-1212-A', wa);
    await host.process('TKOK', wa);
    await host.process('RF AGT', wa);
    await host.process('FXP', wa);
    await host.process('TTP', wa);
    expect(wa.pnr.tickets).toHaveLength(2);
    expect(wa.pnr.tickets[0].passenger).toBe('SMITH/J');
    expect(wa.pnr.tickets[1].passenger).toBe('SMITH/J'); // both share surname
  });

  it('ticket number uses validating carrier IATA code (B6 → 279…)', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    await host.process('TTP', wa);
    expect(wa.pnr.tickets[0].number).toMatch(/^279\d{10}$/);
    expect(wa.pnr.tickets[0].validatingCarrier).toBe('B6');
  });
});

describe('TWD — e-ticket display', () => {
  it('TWD with no tickets returns NO ET RECORD', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    expect(await host.process('TWD', wa)).toBe('NO ET RECORD');
  });

  it('TWD after TTP renders the ticket', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    await host.process('TTP', wa);
    const resp = await host.process('TWD', wa);
    expect(resp).toContain('TKT-B6-279');
    expect(resp).toContain('SMITH/J');
    expect(resp).toContain('FARE');
    expect(resp).toContain('B6615 Y 15JUL JFK-LAX');
  });

  it('TWDRT renders same as TWD', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    await host.process('TTP', wa);
    const twd = await host.process('TWD', wa);
    const twdrt = await host.process('TWDRT', wa);
    expect(twdrt).toBe(twd);
  });

  it('TWD/L1 renders specific line', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    await host.process('TTP', wa);
    const resp = await host.process('TWD/L1', wa);
    expect(resp).toContain('TKT-B6-279');
    expect(resp).toContain('L1');
  });

  it('TWD/L99 returns NO ET RECORD (out of range)', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    await host.process('TTP', wa);
    expect(await host.process('TWD/L99', wa)).toBe('NO ET RECORD');
  });

  it('TWDRL renders compact list', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    await host.process('TTP', wa);
    const resp = await host.process('TWDRL', wa);
    expect(resp).toMatch(/^1\.\s+B6\s+279\d+\s+SMITH\/J\s+OPEN/);
  });

  it('TWD/<n> bare-number form works (no L prefix)', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    await host.process('TTP', wa);
    const resp = await host.process('TWD/1', wa);
    expect(resp).toContain('TKT-B6-279');
  });
});

describe('TWH — e-ticket history', () => {
  it('TWH with no tickets returns NO ET RECORD', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    expect(await host.process('TWH', wa)).toBe('NO ET RECORD');
  });

  it('TWH renders status events', async () => {
    const host = makeHost();
    const wa = await buildPricedPnr(host);
    await host.process('TTP', wa);
    const resp = await host.process('TWH', wa);
    expect(resp).toContain('TKT-B6-279');
    expect(resp).toContain('ISSUE');
    expect(resp).toContain('STATUS OPEN');
  });
});
