/**
 * Amadeus v4 chunk 21 — document output verbs (INV/INE/IBP/IEP).
 *
 * Per QRG p.221 (Amadeus Invoice) + p.225 (Amadeus Itinerary).
 *
 * Verbs implemented:
 *   INVD / INV          basic invoice (display / print)
 *   INED / INE          extended invoice
 *   INVDJ / INVJ        joint basic invoice (one for all pax)
 *   INEDJ / INEJ        joint extended invoice
 *   IBD / IBP           basic itinerary (display / print)
 *   IED / IEP           extended itinerary
 *   IBPJ / IEPJ         joint itinerary
 *
 * Qualifiers:
 *   /P<n>[-<m>]         pax filter
 *   /S<n>[-<m>]         segment filter
 *
 * Display vs print verbs render identical content (we don't model
 * a printer). Response wording reconstructed from QRG conventions.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

function makeHost() {
  return new GdsHost({
    port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
  });
}

async function buildPnr(host: GdsHost, opts: { issue?: boolean; multipax?: boolean } = {}) {
  const wa = host.newWorkArea();
  await host.process('JI2345HA/GS', wa);
  await host.process('AN15JULJFKLAX', wa);
  await host.process(`SS${opts.multipax ? 2 : 1}Y1`, wa);
  if (opts.multipax) {
    await host.process('NM2SMITH/JOHN MR/JANE MRS', wa);
  } else {
    await host.process('NM1SMITH/JOHN MR', wa);
  }
  await host.process('AP020 555-1212-A', wa);
  await host.process('TKOK', wa);
  await host.process('RF AGT', wa);
  await host.process('FXP', wa);
  if (opts.issue) await host.process('TTP', wa);
  return wa;
}

describe('Invoice family — INV / INE / INVD / INED', () => {
  it('INV prints basic invoice with passenger + segments + fares', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    const resp = await host.process('INV', wa);
    expect(resp).toContain('*** AMADEUS INVOICE ***');
    expect(resp).toContain('PASSENGER(S):');
    expect(resp).toContain('SMITH: JOHN MR');
    expect(resp).toContain('SEGMENTS:');
    expect(resp).toContain('B6615 Y 15JUL JFK-LAX');
    expect(resp).toContain('FARES:');
    expect(resp).toContain('273.48 USD');
    expect(resp).toContain('*** END INVOICE ***');
  });

  it('INVD renders same content as INV (display vs print)', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    const inv = await host.process('INV', wa);
    const invd = await host.process('INVD', wa);
    expect(invd).toBe(inv);
  });

  it('INE (extended) adds tax breakdown', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    const resp = await host.process('INE', wa);
    expect(resp).toContain('INVOICE (EXTENDED)');
    expect(resp).toContain('TAX BREAKDOWN:');
  });

  it('INE adds tickets block when tickets issued', async () => {
    const host = makeHost();
    const wa = await buildPnr(host, { issue: true });
    const resp = await host.process('INE', wa);
    expect(resp).toContain('TICKETS:');
    expect(resp).toMatch(/B6 279\d{10}/);
  });

  it('INVJ (joint) shows one block for all pax instead of per-pax', async () => {
    const host = makeHost();
    const wa = await buildPnr(host, { multipax: true });
    const joint = await host.process('INVJ', wa);
    // Joint should not have the per-pax `---` divider between blocks.
    expect(joint).not.toContain('---');
  });

  it('INV with no priced quote still renders (notes the gap)', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    const resp = await host.process('INV', wa);
    expect(resp).toContain('(no priced quotes — run FXP)');
  });
});

describe('Itinerary family — IBP / IEP / IBD / IED', () => {
  it('IBP prints basic itinerary with passenger + segments only (no fares)', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    const resp = await host.process('IBP', wa);
    expect(resp).toContain('*** AMADEUS ITINERARY ***');
    expect(resp).toContain('PASSENGER(S):');
    expect(resp).toContain('SEGMENTS:');
    expect(resp).not.toContain('FARES:'); // basic itinerary excludes fares
  });

  it('IEP (extended) shows tickets after issuance', async () => {
    const host = makeHost();
    const wa = await buildPnr(host, { issue: true });
    const resp = await host.process('IEP', wa);
    expect(resp).toContain('ITINERARY (EXTENDED)');
    expect(resp).toContain('TICKETS:');
  });

  it('IBD = IBP content', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    expect(await host.process('IBD', wa)).toBe(await host.process('IBP', wa));
  });
});

describe('Pax / segment filters', () => {
  it('INV/P1 selects only NameItem 1 (when each pax is its own NameItem)', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS2Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);    // item 1
    await host.process('NM1JONES/MARY MRS', wa);    // item 2
    await host.process('AP020 555-1212-A', wa);
    await host.process('TKOK', wa);
    await host.process('RF AGT', wa);
    const resp = await host.process('INV/P1', wa);
    expect(resp).toContain('SMITH: JOHN MR');
    // JONES (item 2) should be filtered out.
    expect(resp).not.toContain('JONES');
  });

  it('INV/P99 returns INVALID PASSENGER', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    expect(await host.process('INV/P99', wa)).toBe('INVALID PASSENGER');
  });

  it('INV/S1 selects only segment 1', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    const resp = await host.process('INV/S1', wa);
    expect(resp).toContain('1. B6615');
  });

  it('INV/S99 returns INVALID SEGMENT', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    expect(await host.process('INV/S99', wa)).toBe('INVALID SEGMENT');
  });

  it('INV/P1/S1 combined filter accepts', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    const resp = await host.process('INV/P1/S1', wa);
    expect(resp).toContain('*** AMADEUS INVOICE ***');
  });
});

describe('Pre-conditions', () => {
  it('INV with no itinerary → NO ITINERARY', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('INV', wa)).toContain('NO ITINERARY');
  });

  it('IBP with no names → NEEDS NAME', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    expect(await host.process('IBP', wa)).toBe('NEEDS NAME');
  });
});
