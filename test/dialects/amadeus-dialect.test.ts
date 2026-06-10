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

  it('verbs not yet implemented (e.g. LOT negotiated space, AT negotiated avail) return the explicit honest-boundary stub', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    // LOT = negotiated space, AT = negotiated availability,
    // VFFD = frequent-flyer agreements display — deferred past v4.
    expect(await host.process('LOTAIB', wa)).toBe('NOT IMPLEMENTED — amadeus dialect (v2)');
    expect(await host.process('ATAIB', wa)).toBe('NOT IMPLEMENTED — amadeus dialect (v2)');
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
    // Chunk 33: layout verbatim from Service Hub solution 897281.
    expect(resp).toContain('** AMADEUS AVAILABILITY - AN ** LAX');
    expect(resp).toContain('15JUL 0000');
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

describe('Amadeus dialect — v4 chunk 1: queue verbs (QE / RTQ)', () => {
  function makeHost(): GdsHost {
    return new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
  }

  async function buildBuildable(host: GdsHost) {
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('AP02012345678-A', wa);
    await host.process('RFAGT', wa);
    await host.process('TKOK', wa);
    return wa;
  }

  it('QE<n> places the current build on queue n + ends the transaction', async () => {
    const host = makeHost();
    const wa = await buildBuildable(host);
    const resp = await host.process('QE8', wa);
    expect(resp).toMatch(/^QUEUED 8 - [A-Z0-9]{6}$/);
    expect(wa.pnr.segments).toHaveLength(0); // ended + reset
    const locator = / - ([A-Z0-9]{6})$/.exec(resp)?.[1]!;
    expect(host.backend.queues.get('8')).toEqual([locator]);
  });

  it('QE<n>C<cat>D<date> namespaces by category + date offset', async () => {
    const host = makeHost();
    const wa = await buildBuildable(host);
    const resp = await host.process('QE8C1D3', wa);
    expect(resp).toMatch(/^QUEUED 8C1D3 - [A-Z0-9]{6}$/);
    expect(host.backend.queues.has('8C1D3')).toBe(true);
    expect(host.backend.queues.has('8')).toBe(false); // distinct from queue 8
  });

  it('QE without mandatory fields returns CHECK MANDATORY FIELDS', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    // No name/phone/RF/ticketing.
    expect(await host.process('QE8', wa)).toBe('CHECK MANDATORY FIELDS');
  });

  it('QE without an itinerary returns NO ITINERARY', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('QE8', wa)).toBe('NO ITINERARY');
  });

  it('RTQ on a PNR not on any queue returns NOT ON QUEUE', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    // Retrieve via RT after a separate-session commit.
    const wa1 = await buildBuildable(host);
    const er = await host.process('ET', wa1);
    const locator = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    await host.process(`RT${locator}`, wa);
    expect(await host.process('RTQ', wa)).toBe(`${locator} NOT ON QUEUE`);
  });

  it('RTQ on a PNR placed on a queue lists the queue(s)', async () => {
    const host = makeHost();
    const wa = await buildBuildable(host);
    const queueResp = await host.process('QE8C1', wa);
    const locator = / - ([A-Z0-9]{6})/.exec(queueResp)?.[1]!;
    // Retrieve into a new WA, then RTQ.
    const wa2 = host.newWorkArea();
    await host.process('JI2345HA/GS', wa2);
    await host.process(`RT${locator}`, wa2);
    const rtq = await host.process('RTQ', wa2);
    expect(rtq).toContain(locator);
    expect(rtq).toContain('8C1');
  });

  it('RTQ with no PNR on screen returns NO PNR ON SCREEN', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('RTQ', wa)).toBe('NO PNR ON SCREEN');
  });
});

describe('Amadeus dialect — v4 chunk 2: history display (RH)', () => {
  function makeHost(): GdsHost {
    return new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
  }

  it('RH on an empty PNR returns NO HISTORY', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('RH', wa)).toBe('NO HISTORY');
  });

  it('RH after sell + name shows the recorded mutations in order', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    const resp = await host.process('RH', wa);
    expect(resp).toContain('SELL B6615Y');
    expect(resp).toContain('NM SMITH/JOHN');
    // Order: SELL first (index 1), NM second (index 2).
    const sellIdx = resp.indexOf('SELL');
    const nmIdx = resp.indexOf('NM SMITH');
    expect(sellIdx).toBeLessThan(nmIdx);
  });

  it('RH records cancel and segment-status mutations', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('1/HK', wa);
    await host.process('XI', wa);
    const resp = await host.process('RH', wa);
    expect(resp).toContain('STAT 1/SS→HK');
    expect(resp).toContain('XI CANCEL');
  });

  it('RH after a committed-and-retrieved PNR replays the recorded history', async () => {
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
    const locator = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    // Fresh WA, retrieve, RH.
    const wa2 = host.newWorkArea();
    await host.process('JI2345HA/GS', wa2);
    await host.process(`RT${locator}`, wa2);
    const rh = await host.process('RH', wa2);
    expect(rh).toContain(locator);
    expect(rh).toContain('SELL');
    expect(rh).toContain('NM SMITH');
  });
});

describe('Amadeus dialect — v4 chunk 3: fare display (FQD)', () => {
  function makeHost(): GdsHost {
    return new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
  }

  it('FQD<orig><dest> renders a fare row per booking class', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('FQDJFKLAX', wa);
    expect(resp).toContain('FQD JFKLAX');
    expect(resp).toContain('USD');
    // Should have at least Y class (the emulated tariff has Y).
    expect(resp).toMatch(/Y\s+\d+\.\d{2} USD/);
  });

  it('FQD<orig><dest>/<date> echoes the date in the header', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('FQDJFKLAX/15JUL', wa);
    expect(resp).toContain('15JUL');
  });

  it('FQD<orig><dest>/A<carrier> echoes the carrier in the header', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('FQDJFKLAX/AAA', wa);
    expect(resp).toContain('/AAA');
  });

  it('FQD with malformed route returns FORMAT', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('FQDLAX', wa)).toBe('FORMAT'); // missing dest
  });
});

