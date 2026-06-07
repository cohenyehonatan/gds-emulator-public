import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

describe('Amadeus dialect — identity + chain semantics', () => {
  it('exposes the Amadeus identity strings', () => {
    const d = new AmadeusDialect();
    expect(d.id).toBe('amadeus');
    expect(d.displayName).toBe('Amadeus');
    expect(d.screenName).toBe('AMADEUS');
    expect(d.bannerText).toContain('Amadeus');
    expect(d.bannerText).toContain('JI<duty>');
  });

  it('splits chained entries on `;` (Amadeus end-item)', () => {
    const d = new AmadeusDialect();
    expect(d.splitChain('JI2345HA/GS')).toEqual(['JI2345HA/GS']);
    expect(d.splitChain('JI2345HA/GS;JD;JO')).toEqual(['JI2345HA/GS', 'JD', 'JO']);
    // Empty fragments are dropped.
    expect(d.splitChain('JI2345HA/GS;;JD')).toEqual(['JI2345HA/GS', 'JD']);
  });

  it('flags chain-halting errors', () => {
    const d = new AmadeusDialect();
    expect(d.isErrorResponse('NOT IMPLEMENTED — amadeus dialect (v2)')).toBe(true);
    expect(d.isErrorResponse('FORMAT')).toBe(true);
    expect(d.isErrorResponse('NEEDS AGENT SIGN')).toBe(true);
    expect(d.isErrorResponse('HA SIGNED IN')).toBe(false);
  });
});

describe('Amadeus dialect — sign-in / sign-out / status', () => {
  function makeHost(): GdsHost {
    return new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC' });
  }

  it('JI<duty><initials>/<system> signs the agent in', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    const resp = await host.process('JI2345HA/GS', wa);
    expect(resp).toBe('HA SIGNED IN');
    expect(wa.agent).toBe('HA');
  });

  it('JIA<...> signs in to the specified work area', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    const resp = await host.process('JIA2345HA/GS', wa);
    expect(resp).toBe('HA SIGNED IN');
    expect(wa.agent).toBe('HA');
  });

  it('JO without prior sign-in returns NEEDS AGENT SIGN', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    expect(await host.process('JO', wa)).toBe('NEEDS AGENT SIGN');
  });

  it('JO signs out after JI (PNR cleared; agent identifier persists for next JI)', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('JO', wa)).toBe('HA SIGNED OUT');
    // Matches Galileo's sign-off semantic: wa.reset() clears the PNR
    // and session-derived state, but the agent identifier stays on the
    // WorkArea so a chained JI doesn't have to re-supply it. The state
    // machine has transitioned to SIGNED_OFF, which is what gates
    // further entries.
    expect(wa.state()).toBe('SIGNED_OFF');
  });

  it('JD displays work-area status when signed in', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('JD', wa);
    expect(resp).toContain('WORK AREA STATUS');
    expect(resp).toContain('HA');
  });

  it('verbs not yet implemented (e.g. DM MCT, FQD fare display) return the explicit honest-boundary stub', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    // DM = MCT lookup, FQD = fare display, DH = display history,
    // LOT = negotiated space — all deferred past v3.
    expect(await host.process('DMFRA', wa)).toBe('NOT IMPLEMENTED — amadeus dialect (v2)');
    expect(await host.process('FQDLAXNYC', wa)).toBe('NOT IMPLEMENTED — amadeus dialect (v2)');
  });

  it('malformed sign-in returns FORMAT', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    expect(await host.process('JIxxxx', wa)).toBe('FORMAT');
    expect(await host.process('JI/GS', wa)).toBe('FORMAT');
  });

  it('JI;JD chain runs both entries', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    // GdsHost.process splits on the dialect's chain separator. Combined
    // entry returns the LAST response (matching the existing host
    // behavior).
    const resp = await host.process('JI2345HA/GS;JD', wa);
    expect(resp).toContain('WORK AREA STATUS');
    expect(wa.agent).toBe('HA');
  });

  it('chain halts at NOT IMPLEMENTED — downstream entry does not run', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    // DMFRA returns NOT IMPLEMENTED → chain stops → JO never runs.
    await host.process('DMFRA;JO', wa);
    expect(wa.agent).toBe('HA'); // still signed in
  });
});

