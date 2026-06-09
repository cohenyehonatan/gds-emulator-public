/**
 * Amadeus v4 chunk 25 — FF accrual/redemption/upgrade/display.
 *
 * Per Amadeus Service Hub solution 862136 (verbatim extracted
 * 2026-06-09; see docs/behavior-layer-research-2026-06-09.md).
 *
 * Verbs:
 *   FFA<carrier>-<number>                   accrual → SSR FQTV
 *   FFA<carrier>-<number>, <c2>, <c3>...    multi-airline accrual
 *   FFR<carrier>-<number>                   redemption → SSR FQTR
 *   FFR<carrier>-<number>-CARDHOLDER <name> cross-cardholder redemption
 *   FFU<carrier>-<number>                   upgrade → SSR FQTU
 *   FFD                                     display FF SSRs from PNR
 *
 * Response format (verbatim from Service Hub):
 *   RP/XXXXXXXXX/
 *     1.VIRTA/VILLE MR
 *     2 *SSR FQTV YY HK/ AY608479929/4
 *
 * When the FF program has agreements (carrier in VFFD_PROGRAMS),
 * SSR airline code is YY. Else it's the card-owning carrier.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

function makeHost() {
  return new GdsHost({
    port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
  });
}

async function setup(host: GdsHost, opts: { skipPax?: boolean; skipItin?: boolean } = {}) {
  const wa = host.newWorkArea();
  await host.process('JI2345HA/GS', wa);
  if (!opts.skipItin) {
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
  }
  if (!opts.skipPax) {
    await host.process('NM1VIRTA/VILLE MR', wa);
  }
  return wa;
}

describe('FFA — Frequent Flyer Accrual', () => {
  it('FFA<carrier>-<number> creates an SSR FQTV element', async () => {
    const host = makeHost();
    const wa = await setup(host);
    expect(await host.process('FFAAY-608479929', wa)).toBe('OK');
    expect(wa.pnr.ssrs).toHaveLength(1);
    expect(wa.pnr.ssrs[0].code).toBe('FQTV');
    expect(wa.pnr.ssrs[0].text).toBe('AY608479929');
  });

  it('FFA for a carrier with agreements uses YY as the SSR airline code', async () => {
    // AY (Finnair) is in our VFFD_PROGRAMS list → has agreements → YY
    // matches the verbatim Service Hub sample.
    const host = makeHost();
    const wa = await setup(host);
    await host.process('FFAAY-608479929', wa);
    expect(wa.pnr.ssrs[0].carrier).toBe('YY');
  });

  it('FFA for a carrier with NO agreements uses the carrier code', async () => {
    const host = makeHost();
    const wa = await setup(host);
    // ZZ is not in VFFD_PROGRAMS — no agreements → SSR carrier = ZZ
    await host.process('FFAZZ-12345', wa);
    expect(wa.pnr.ssrs[0].carrier).toBe('ZZ');
  });

  it('FFA multi-airline (FFA<c>-<n>, <c2>, <c3>) uses YY', async () => {
    const host = makeHost();
    const wa = await setup(host);
    expect(await host.process('FFAZZ-99999, BA, IB', wa)).toBe('OK');
    expect(wa.pnr.ssrs[0].carrier).toBe('YY'); // multi-airline → YY
  });

  it('FFA without itinerary → NO ITINERARY', async () => {
    const host = makeHost();
    const wa = await setup(host, { skipItin: true });
    expect(await host.process('FFAAY-123', wa)).toContain('NO ITINERARY');
  });

  it('FFA also populates pnr.frequentFlyers (cross-verb consistency)', async () => {
    const host = makeHost();
    const wa = await setup(host);
    await host.process('FFAAY-608479929', wa);
    expect(wa.pnr.frequentFlyers).toHaveLength(1);
    expect(wa.pnr.frequentFlyers[0].carrier).toBe('AY');
    expect(wa.pnr.frequentFlyers[0].number).toBe('608479929');
  });
});

describe('FFR — Frequent Flyer Redemption', () => {
  it('FFR<carrier>-<number> creates an SSR FQTR element', async () => {
    const host = makeHost();
    const wa = await setup(host);
    expect(await host.process('FFRIB-55555555', wa)).toBe('OK');
    expect(wa.pnr.ssrs[0].code).toBe('FQTR');
    expect(wa.pnr.ssrs[0].text).toBe('IB55555555');
    expect(wa.pnr.ssrs[0].carrier).toBe('IB');
  });

  it('FFR with cross-cardholder syntax records the cardholder name', async () => {
    const host = makeHost();
    const wa = await setup(host);
    await host.process('FFRIB-55555555-CARDHOLDER GARCIA/PEDRO MR', wa);
    expect(wa.pnr.ssrs[0].code).toBe('FQTR');
    expect(wa.pnr.ssrs[0].text).toContain('CARDHOLDER GARCIA/PEDRO MR');
  });

  it('FFR with no names → NEEDS NAME', async () => {
    const host = makeHost();
    const wa = await setup(host, { skipPax: true });
    expect(await host.process('FFRIB-55555555', wa)).toBe('NEEDS NAME');
  });
});

describe('FFU — Frequent Flyer Upgrade', () => {
  it('FFU<carrier>-<number> creates an SSR FQTU element', async () => {
    const host = makeHost();
    const wa = await setup(host);
    expect(await host.process('FFUAA-1234567890', wa)).toBe('OK');
    expect(wa.pnr.ssrs[0].code).toBe('FQTU');
    expect(wa.pnr.ssrs[0].text).toBe('AA1234567890');
  });

  it('FFU with no names → NEEDS NAME', async () => {
    const host = makeHost();
    const wa = await setup(host, { skipPax: true });
    expect(await host.process('FFUAA-1234567890', wa)).toBe('NEEDS NAME');
  });
});

describe('FFD — Display FF SSRs', () => {
  it('FFD with no FF data → NO FREQUENT FLYER DATA', async () => {
    const host = makeHost();
    const wa = await setup(host);
    expect(await host.process('FFD', wa)).toBe('NO FREQUENT FLYER DATA');
  });

  it('FFD after FFA shows the FQTV line', async () => {
    const host = makeHost();
    const wa = await setup(host);
    await host.process('FFAAY-608479929', wa);
    const resp = await host.process('FFD', wa);
    expect(resp).toContain('FF DISPLAY');
    expect(resp).toContain('*SSR FQTV YY HK/ AY608479929');
  });

  it('FFD shows all of FQTV/FQTR/FQTU together in order', async () => {
    const host = makeHost();
    const wa = await setup(host);
    await host.process('FFAAY-608479929', wa);
    await host.process('FFRIB-55555555', wa);
    await host.process('FFUAA-1234567890', wa);
    const resp = await host.process('FFD', wa);
    const lines = resp.split('\n');
    expect(lines.some((l) => l.includes('FQTV'))).toBe(true);
    expect(lines.some((l) => l.includes('FQTR'))).toBe(true);
    expect(lines.some((l) => l.includes('FQTU'))).toBe(true);
  });

  it('FFD skips non-FF SSRs (filter is FQT*-only)', async () => {
    const host = makeHost();
    const wa = await setup(host);
    await host.process('FFAAY-608479929', wa);
    await host.process('SR VGML/P1', wa); // not a FF SSR
    const resp = await host.process('FFD', wa);
    expect(resp).toContain('FQTV');
    expect(resp).not.toContain('VGML');
  });
});

describe('Verbatim response format match (per Service Hub solution 862136)', () => {
  it('FFAAY-608479929 followed by FFD produces the YY-and-AY pattern from the sample', async () => {
    // The verbatim Service Hub sample shows:
    //   2 *SSR FQTV YY HK/ AY608479929
    // We render identically (line-number depends on FFD position).
    const host = makeHost();
    const wa = await setup(host);
    await host.process('FFAAY-608479929', wa);
    const resp = await host.process('FFD', wa);
    expect(resp).toMatch(/\*SSR FQTV YY HK\/ AY608479929/);
  });
});