describe('Amadeus dialect — v4 chunk 4: minimum connect time (DM)', () => {
  function makeHost(): GdsHost {
    return new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
  }

  it('DM<airport> returns the emulated inventory MCT', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('DMFRA', wa);
    expect(resp).toContain('DM FRA');
    expect(resp).toContain('MCT 45 MIN');
  });

  it('DM<airport>-<airport2> shows the inter-airport pair', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('DMLGW-LHR', wa);
    expect(resp).toContain('DM LGW-LHR');
    expect(resp).toContain('MCT 45');
  });

  it('DM<airport>/<date> echoes the date qualifier', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('DMFRA/15DEC', wa);
    expect(resp).toContain('15DEC');
  });

  it('DMI with no segments returns NO CONNECTIONS TO CHECK', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('DMI', wa)).toBe('NO CONNECTIONS TO CHECK');
  });

  it('DMI on a connecting itinerary checks each connection', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKSFO', wa);
    await host.process('SS1Y1', wa);
    await host.process('SS1Y2', wa);
    const resp = await host.process('DMI', wa);
    expect(resp).toContain('DMI');
    expect(resp).toMatch(/1-2:/);
  });
});

describe('Amadeus dialect — v4 chunk 5: frequent-flyer element (FFN)', () => {
  function makeHost(): GdsHost {
    return new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
  }

  it('FFN <carrier>-<number> adds a frequent-flyer element', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('FFN BW-123456789', wa)).toBe('OK');
    expect(wa.pnr.frequentFlyers).toHaveLength(1);
    expect(wa.pnr.frequentFlyers[0].carrier).toBe('BW');
    expect(wa.pnr.frequentFlyers[0].number).toBe('123456789');
    expect(wa.pnr.frequentFlyers[0].nameRef).toBeUndefined();
  });

  it('FFN <carrier>-<number>/P<n> binds the FF to a specific passenger', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('FFN BW-123456789/P1', wa);
    expect(wa.pnr.frequentFlyers[0].nameRef?.item).toBe(1);
  });

  it('FFN with malformed argument returns FORMAT', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('FFN BW123', wa)).toBe('FORMAT'); // missing dash
    expect(await host.process('FFN BAD-', wa)).toBe('FORMAT');
  });

  it('Multiple FFN entries accumulate', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('FFN AF-12345', wa);
    await host.process('FFN BA-67890/P1', wa);
    expect(wa.pnr.frequentFlyers).toHaveLength(2);
    expect(wa.pnr.frequentFlyers[0].carrier).toBe('AF');
    expect(wa.pnr.frequentFlyers[1].carrier).toBe('BA');
  });
});

describe('Amadeus dialect — v4 chunk 6: partial PNR display family (RTA/RTI/RTN/RTJ/RTK/RTF/RTG/RTR)', () => {
  function makeHost(): GdsHost {
    return new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
  }

  async function buildPnr(host: GdsHost) {
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('AP02012345678-A', wa);
    await host.process('RFAGT', wa);
    await host.process('TKOK', wa);
    await host.process('SR VGML/P1', wa);
    await host.process('OS QF VIP', wa);
    await host.process('RM HAS LATE CHECKIN', wa);
    return wa;
  }

  it('RTA shows air segments only', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    const resp = await host.process('RTA', wa);
    expect(resp).toContain('B6');
    expect(resp).not.toContain('SMITH');
    expect(resp).not.toContain('TKOK');
  });

  it('RTI shows itinerary (same as RTA in emulated since no hotel/car)', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    const resp = await host.process('RTI', wa);
    expect(resp).toContain('B6');
  });

  it('RTN shows names only', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    const resp = await host.process('RTN', wa);
    expect(resp).toContain('SMITH/JOHN MR');
    expect(resp).not.toContain('B6');
  });

  it('RTJ shows phone elements only', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    const resp = await host.process('RTJ', wa);
    expect(resp).toContain('02012345678');
  });

  it('RTK shows ticketing element', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    const resp = await host.process('RTK', wa);
    expect(resp).toContain('TKOK');
  });

  it('RTG shows SSR + OSI general facts', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    const resp = await host.process('RTG', wa);
    expect(resp).toContain('VGML');
    expect(resp).toContain('QF');
    expect(resp).toContain('VIP');
  });

  it('RTR shows remarks', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    const resp = await host.process('RTR', wa);
    expect(resp).toContain('HAS LATE CHECKIN');
  });

  it('RTF shows fare quotes after pricing', async () => {
    const host = makeHost();
    const wa = await buildPnr(host);
    await host.process('FXP', wa);
    const resp = await host.process('RTF', wa);
    expect(resp).toContain('FXP');
  });

  it('Each partial view returns its empty-state message when no data', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('RTA', wa)).toBe('NO ITINERARY');
    expect(await host.process('RTN', wa)).toBe('NO NAMES');
    expect(await host.process('RTJ', wa)).toBe('NO PHONE');
    expect(await host.process('RTK', wa)).toBe('NO TICKETING');
    expect(await host.process('RTF', wa)).toBe('NO FARE QUOTES');
    expect(await host.process('RTG', wa)).toBe('NO GENERAL FACTS');
    expect(await host.process('RTR', wa)).toBe('NO REMARKS');
  });
});