describe('Amadeus dialect — v2 PNR build cycle', () => {
  function makeHost(): GdsHost {
    return new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
  }

  it('AN<date><orig><dest> displays availability when route exists', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('AN15JULJFKLAX', wa);
    expect(resp).toContain('15JUL JFKLAX');
    expect(resp).toContain('B6'); // JetBlue 615 JFK-LAX in the default schedule
  });

  it('AN returns NO AVAILABILITY when the inventory has no flights', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('AN15JULXXXYYY', wa);
    expect(resp).toBe('NO AVAILABILITY');
  });

  it('SS<seats><class><line> sells from cached availability', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    const resp = await host.process('SS1Y1', wa);
    expect(resp).toContain('B6');
    expect(resp).toContain('SS1');
    expect(wa.pnr.segments).toHaveLength(1);
    expect(wa.pnr.segments[0].bookingClass).toBe('Y');
  });

  it('SS without prior AN returns NO AVAILABILITY', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('SS1Y1', wa)).toBe('NO AVAILABILITY');
  });

  it('NM1<surname>/<given> <title> stores the name', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    expect(await host.process('NM1SMITH/JOHN MR', wa)).toBe('OK');
    expect(wa.pnr.names).toHaveLength(1);
    expect(wa.pnr.names[0].surname).toBe('SMITH');
    expect(wa.pnr.names[0].passengers[0].firstName).toBe('JOHN');
    expect(wa.pnr.names[0].passengers[0].title).toBe('MR');
  });

  it('AP<phone>-A stores the agency phone', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    expect(await host.process('AP02012345678-A', wa)).toBe('OK');
    expect(wa.pnr.phones).toHaveLength(1);
    expect(wa.pnr.phones[0].number).toBe('02012345678');
  });

  it('RF / TKOK / ET cycle commits a PNR with a 6-char locator', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('AP02012345678-A', wa);
    await host.process('RFAGT', wa);
    await host.process('TKOK', wa);
    const resp = await host.process('ET', wa);
    expect(resp).toContain('END OF TRANSACTION COMPLETE');
    expect(resp).toMatch(/[A-Z0-9]{6}/);
  });

  it('ET without mandatory fields returns CHECK MANDATORY FIELDS', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    // No name / phone / RF / ticketing yet.
    expect(await host.process('ET', wa)).toBe('CHECK MANDATORY FIELDS');
  });

  it('IG discards the in-progress build', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    expect(wa.pnr.segments).toHaveLength(1);
    expect(await host.process('IG', wa)).toBe('IGNORED');
    expect(wa.pnr.segments).toHaveLength(0);
  });

  it('RT<locator> retrieves a previously-committed PNR', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('AP02012345678-A', wa);
    await host.process('RFAGT', wa);
    await host.process('TKOK', wa);
    const er = await host.process('ET', wa);
    // Locator follows " - " in the END OF TRANSACTION echo.
    const locator = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    expect(locator).toMatch(/^[A-Z0-9]{6}$/);
    // Fresh work area: retrieve the PNR.
    const wa2 = host.newWorkArea();
    await host.process('JI2345HA/GS', wa2);
    const retrieved = await host.process(`RT${locator}`, wa2);
    expect(retrieved).toContain(locator);
    expect(retrieved).toContain('SMITH/JOHN MR');
    expect(retrieved).toContain('B6');
  });
});

