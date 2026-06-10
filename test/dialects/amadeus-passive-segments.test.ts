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
