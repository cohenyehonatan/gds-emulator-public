/**
 * Amadeus exit-row passenger-profile check — chunk 7 deferred #5.
 *
 * Per IATA Resolution 700 + 14 CFR 121.585, certain passenger types
 * MUST NOT be seated in emergency exit rows. The Amadeus ST handler
 * now validates the exit-row constraint when:
 *   - The target seat is in an exit row (Characteristic includes 'E')
 *   - A passenger reference is supplied (or the seat applies to all pax)
 *
 * Ineligible passenger profiles:
 *   - Infants: NameItem.infant flag, or SSR INFT / BSCT
 *   - Children: title CHD / INF / MSTR
 *   - Unaccompanied minors: SSR UMNR
 *   - Mobility/medical assistance needed: WCHR/WCHS/WCHC/BLND/DEAF/MAAS/DPNA
 *
 * Response wording: `EXIT ROW RESTRICTED - <reason>` where reason is
 * INFANT / CHILD / SSR <code>.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

function makeHost() {
  return new GdsHost({
    port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
  });
}

async function setupB6615Y(host: GdsHost) {
  const wa = host.newWorkArea();
  await host.process('JI2345HA/GS', wa);
  await host.process('AN15JULJFKLAX', wa);
  await host.process('SS1Y1', wa); // B6615 32A Y class — exit row at 11
  return wa;
}

describe('Amadeus ST exit-row eligibility — happy path', () => {
  it('adult passenger gets an exit-row seat (11A/P1/S1) → OK', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/JOHN MR', wa);
    const resp = await host.process('ST/11A/P1/S1', wa);
    expect(resp).toBe('OK');
  });

  it('adult passenger gets a non-exit-row seat (12A/P1/S1) → OK', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/JOHN MR', wa);
    const resp = await host.process('ST/14A/P1/S1', wa);
    expect(resp).toBe('OK');
  });

  it('preference-only request (ST/W/P1) skips the eligibility check', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/BABY MISS', wa);
    // SSR makes pax ineligible, but pref-only ST doesn't check
    await host.process('SR WCHR/P1', wa);
    const resp = await host.process('ST/W/P1', wa);
    expect(resp).toBe('OK');
  });
});

describe('Amadeus ST exit-row eligibility — infant / child profiles', () => {
  it('infant (NameItem.infant flag) → EXIT ROW RESTRICTED - INFANT', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/JOHN MR', wa);
    // Programmatically set infant flag since NM doesn't parse I/ in
    // chunk 5 (that's a separate gap — flagged in the NM handler).
    wa.pnr.names.push({
      surname: 'SMITH', passengers: [{ firstName: 'BABY' }], count: 1, infant: true,
    });
    const resp = await host.process('ST/11A/P2/S1', wa);
    expect(resp).toBe('EXIT ROW RESTRICTED - INFANT');
  });

  it('child (title MSTR) → EXIT ROW RESTRICTED - CHILD', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/TOMMY MSTR', wa);
    const resp = await host.process('ST/11A/P1/S1', wa);
    expect(resp).toBe('EXIT ROW RESTRICTED - CHILD');
  });

  it('child (title CHD) → EXIT ROW RESTRICTED - CHILD', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/TOMMY CHD', wa);
    const resp = await host.process('ST/11A/P1/S1', wa);
    expect(resp).toBe('EXIT ROW RESTRICTED - CHILD');
  });

  it('child + adult, target child specifically → EXIT ROW RESTRICTED', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('NM1SMITH/TOMMY MSTR', wa);
    const resp = await host.process('ST/11A/P2/S1', wa);
    expect(resp).toBe('EXIT ROW RESTRICTED - CHILD');
  });

  it('child + adult, target adult only → OK', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('NM1SMITH/TOMMY MSTR', wa);
    const resp = await host.process('ST/11A/P1/S1', wa);
    expect(resp).toBe('OK');
  });
});

describe('Amadeus ST exit-row eligibility — SSR-based', () => {
  for (const ssr of ['WCHR', 'WCHS', 'WCHC', 'BLND', 'DEAF', 'MAAS', 'UMNR', 'DPNA']) {
    it(`SSR ${ssr} on pax 1 → EXIT ROW RESTRICTED - SSR ${ssr}`, async () => {
      const host = makeHost();
      const wa = await setupB6615Y(host);
      await host.process('NM1SMITH/JOHN MR', wa);
      await host.process(`SR ${ssr}/P1`, wa);
      const resp = await host.process('ST/11A/P1/S1', wa);
      expect(resp).toBe(`EXIT ROW RESTRICTED - SSR ${ssr}`);
    });
  }

  it('SSR INFT → EXIT ROW RESTRICTED - SSR INFT', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('SR INFT-1', wa);
    const resp = await host.process('ST/11A/P1/S1', wa);
    expect(resp).toBe('EXIT ROW RESTRICTED - SSR INFT');
  });

  it('SSR BSCT (bassinet) → EXIT ROW RESTRICTED - SSR BSCT', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('SR BSCT-1', wa);
    const resp = await host.process('ST/11A/P1/S1', wa);
    expect(resp).toBe('EXIT ROW RESTRICTED - SSR BSCT');
  });

  it('SSR on different pax does NOT block the targeted pax', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/JOHN MR', wa); // pax 1
    await host.process('NM1JONES/MARY MRS', wa); // pax 2
    await host.process('SR WCHR/P2', wa); // SSR on pax 2
    // Assignment to pax 1 should succeed; pax 2 has the SSR but
    // ST/11A/P1 targets pax 1 only.
    const resp = await host.process('ST/11A/P1/S1', wa);
    expect(resp).toBe('OK');
  });

  it('SSR without nameRef applies to all pax — blocks any exit-row assignment', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/JOHN MR', wa);
    // SR WCHR with no /P<n> applies to all pax
    await host.process('SR WCHR', wa);
    const resp = await host.process('ST/11A/P1/S1', wa);
    expect(resp).toBe('EXIT ROW RESTRICTED - SSR WCHR');
  });

  it('benign SSR (VGML meal) does NOT block exit-row assignment', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('SR VGML-1', wa);
    const resp = await host.process('ST/11A/P1/S1', wa);
    expect(resp).toBe('OK');
  });
});

describe('Amadeus ST exit-row eligibility — no-pax-ref behavior', () => {
  it('ST/<exit-seat> with no /P<n> checks ALL passengers', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('NM1SMITH/TOMMY MSTR', wa); // child as pax 2
    // No /P<n> → applies to all pax → must block (one is a child)
    const resp = await host.process('ST/11A/S1', wa);
    expect(resp).toBe('EXIT ROW RESTRICTED - CHILD');
  });

  it('ST/<non-exit-seat> with no /P<n> + child on board → OK', async () => {
    const host = makeHost();
    const wa = await setupB6615Y(host);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('NM1SMITH/TOMMY MSTR', wa);
    // Non-exit seat — child doesn't matter
    const resp = await host.process('ST/14A/S1', wa);
    expect(resp).toBe('OK');
  });
});