describe('Amadeus dialect — v3 multi-pax names + cancel + remarks + SSR/OSI + pricing', () => {
  function makeHost(): GdsHost {
    return new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
  }

  it('NM3<sur>/<g1> <t>/<g2> <t>/<g3> <t> creates 3 passengers under one surname', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('NM3LEE/SAM MR/JOAN MRS/TOM MR', wa)).toBe('OK');
    expect(wa.pnr.names).toHaveLength(1);
    expect(wa.pnr.names[0].passengers).toHaveLength(3);
    expect(wa.pnr.names[0].passengers[0].firstName).toBe('SAM');
    expect(wa.pnr.names[0].passengers[0].title).toBe('MR');
    expect(wa.pnr.names[0].passengers[1].firstName).toBe('JOAN');
    expect(wa.pnr.names[0].passengers[2].firstName).toBe('TOM');
  });

  it('Multiple NM entries with different surnames accumulate', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('NM2SCHWARZ/MANFRED MR/SABINE', wa);
    await host.process('NM1BLACK/ANDREW MR', wa);
    expect(wa.pnr.names).toHaveLength(2);
    expect(wa.pnr.names[0].surname).toBe('SCHWARZ');
    expect(wa.pnr.names[1].surname).toBe('BLACK');
  });

  it('XI cancels the whole itinerary and returns seats to inventory', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    expect(wa.pnr.segments).toHaveLength(1);
    expect(await host.process('XI', wa)).toBe('CNL');
    expect(wa.pnr.segments).toHaveLength(0);
  });

  it('XE<n> cancels a specific segment and renumbers the rest', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('SS1Y2', wa);
    expect(wa.pnr.segments).toHaveLength(2);
    await host.process('XE1', wa);
    expect(wa.pnr.segments).toHaveLength(1);
    expect(wa.pnr.segments[0].segmentNumber).toBe(1); // renumbered
  });

  it('<n>/<status> modifies segment status when status is in the allowed set', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    const resp = await host.process('1/HK', wa);
    expect(resp).toContain('HK');
    expect(wa.pnr.segments[0].status).toBe('HK');
  });

  it('<n>/<status> rejects invalid status codes', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    expect(await host.process('1/ZZ', wa)).toBe('INVALID STATUS CODE');
  });

  it('RM <text> adds a general remark', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('RM PAX HAS DOG IN CABIN', wa)).toBe('OK');
    expect(wa.pnr.remarks).toHaveLength(1);
    expect(wa.pnr.remarks[0].type).toBe('general');
    expect(wa.pnr.remarks[0].text).toBe('PAX HAS DOG IN CABIN');
  });

  it('SR <code> adds an SSR for all passengers', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('SR LSML', wa)).toBe('OK');
    expect(wa.pnr.ssrs).toHaveLength(1);
    expect(wa.pnr.ssrs[0].code).toBe('LSML');
    expect(wa.pnr.ssrs[0].carrier).toBe('YY'); // default carrier
  });

  it('SR <code>/P<n> binds the SSR to a specific passenger', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('SR VGML/P1', wa);
    expect(wa.pnr.ssrs[0].code).toBe('VGML');
    expect(wa.pnr.ssrs[0].nameRef?.item).toBe(1);
  });

  it('OS <carrier> <text> adds an OSI', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('OS QF VIP COMPANY CEO', wa)).toBe('OK');
    expect(wa.pnr.osis).toHaveLength(1);
    expect(wa.pnr.osis[0].carrier).toBe('QF');
    expect(wa.pnr.osis[0].text).toBe('VIP COMPANY CEO');
  });

  it('FXP prices the booked itinerary and stores a quote', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    const resp = await host.process('FXP', wa);
    expect(resp).toContain('FXP');
    expect(wa.pnr.priceQuotes).toHaveLength(1);
  });

  it('FXP without an itinerary returns NO ITINERARY', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('FXP', wa)).toBe('NO ITINERARY');
  });

  it('FXX after FXP displays the stored quote(s)', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('FXP', wa);
    const resp = await host.process('FXX', wa);
    expect(resp).toContain('FXP');
  });
});
