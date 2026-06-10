/**
 * Polish — passive + ghost segments (Service Hub solution 875906,
 * entries + response shapes verbatim) and the GGPCA carrier-access
 * page (layout verbatim from the solution's UA sample; flag VALUES
 * for our carriers reconstructed).
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

function makeHost() {
  return new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'NCE1A0900' });
}

async function withAvail(h: GdsHost) {
  const wa = h.newWorkArea();
  await h.process('JI2345HA/GS', wa);
  await h.process('AN15JULJFKLAX', wa);
  return wa;
}

describe('passive / ghost sells (875906)', () => {
  it('SS<n><cls><line>/PK/<locator> sells a confirmed passive segment', async () => {
    const h = makeHost();
    const wa = await withAvail(h);
    const resp = await h.process('SS1Q2/PK/RECLOC', wa);
    expect(resp).toContain('PK1 RECLOC');
    expect(wa.pnr.segments[0]).toMatchObject({ status: 'PK', airlineLocator: 'RECLOC', bookingClass: 'Q' });
  });

  it('PK/PL require the airline record locator; GK does not', async () => {
    const h = makeHost();
    const wa = await withAvail(h);
    expect(await h.process('SS1Q2/PK', wa)).toBe('RECORD LOCATOR REQUIRED');
    expect(await h.process('SS1Q2/PL', wa)).toBe('RECORD LOCATOR REQUIRED');
    expect(await h.process('SS1Y1/GK', wa)).toContain('GK1');
  });

  it('long sell with /HHMMHHMM times and locator', async () => {
    const h = makeHost();
    const wa = await withAvail(h);
    const resp = await h.process('SS UA 1316 Q 12APR EWRMIA PK1/11201428/ABCDEF', wa);
    expect(resp).toContain('UA 1316 Q 12APR EWR MIA PK1 ABCDEF');
    expect(wa.pnr.segments[0].departTime).toBe('1120A');
  });

  it('passive/ghost statuses survive commit (no SS→HK flip) and the RT display shows the locator', async () => {
    const h = makeHost();
    const wa = await withAvail(h);
    await h.process('SS1Q2/PK/RECLOC', wa);
    await h.process('SS1Y1/GK', wa);
    await h.process('NM1SMITH/KATY MS', wa);
    await h.process('AP NCE 555-1212-H', wa);
    await h.process('TKOK', wa);
    await h.process('RF AGT', wa);
    const er = await h.process('ER', wa);
    const loc = / - ([A-Z0-9]{6})/.exec(er)![1];
    const wa2 = h.newWorkArea();
    await h.process('JI2345HA/GS', wa2);
    const display = await h.process(`RT${loc}`, wa2);
    expect(display).toMatch(/PK1 {2}\d{4} \d{4} {3}RECLOC/);
    expect(display).toMatch(/GK1 {2}\d{4} \d{4}$/m); // no *1A/E*, no locator
    expect(display).not.toMatch(/PK1.*\*1A\/E\*/);
  });
});

describe('GGPCA carrier-access page', () => {
  it('renders the verbatim header + passive-flags block', async () => {
    const h = makeHost();
    const wa = await withAvail(h);
    const resp = await h.process('GGPCAUA', wa);
    expect(resp).toContain('PARTICIPATING CARRIER ACCESS AND FUNCTION LEVEL');
    expect(resp).toContain(' PASSIVE SEGMENT: Y      PASSIVE NOTIFY: Y         PNR CLAIM: Y');
  });
});

describe('advice-code acceptance (938974): ERK + <n>/RR', () => {
  async function built(h: GdsHost) {
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    await h.process('AN15JULJFKLAX', wa);
    await h.process('SS1Y1', wa);
    await h.process('SS1Y2', wa);
    await h.process('NM1JONES/JANE MRS', wa);
    return wa;
  }

  it('ERK flips advice codes to HK and purges inactive segments/SSRs to history', async () => {
    const h = makeHost();
    const wa = await built(h);
    wa.pnr.segments[0].status = 'TK'; // schedule change
    wa.pnr.segments[1].status = 'UN'; // inactive
    wa.pnr.ssrs.push({ code: 'VGML', carrier: '6X', status: 'UC' });
    wa.pnr.ssrs.push({ code: 'VGML', carrier: '7X', status: 'KK' });
    const resp = await h.process('ERK', wa);
    expect(wa.pnr.segments).toHaveLength(1);
    expect(wa.pnr.segments[0].status).toBe('HK');
    expect(wa.pnr.ssrs).toHaveLength(1);
    expect(wa.pnr.ssrs[0].status).toBe('HK');
    expect(resp).toContain('JONES/JANE MRS'); // PNR redisplay
    expect(wa.pnr.history.some((x) => x.text.includes('ERK PURGE'))).toBe(true);
  });

  it('ERK with nothing to accept → specific message', async () => {
    const h = makeHost();
    const wa = await built(h);
    expect(await h.process('ERK', wa)).toBe('NO ADVICE CODES TO ACCEPT');
  });

  it('<n>/RR reconfirms only confirmed segments', async () => {
    const h = makeHost();
    const wa = await built(h);
    expect(await h.process('1/RR', wa)).toBe('SEGMENT NOT CONFIRMED'); // SS
    wa.pnr.segments[0].status = 'HK';
    expect(await h.process('1/RR', wa)).toContain('RR');
    expect(wa.pnr.segments[0].status).toBe('RR');
  });
});