describe('Amadeus dialect — v4 chunk 7: queue work (QSTART/QN/QF/QFR/QXI)', () => {
  function makeHost(): GdsHost {
    return new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
  }

  async function buildAndQueue(host: GdsHost, queueNum: string): Promise<string> {
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('AP02012345678-A', wa);
    await host.process('RFAGT', wa);
    await host.process('TKOK', wa);
    const resp = await host.process(`QE${queueNum}`, wa);
    const locator = / - ([A-Z0-9]{6})$/.exec(resp)?.[1]!;
    return locator;
  }

  it('QSTART<n> on an empty queue returns QUEUE n EMPTY', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('QSTART99', wa)).toBe('QUEUE 99 EMPTY');
  });

  it('QSTART<n> on a populated queue loads the first PNR + cursor=0', async () => {
    const host = makeHost();
    await buildAndQueue(host, '10');
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('QSTART10', wa);
    expect(resp).toContain('QUEUE 10 - 1 OF 1');
    expect(resp).toContain('SMITH/JOHN MR');
    expect(wa.currentQueue).toBe('10');
    expect(wa.queueCursor).toBe(0);
  });

  it('QN advances the cursor across queued PNRs', async () => {
    const host = makeHost();
    const loc1 = await buildAndQueue(host, '11');
    const loc2 = await buildAndQueue(host, '11');
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('QSTART11', wa);
    expect(wa.pnr.locator).toBe(loc1);
    const resp = await host.process('QN', wa);
    expect(resp).toContain('2 OF 2');
    expect(wa.pnr.locator).toBe(loc2);
  });

  it('QN past the end clears queue mode and returns END OF QUEUE', async () => {
    const host = makeHost();
    await buildAndQueue(host, '12');
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('QSTART12', wa);
    expect(await host.process('QN', wa)).toBe('END OF QUEUE 12');
    expect(wa.currentQueue).toBeUndefined();
  });

  it('QF removes the current PNR from the queue + advances', async () => {
    const host = makeHost();
    const loc1 = await buildAndQueue(host, '13');
    const loc2 = await buildAndQueue(host, '13');
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('QSTART13', wa);
    // QF removes loc1 from queue 13.
    await host.process('QF', wa);
    expect(host.backend.queues.get('13')).toEqual([loc2]);
  });

  it('QXI exits queue mode without removing the current PNR', async () => {
    const host = makeHost();
    const loc1 = await buildAndQueue(host, '14');
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('QSTART14', wa);
    expect(await host.process('QXI', wa)).toBe('QUEUE 14 EXITED');
    expect(wa.currentQueue).toBeUndefined();
    // PNR still on the queue.
    expect(host.backend.queues.get('14')).toEqual([loc1]);
  });

  it('QN / QF / QFR / QXI outside queue mode return NOT IN QUEUE MODE', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    for (const e of ['QN', 'QF', 'QFR', 'QXI']) {
      expect(await host.process(e, wa)).toBe('NOT IN QUEUE MODE');
    }
  });
});

describe('Amadeus dialect — v4 chunk 8: IR (ignore and redisplay)', () => {
  function makeHost(): GdsHost {
    return new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
  }

  it('IR on an empty work area returns IGNORED (same as IG)', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('IR', wa)).toBe('IGNORED');
  });

  it('IR during a build (no committed locator) returns IGNORED + resets', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    expect(wa.pnr.segments).toHaveLength(1);
    expect(await host.process('IR', wa)).toBe('IGNORED');
    expect(wa.pnr.segments).toHaveLength(0);
  });

  it('AM <text> adds a mailing address (standard)', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('AM SMITH/123 MAIN ST,LOS ANGELES', wa)).toBe('OK');
    expect(wa.pnr.addresses).toHaveLength(1);
    expect(wa.pnr.addresses[0].kind).toBe('mailing');
    expect(wa.pnr.addresses[0].subtype).toBe('standard');
    expect(wa.pnr.addresses[0].text).toBe('SMITH/123 MAIN ST,LOS ANGELES');
  });

  it('AM/H adds a home mailing address', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('AM/H JONES/456 OAK AVE,DENVER', wa)).toBe('OK');
    expect(wa.pnr.addresses[0].subtype).toBe('home');
  });

  it('AM/D adds a delivery mailing address', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AM/D ANYTOWN', wa);
    expect(wa.pnr.addresses[0].subtype).toBe('delivery');
  });

  it('AB <text> adds a billing address', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('AB CORP HQ,NEW YORK', wa)).toBe('OK');
    expect(wa.pnr.addresses[0].kind).toBe('billing');
  });

  it('AM <text>/P<n> binds the address to a passenger', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AM SMITH/123 MAIN ST,LOS ANGELES/P2', wa);
    expect(wa.pnr.addresses[0].nameRef?.item).toBe(2);
  });

  it('AM with empty body returns FORMAT', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('AM /P1', wa)).toBe('FORMAT');
  });

  it('RTJ shows phones AND addresses', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AP02012345678-A', wa);
    await host.process('AM HOME,LA', wa);
    await host.process('AB OFFICE,NY', wa);
    const resp = await host.process('RTJ', wa);
    expect(resp).toContain('02012345678');
    expect(resp).toContain('AM-1 HOME');
    expect(resp).toContain('AB-1 OFFICE');
  });

  it('ST/<seat>/P<n>/S<n> stores a specific-seat request', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('ST/12C/P2/S5', wa)).toBe('OK');
    expect(wa.pnr.seatRequests).toHaveLength(1);
    expect(wa.pnr.seatRequests[0].code).toBe('12C');
    expect(wa.pnr.seatRequests[0].nameRef?.item).toBe(2);
    expect(wa.pnr.seatRequests[0].segment).toBe(5);
  });

  it('ST/<preference> stores a preference request for all pax', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('ST/NSSA', wa);
    expect(wa.pnr.seatRequests[0].code).toBe('NSSA');
    expect(wa.pnr.seatRequests[0].nameRef).toBeUndefined();
    expect(wa.pnr.seatRequests[0].segment).toBeUndefined();
  });

  it('ST/WB/P3 binds a preference to a specific passenger', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('ST/WB/P3', wa);
    expect(wa.pnr.seatRequests[0].code).toBe('WB');
    expect(wa.pnr.seatRequests[0].nameRef?.item).toBe(3);
  });

  it('SX cancels all seat requests', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('ST/12C/P1/S1', wa);
    await host.process('ST/14A/P2/S1', wa);
    expect(wa.pnr.seatRequests).toHaveLength(2);
    expect(await host.process('SX', wa)).toBe('CNL');
    expect(wa.pnr.seatRequests).toHaveLength(0);
  });

  it('SX/S<n> cancels only seats on the specified segment', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('ST/12C/P1/S1', wa);
    await host.process('ST/15A/P1/S2', wa);
    await host.process('SX/S1', wa);
    expect(wa.pnr.seatRequests).toHaveLength(1);
    expect(wa.pnr.seatRequests[0].segment).toBe(2);
  });

  it('ST with malformed tokens returns FORMAT', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('ST/12C/XYZ', wa)).toBe('FORMAT'); // not /P or /S
  });

  it('LP/<flight>/<date> lists PNRs matching a flight + date', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    // Build two PNRs on B6 615 / 15JUL.
    for (const surname of ['SMITH', 'JONES']) {
      const w = host.newWorkArea();
      await host.process('JI2345HA/GS', w);
      await host.process('AN15JULJFKLAX', w);
      await host.process('SS1Y1', w);
      await host.process(`NM1${surname}/JOHN MR`, w);
      await host.process('AP02012345678-A', w);
      await host.process('RFAGT', w);
      await host.process('TKOK', w);
      await host.process('ET', w);
    }
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('LP/B6615/15JUL', wa);
    expect(resp).toContain('LP B6615 15JUL - 2 PNR(S)');
    expect(resp).toContain('SMITH');
    expect(resp).toContain('JONES');
  });

  it('LP on a flight with no PNRs returns NO PNRS FOUND', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('LP/UA9999/01JAN', wa)).toBe('NO PNRS FOUND');
  });

  it('LP with malformed flight argument returns NOT IMPLEMENTED stub', async () => {
    // The parser returns the honest-boundary stub for malformed LP rather
    // than FORMAT — LP has many variants we don't model (options, queue
    // lists, etc.) and a falling-through entry could be one of those.
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('LP/IE/2X026/12SEP', wa)).toBe(
      'NOT IMPLEMENTED — amadeus dialect (v2)'
    );
  });

  it('RT/<surname> retrieves a single matching PNR by name', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa1 = host.newWorkArea();
    await host.process('JI2345HA/GS', wa1);
    await host.process('AN15JULJFKLAX', wa1);
    await host.process('SS1Y1', wa1);
    await host.process('NM1HANUSSEN/JOHN MR', wa1);
    await host.process('AP02012345678-A', wa1);
    await host.process('RFAGT', wa1);
    await host.process('TKOK', wa1);
    const er = await host.process('ET', wa1);
    const locator = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('RT/HANUSSEN', wa);
    expect(resp).toContain(locator);
    expect(resp).toContain('HANUSSEN');
  });

  it('RT/<surname> with multiple matches returns a numbered list', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    for (const given of ['JOHN', 'JANE']) {
      const w = host.newWorkArea();
      await host.process('JI2345HA/GS', w);
      await host.process('AN15JULJFKLAX', w);
      await host.process('SS1Y1', w);
      await host.process(`NM1MURPHY/${given} MR`, w);
      await host.process('AP02012345678-A', w);
      await host.process('RFAGT', w);
      await host.process('TKOK', w);
      await host.process('ET', w);
    }
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('RT/MURPHY', wa);
    expect(resp).toContain('2 PNRS FOUND');
    expect(resp).toContain('MURPHY/JOHN');
    expect(resp).toContain('MURPHY/JANE');
  });

  it('RT/<surname>/<initial> filters multi-match by given-initial', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    for (const given of ['JOHN', 'JANE']) {
      const w = host.newWorkArea();
      await host.process('JI2345HA/GS', w);
      await host.process('AN15JULJFKLAX', w);
      await host.process('SS1Y1', w);
      await host.process(`NM1ANDERSON/${given} MR`, w);
      await host.process('AP02012345678-A', w);
      await host.process('RFAGT', w);
      await host.process('TKOK', w);
      await host.process('ET', w);
    }
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('RT/ANDERSON/J', wa);
    // Both start with J — still multi-match.
    expect(resp).toContain('2 PNRS FOUND');
  });

  it('RT/<surname> with no match returns PNR NOT FOUND', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('RT/NOSUCHNAME', wa)).toBe('PNR NOT FOUND');
  });

  it('RRN copies the current PNR — drops locator/quotes/tickets, keeps names/segments', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    // Build + commit.
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('AP02012345678-A', wa);
    await host.process('RFAGT', wa);
    await host.process('TKOK', wa);
    await host.process('FXP', wa);
    const er = await host.process('ET', wa);
    const originalLoc = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    // Retrieve + RRN.
    const wa2 = host.newWorkArea();
    await host.process('JI2345HA/GS', wa2);
    await host.process(`RT${originalLoc}`, wa2);
    const resp = await host.process('RRN', wa2);
    expect(resp).toBe(`COPIED FROM ${originalLoc}`);
    expect(wa2.pnr.locator).toBeUndefined();
    expect(wa2.pnr.priceQuotes).toHaveLength(0);
    expect(wa2.pnr.names).toHaveLength(1);
    expect(wa2.pnr.segments).toHaveLength(1);
    expect(wa2.pnr.names[0].surname).toBe('SMITH');
  });

  it('RRN with no PNR on screen returns NO PNR ON SCREEN', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('RRN', wa)).toBe('NO PNR ON SCREEN');
  });

  it('RRN + ET commits a NEW PNR with a different locator', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('AP02012345678-A', wa);
    await host.process('RFAGT', wa);
    await host.process('TKOK', wa);
    const er1 = await host.process('ET', wa);
    const loc1 = / - ([A-Z0-9]{6})/.exec(er1)?.[1]!;
    const wa2 = host.newWorkArea();
    await host.process('JI2345HA/GS', wa2);
    await host.process(`RT${loc1}`, wa2);
    await host.process('RRN', wa2);
    const er2 = await host.process('ET', wa2);
    const loc2 = / - ([A-Z0-9]{6})/.exec(er2)?.[1]!;
    expect(loc2).not.toBe(loc1);
    // Both locators in the store now.
    expect(host.backend.pnrs.has(loc1)).toBe(true);
    expect(host.backend.pnrs.has(loc2)).toBe(true);
  });

  it('NU<n>/<full-NM-body> replaces surname + given + title', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    expect(await host.process('NU1/1JONES/JANE MRS', wa)).toBe('OK');
    expect(wa.pnr.names[0].surname).toBe('JONES');
    expect(wa.pnr.names[0].passengers[0].firstName).toBe('JANE');
    expect(wa.pnr.names[0].passengers[0].title).toBe('MRS');
  });

  it('NU<n>/<given-only> replaces just the given name', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    expect(await host.process('NU1/JAMES', wa)).toBe('OK');
    expect(wa.pnr.names[0].surname).toBe('SMITH'); // unchanged
    expect(wa.pnr.names[0].passengers[0].firstName).toBe('JAMES');
  });

  it('NU<n>/<given-only> preserves the original title when no new title given', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('NU1/JAMES', wa);
    expect(wa.pnr.names[0].passengers[0].title).toBe('MR');
  });

  it('NU<n>/<given title> sets a new title', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('NU1/JAMES DR', wa);
    expect(wa.pnr.names[0].passengers[0].firstName).toBe('JAMES');
    expect(wa.pnr.names[0].passengers[0].title).toBe('DR');
  });

  it('NU on a non-existent element returns NAME NOT IN PNR', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('NU1/JAMES', wa)).toBe('NAME NOT IN PNR');
  });

  it('NU records the change in history', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('NU1/JAMES', wa);
    const rh = await host.process('RH', wa);
    expect(rh).toContain('NU1 JOHN→JAMES');
  });

  it('8/<date> modifies the time-limit element (TKTL<date>)', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('TKOK', wa);
    expect(wa.pnr.ticketing).toBe('TKOK');
    expect(await host.process('8/10JUL', wa)).toBe('OK');
    expect(wa.pnr.ticketing).toBe('TKTL10JUL');
  });

  it('8/<date> records the change in history', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('TKOK', wa);
    await host.process('8/10JUL', wa);
    const rh = await host.process('RH', wa);
    expect(rh).toContain('TK TKOK→TKTL10JUL');
  });

  it('8/<date> with no prior ticketing still sets one', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('8/15AUG', wa)).toBe('OK');
    expect(wa.pnr.ticketing).toBe('TKTL15AUG');
  });

  it('8/HK still routes to segment-status modify (no syntactic overlap)', async () => {
    // Verify the disambiguation: when the value after 8/ is a 2-letter
    // status (not a date), it falls through to the segment-status
    // modifier — which then complains about segment 8 not being in
    // the itinerary.
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('8/HK', wa)).toBe('SEGMENT NOT IN ITINERARY');
  });

  it('SP <n> splits name n off into an associate PNR (parent stashed)', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    // Build a 3-name PNR + commit.
    const w = host.newWorkArea();
    await host.process('JI2345HA/GS', w);
    await host.process('AN15JULJFKLAX', w);
    await host.process('SS1Y1', w);
    await host.process('NM1SMITH/JOHN MR', w);
    await host.process('NM1JONES/JANE MRS', w);
    await host.process('NM1BLACK/ANDREW MR', w);
    await host.process('AP02012345678-A', w);
    await host.process('RFAGT', w);
    await host.process('TKOK', w);
    const er = await host.process('ET', w);
    const parentLoc = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    // Retrieve + split name 2 off.
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process(`RT${parentLoc}`, wa);
    expect(await host.process('SP 2', wa)).toBe('SPLIT - ASSOCIATE PNR READY');
    // wa.pnr is now the associate: only JONES.
    expect(wa.pnr.names).toHaveLength(1);
    expect(wa.pnr.names[0].surname).toBe('JONES');
    expect(wa.pnr.locator).toBeUndefined();
    // Parent stashed.
    expect(wa.dividedOriginal).toBeDefined();
    expect(wa.dividedOriginal?.names).toHaveLength(2);
  });

  it('EF commits the associate + restores + re-commits the parent', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const w = host.newWorkArea();
    await host.process('JI2345HA/GS', w);
    await host.process('AN15JULJFKLAX', w);
    await host.process('SS1Y1', w);
    await host.process('NM1SMITH/JOHN MR', w);
    await host.process('NM1JONES/JANE MRS', w);
    await host.process('AP02012345678-A', w);
    await host.process('RFAGT', w);
    await host.process('TKOK', w);
    const er = await host.process('ET', w);
    const parentLoc = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process(`RT${parentLoc}`, wa);
    await host.process('SP 2', wa);
    const efResp = await host.process('EF', wa);
    const associateLoc = /ASSOCIATE ([A-Z0-9]{6})/.exec(efResp)?.[1]!;
    expect(associateLoc).toBeDefined();
    expect(associateLoc).not.toBe(parentLoc);
    // Both PNRs persist.
    expect(host.backend.pnrs.has(parentLoc)).toBe(true);
    expect(host.backend.pnrs.has(associateLoc)).toBe(true);
    // Parent now has only JOHN (JONES split off).
    expect(host.backend.pnrs.get(parentLoc)!.names).toHaveLength(1);
    expect(host.backend.pnrs.get(parentLoc)!.names[0].surname).toBe('SMITH');
    // Associate has only JONES.
    expect(host.backend.pnrs.get(associateLoc)!.names).toHaveLength(1);
    expect(host.backend.pnrs.get(associateLoc)!.names[0].surname).toBe('JONES');
  });

  it('SP <n>,<m>-<o> splits multiple names', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const w = host.newWorkArea();
    await host.process('JI2345HA/GS', w);
    await host.process('AN15JULJFKLAX', w);
    await host.process('SS1Y1', w);
    for (const sur of ['A', 'B', 'C', 'D', 'E']) {
      await host.process(`NM1${sur}NAME/JOHN MR`, w);
    }
    await host.process('AP02012345678-A', w);
    await host.process('RFAGT', w);
    await host.process('TKOK', w);
    const er = await host.process('ET', w);
    const parentLoc = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process(`RT${parentLoc}`, wa);
    await host.process('SP 2,4-5', wa);
    // Associate gets names 2, 4, 5 = B, D, E.
    expect(wa.pnr.names.map((n) => n.surname)).toEqual(['BNAME', 'DNAME', 'ENAME']);
    // Parent retains 1, 3 = A, C.
    expect(wa.dividedOriginal!.names.map((n) => n.surname)).toEqual(['ANAME', 'CNAME']);
  });

  it('SP with no PNR on screen returns NO PNR ON SCREEN', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('SP 1', wa)).toBe('NO PNR ON SCREEN');
  });

  it('SP <n> with n out of range returns NAME NOT IN PNR', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const w = host.newWorkArea();
    await host.process('JI2345HA/GS', w);
    await host.process('AN15JULJFKLAX', w);
    await host.process('SS1Y1', w);
    await host.process('NM1SMITH/JOHN MR', w);
    await host.process('AP02012345678-A', w);
    await host.process('RFAGT', w);
    await host.process('TKOK', w);
    const er = await host.process('ET', w);
    const loc = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process(`RT${loc}`, wa);
    expect(await host.process('SP 99', wa)).toBe('NAME NOT IN PNR');
  });

  it('EF without a prior SP returns NOTHING TO FILE', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('EF', wa)).toBe('NOTHING TO FILE');
  });

  it('VFFD lists all agreement carriers + programs', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('VFFD', wa);
    expect(resp).toContain('AGREEMENTS ACTIVE');
    expect(resp).toContain('UA  MILEAGEPLUS');
    expect(resp).toContain('AA  AADVANTAGE');
    expect(resp).toContain('LH  MILES AND MORE');
  });

  it('VFFD <carrier> returns the program for a single carrier', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('VFFD UA', wa)).toContain('MILEAGEPLUS');
    expect(await host.process('VFFD QF', wa)).toContain('QANTAS FREQUENT FLYER');
  });

  it('VFFD <unknown-carrier> returns NO FF AGREEMENT', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('VFFD ZZ', wa)).toBe('ZZ NO FF AGREEMENT');
  });

  it('RRN/DP<n> copies and pushes all segment dates forward n days', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const w = host.newWorkArea();
    await host.process('JI2345HA/GS', w);
    await host.process('AN15JULJFKLAX', w);
    await host.process('SS1Y1', w);
    await host.process('NM1SMITH/JOHN MR', w);
    await host.process('AP02012345678-A', w);
    await host.process('RFAGT', w);
    await host.process('TKOK', w);
    const er = await host.process('ET', w);
    const loc = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process(`RT${loc}`, wa);
    const resp = await host.process('RRN/DP7', wa);
    expect(resp).toContain('DP7');
    expect(wa.pnr.segments[0].date).toBe('22JUL');
  });

  it('RRN/DM<n> copies and pushes all segment dates back n days', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const w = host.newWorkArea();
    await host.process('JI2345HA/GS', w);
    await host.process('AN15JULJFKLAX', w);
    await host.process('SS1Y1', w);
    await host.process('NM1SMITH/JOHN MR', w);
    await host.process('AP02012345678-A', w);
    await host.process('RFAGT', w);
    await host.process('TKOK', w);
    const er = await host.process('ET', w);
    const loc = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process(`RT${loc}`, wa);
    await host.process('RRN/DM3', wa);
    expect(wa.pnr.segments[0].date).toBe('12JUL');
  });

  it('RRN/C<class> copies and changes all segments to that class', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const w = host.newWorkArea();
    await host.process('JI2345HA/GS', w);
    await host.process('AN15JULJFKLAX', w);
    await host.process('SS1Y1', w);
    await host.process('NM1SMITH/JOHN MR', w);
    await host.process('AP02012345678-A', w);
    await host.process('RFAGT', w);
    await host.process('TKOK', w);
    const er = await host.process('ET', w);
    const loc = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process(`RT${loc}`, wa);
    await host.process('RRN/CJ', wa);
    expect(wa.pnr.segments[0].bookingClass).toBe('J');
  });

  it('RRN/S<segs> copies only the specified segments', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const w = host.newWorkArea();
    await host.process('JI2345HA/GS', w);
    await host.process('AN15JULJFKLAX', w);
    await host.process('SS1Y1', w);
    await host.process('SS1Y2', w);
    await host.process('SS1Y3', w);
    await host.process('NM1SMITH/JOHN MR', w);
    await host.process('AP02012345678-A', w);
    await host.process('RFAGT', w);
    await host.process('TKOK', w);
    const er = await host.process('ET', w);
    const loc = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process(`RT${loc}`, wa);
    await host.process('RRN/S1,3', wa);
    // Only segments 1 and 3 kept, renumbered to 1 and 2.
    expect(wa.pnr.segments).toHaveLength(2);
    expect(wa.pnr.segments[0].segmentNumber).toBe(1);
    expect(wa.pnr.segments[1].segmentNumber).toBe(2);
  });

  it('RRN/ with an unknown qualifier returns FORMAT', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const w = host.newWorkArea();
    await host.process('JI2345HA/GS', w);
    await host.process('AN15JULJFKLAX', w);
    await host.process('SS1Y1', w);
    await host.process('NM1SMITH/JOHN MR', w);
    await host.process('AP02012345678-A', w);
    await host.process('RFAGT', w);
    await host.process('TKOK', w);
    const er = await host.process('ET', w);
    const loc = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process(`RT${loc}`, wa);
    expect(await host.process('RRN/XYZ', wa)).toBe('FORMAT');
  });

  it('SM <carrier><flight>/<class>/<date><route> direct query renders without an itinerary', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    // No AN, no SS — direct query against the schedule.
    const resp = await host.process('SM AA100/Y/15JULJFKLAX', wa);
    expect(resp).toContain('SM 1 — AA100');
    expect(resp).toContain('15JUL');
    expect(resp).toContain('JFK-LAX');
    expect(resp).toContain('738'); // AA100 equipment
    expect(resp).toContain('LEGEND');
  });

  it('SM <carrier><flight>/<class>/<route> without date uses placeholder', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('SM B6615/Y/JFKLAX', wa);
    expect(resp).toContain('SM 1 — B6615');
    expect(resp).toContain('01JAN'); // deterministic placeholder
  });

  it('SM <carrier><flight>//<route> works with empty class slot', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('SM B6615//15JULJFKLAX', wa);
    expect(resp).toContain('SM 1 — B6615');
  });

  it('SM <carrier><flight>/Y/<route>/H direct query honors orientation suffix', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const vert = await host.process('SM B6615/Y/15JULJFKLAX', wa);
    const horiz = await host.process('SM B6615/Y/15JULJFKLAX/H', wa);
    expect(vert).not.toBe(horiz);
    expect(horiz).toContain('SM 1 — B6615');
  });

  it('SM <unknown-carrier><flight>/<class>/<route> returns NO SCHEDULE FOUND', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('SM XX999/Y/15JULJFKLAX', wa)).toBe('NO SCHEDULE FOUND');
  });

  it('SM/<line> renders the seat map for a cached-availability line', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    const resp = await host.process('SM/1', wa);
    expect(resp).toContain('SM 1');
    expect(resp).toContain('15JUL');
    expect(resp).toContain('JFK-LAX');
    expect(resp).toContain('LEGEND');
  });

  it('SM/<line>/<class> honors a class filter on the cached line', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    const resp = await host.process('SM/1/Y', wa);
    expect(resp).toContain('SM 1');
  });

  it('SM/<line> with no prior availability returns NO AVAILABILITY', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('SM/1', wa)).toBe('NO AVAILABILITY');
  });

  it('SM/<line> with a line out of range returns LINE NOT IN AVAILABILITY', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    expect(await host.process('SM/99', wa)).toBe('LINE NOT IN AVAILABILITY');
  });

  it('SM/<line>/V respects orientation suffix on the avail-line form', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    const vert = await host.process('SM/1/V', wa);
    const horiz = await host.process('SM/1/H', wa);
    expect(vert).not.toBe(horiz);
  });

  it('SM <n> shows the legend by default', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    const resp = await host.process('SM 1', wa);
    expect(resp).toContain('LEGEND');
  });

  it('SM <n>/NL hides the legend', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    const resp = await host.process('SM 1/NL', wa);
    expect(resp).not.toContain('LEGEND');
  });

  it('SM <n>/L explicitly shows the legend', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    const resp = await host.process('SM 1/L', wa);
    expect(resp).toContain('LEGEND');
  });

  it('SM <n>/V/NL combines orientation + no-legend suffixes', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    const resp = await host.process('SM 1/V/NL', wa);
    expect(resp).not.toContain('LEGEND');
    expect(resp).toContain('SM 1 — B6615');
  });

  it('SM <flight>/<class>/<route>/NL direct form hides legend', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('SM B6615/Y/15JULJFKLAX/NL', wa);
    expect(resp).not.toContain('LEGEND');
    expect(resp).toContain('SM 1 — B6615');
  });

  it('SM/<line>/NL avail-line form hides legend', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    const resp = await host.process('SM/1/NL', wa);
    expect(resp).not.toContain('LEGEND');
  });

  it('initial SM displays a paginated view with ROWS X-Y OF Z footer', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULDFWLHR', wa);
    await host.process('SS1Y1', wa); // BA192 777 — 39 total rows
    const resp = await host.process('SM 1', wa);
    expect(resp).toMatch(/ROWS 1-\d+ OF \d+/);
    expect(wa.lastSeatMap?.scrollRow).toBe(0);
  });

  it('MD pages down by SM_PAGE_SIZE (clamped at maxOffset)', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULDFWLHR', wa);
    await host.process('SS1Y1', wa);
    await host.process('SM 1', wa);
    const resp = await host.process('MD', wa);
    expect(resp).toMatch(/ROWS \d+-\d+ OF \d+/);
    // 777 has 39 rows total; max offset = 39 - 20 = 19. MD from 0
    // advances by 20 but clamps to 19.
    expect(wa.lastSeatMap?.scrollRow).toBeGreaterThan(0);
  });

  it('repeated MD clamps at bottom (no overflow)', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULDFWLHR', wa);
    await host.process('SS1Y1', wa);
    await host.process('SM 1', wa);
    await host.process('MD', wa);
    const first = wa.lastSeatMap?.scrollRow;
    await host.process('MD', wa);
    await host.process('MD', wa);
    const after = wa.lastSeatMap?.scrollRow;
    // Already at bottom — additional MD doesn't advance further.
    expect(after).toBe(first);
  });

  it('MU pages up by SM_PAGE_SIZE; clamps at top', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULDFWLHR', wa);
    await host.process('SS1Y1', wa);
    await host.process('SM 1', wa);
    await host.process('MD', wa);
    const afterDown = wa.lastSeatMap?.scrollRow ?? 0;
    expect(afterDown).toBeGreaterThan(0);
    await host.process('MU', wa);
    expect(wa.lastSeatMap?.scrollRow).toBe(0);
    // Another MU at top — clamps.
    await host.process('MU', wa);
    expect(wa.lastSeatMap?.scrollRow).toBe(0);
  });

  it('MB jumps to bottom; MT jumps to top', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULDFWLHR', wa);
    await host.process('SS1Y1', wa);
    await host.process('SM 1', wa);
    await host.process('MB', wa);
    const bottomOffset = wa.lastSeatMap?.scrollRow ?? 0;
    expect(bottomOffset).toBeGreaterThan(0);
    await host.process('MT', wa);
    expect(wa.lastSeatMap?.scrollRow).toBe(0);
  });

  it('MD/MU/MB/MT with no cached seat map return NO SEAT MAP DISPLAYED', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    for (const e of ['MD', 'MU', 'MB', 'MT']) {
      expect(await host.process(e, wa)).toBe('NO SEAT MAP DISPLAYED');
    }
  });

  it('scroll works on direct-form SM (cachedSegment used to re-render)', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    // BA192 is the 777 in SCHEDULE — direct query, no PNR needed.
    await host.process('SM BA192/F/15JULDFWLHR', wa);
    expect(wa.lastSeatMap).toBeDefined();
    expect(wa.lastSeatMap?.cachedSegment).toBeDefined();
    const resp = await host.process('MD', wa);
    expect(resp).toContain('ROWS');
    expect(wa.lastSeatMap?.scrollRow).toBeGreaterThan(0);
  });

  it('starting a fresh SM resets scroll position to 0', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULDFWLHR', wa);
    await host.process('SS1Y1', wa);
    await host.process('SM 1', wa);
    await host.process('MB', wa); // jump to bottom
    expect(wa.lastSeatMap?.scrollRow).toBeGreaterThan(0);
    await host.process('SM 1', wa); // fresh SM — should reset
    expect(wa.lastSeatMap?.scrollRow).toBe(0);
  });

  it('SM with no segments returns NO ITINERARY', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('SM 1', wa)).toBe('NO ITINERARY');
  });

  it('SM <n> for n outside the itinerary returns SEGMENT NOT IN ITINERARY', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    expect(await host.process('SM 5', wa)).toBe('SEGMENT NOT IN ITINERARY');
  });

  it('SM <n> on a happy path renders the header + cabin code + status legend', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    const resp = await host.process('SM 1', wa);
    expect(resp).toContain('SM 1 — B6615');
    expect(resp).toContain('15JUL');
    expect(resp).toContain('JFK-LAX');
    expect(resp).toContain('32A'); // B6615 equipment
    expect(resp).toContain('LEGEND');
    expect(resp).toMatch(/Y/); // ECONOMY cabin code
  });

  it('SM caches the displayed map on wa.lastSeatMap', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('SM 1', wa);
    expect(wa.lastSeatMap?.segment).toBe(1);
    expect(wa.lastSeatMap?.map.equipment).toBe('32A');
  });

  it('SM is deterministic across two calls (same input → same output)', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    const a = await host.process('SM 1', wa);
    const b = await host.process('SM 1', wa);
    expect(a).toBe(b);
  });

  it('SM /H transposes — same data, different layout', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    const vert = await host.process('SM 1', wa);
    const horiz = await host.process('SM 1/H', wa);
    expect(vert).not.toBe(horiz);
    expect(horiz).toContain('SM 1 — B6615');
  });

  it('SM is cleared by reset() (IG)', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('SM 1', wa);
    expect(wa.lastSeatMap).toBeDefined();
    await host.process('IG', wa);
    expect(wa.lastSeatMap).toBeUndefined();
  });

  it('ST/<reserved-seat>/S<n> rejects with SEAT NOT AVAILABLE (chunk 8)', async () => {
    // Find a seat the synthesizer marks Reserved for B6615 on 15JUL.
    const { Inventory } = await import('../../src/store/inventory.js');
    const { synthesizeAvailability } = await import('../../src/models/seat-map.js');
    const inv = new Inventory();
    const map = inv.seatMapFor('B6', '615')!;
    const buckets = synthesizeAvailability(map, 'PENDING', '15JUL');
    const reserved = buckets.find((b) => b.seatAvailabilityStatus === 'Reserved');
    const reservedSeat = reserved?.value[0];
    expect(reservedSeat, 'synthesizer should produce at least one Reserved seat').toBeDefined();
    // Now run the host with that seat.
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    expect(await host.process(`ST/${reservedSeat}/S1`, wa)).toBe('SEAT NOT AVAILABLE');
  });

  it('ST/<available-seat>/S<n> accepts a seat the synthesizer marks Available (chunk 8)', async () => {
    const { Inventory } = await import('../../src/store/inventory.js');
    const { synthesizeAvailability } = await import('../../src/models/seat-map.js');
    const inv = new Inventory();
    const map = inv.seatMapFor('B6', '615')!;
    const buckets = synthesizeAvailability(map, 'PENDING', '15JUL');
    const available = buckets.find((b) => b.seatAvailabilityStatus === 'Available');
    const availableSeat = available?.value[0];
    expect(availableSeat, 'synthesizer should produce at least one Available seat').toBeDefined();
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    expect(await host.process(`ST/${availableSeat}/S1`, wa)).toBe('OK');
  });

  it('ST/<blocked-seat>/S<n> rejects with SEAT NOT AVAILABLE', async () => {
    const { Inventory } = await import('../../src/store/inventory.js');
    const { synthesizeAvailability } = await import('../../src/models/seat-map.js');
    const inv = new Inventory();
    const map = inv.seatMapFor('B6', '615')!;
    const buckets = synthesizeAvailability(map, 'PENDING', '15JUL');
    const blocked = buckets.find((b) => b.seatAvailabilityStatus === 'Blocked');
    if (!blocked?.value[0]) {
      // Distribution is ~5% Blocked — on a 180-seat 32A there should
      // be ~9 blocked seats, but if the deterministic seed produces
      // zero, skip rather than fail. Determinism means this is
      // reproducible across runs.
      return;
    }
    const blockedSeat = blocked.value[0];
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    expect(await host.process(`ST/${blockedSeat}/S1`, wa)).toBe('SEAT NOT AVAILABLE');
  });

  it('ST/<seat> without /S<n> still skips availability validation', async () => {
    // Bare ST has no segment to validate against; the seat label is
    // stored verbatim. This was already true for existence; chunk 8
    // doesn't change it.
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    // Even a known-reserved seat is accepted without /S<n>.
    const { Inventory } = await import('../../src/store/inventory.js');
    const { synthesizeAvailability } = await import('../../src/models/seat-map.js');
    const inv = new Inventory();
    const map = inv.seatMapFor('B6', '615')!;
    const buckets = synthesizeAvailability(map, 'PENDING', '15JUL');
    const reservedSeat = buckets.find((b) => b.seatAvailabilityStatus === 'Reserved')?.value[0]!;
    expect(await host.process(`ST/${reservedSeat}`, wa)).toBe('OK');
  });

  it('ST/<seat>/S<n> accepts a seat that exists in the segment seatmap', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    // 32A has 30 rows, columns A-F. 12C exists.
    expect(await host.process('ST/12C/S1', wa)).toBe('OK');
  });

  it('ST/<seat>/S<n> rejects a row out of range', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    expect(await host.process('ST/99A/S1', wa)).toBe('INVALID SEAT');
  });

  it('ST/<seat>/S<n> rejects a column not in the layout', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    // 32A has columns A-F; Z doesn't exist.
    expect(await host.process('ST/12Z/S1', wa)).toBe('INVALID SEAT');
  });

  it('ST preference codes (WB, NSSA) skip seat-existence validation', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    expect(await host.process('ST/NSSA/S1', wa)).toBe('OK');
    expect(await host.process('ST/WB/S1', wa)).toBe('OK');
  });

  it('ST/<seat> without /S<n> bypasses seatmap validation', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
    });
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    // No /S<n> — validation skipped even though 99A would be invalid against any seatmap.
    expect(await host.process('ST/99A', wa)).toBe('OK');
  });

  it('IR after RT<locator> re-renders the BF from the store', async () => {
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
    const locator = / - ([A-Z0-9]{6})/.exec(er)?.[1]!;
    const wa2 = host.newWorkArea();
    await host.process('JI2345HA/GS', wa2);
    await host.process(`RT${locator}`, wa2);
    const ir = await host.process('IR', wa2);
    expect(ir).toContain(locator);
    expect(ir).toContain('SMITH/JOHN MR');
  });
});
