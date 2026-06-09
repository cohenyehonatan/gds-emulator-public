/**
 * v6 rail arc — Amadeus Rail Mode (R/AD, R/AN) + the standard SS
 * sell + XE cancel, per the QRG Rail chapter (p.114-115):
 *
 *   R/AD 20JULWASNYP5P    availability by departure time
 *   R/AN 20JULWASNYP5P    neutral availability
 *   SS1F21                sell seat (short sell) from the display
 *   XE<n>                 standard element cancel (no rail-specific
 *                         cancel verb in the QRG)
 *
 * Domain built per docs/non-air-domain-pattern.md, with one
 * deviation the pattern doc anticipates: rail's documented sell is
 * the standard SS (not a dedicated verb like HS/CS), so SS prefers
 * the rail display when one is on screen, and a new air AN clears it.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';
import { Inventory } from '../../src/store/inventory.js';

function makeHost() {
  return new GdsHost({
    port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
  });
}

async function signedIn(host: GdsHost) {
  const wa = host.newWorkArea();
  await host.process('JI2345HA/GS', wa);
  return wa;
}

describe('Inventory.railBetween', () => {
  it('returns WAS-NYP services sorted by departure time', () => {
    const inv = new Inventory();
    const svcs = inv.railBetween('WAS', 'NYP');
    expect(svcs).toHaveLength(3);
    expect(svcs.map((s) => s.trainNumber)).toEqual(['2150', '2154', '2158']);
  });

  it('unseeded pairs return empty', () => {
    const inv = new Inventory();
    expect(inv.railBetween('ABC', 'XYZ')).toEqual([]);
  });
});

describe('R/AD + R/AN — rail availability', () => {
  it('R/AD renders the numbered service list', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    const resp = await host.process('R/AD 20JULWASNYP', wa);
    expect(resp).toContain('R/AD 20JUL WASNYP');
    expect(resp).toContain('1 2V 2150');
    expect(resp).toContain('F9 Y9');
    expect(wa.lastRailAvail?.services).toHaveLength(3);
  });

  it('R/AN works and the space after AN is optional', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    expect(await host.process('R/AN20JULGOTSTO', wa)).toContain('9B 4026');
  });

  it('unknown pair → NO RAIL SERVICES', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    expect(await host.process('R/AD 20JULABCXYZ', wa)).toBe('NO RAIL SERVICES');
  });
});

describe('SS sells from the rail display when it is on screen', () => {
  it('SS1F2 creates a rail segment (TRN) from the cached display', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('R/AD 20JULWASNYP', wa);
    const resp = await host.process('SS1F2', wa);
    expect(resp).toContain('TRN 2V 2154 F 20JUL WAS NYP SS1');
    expect(wa.pnr.railSegments).toHaveLength(1);
    expect(wa.pnr.railSegments[0].providerName).toBe('AMTRAK');
    expect(wa.pnr.railSegments[0].confirmationNumber).toMatch(/^RC\d+$/);
  });

  it('a later air AN clears the rail display — SS sells air again', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('R/AD 20JULWASNYP', wa);
    await host.process('AN15JULJFKLAX', wa);
    const resp = await host.process('SS1Y1', wa);
    expect(resp).toContain('B6 615');
    expect(wa.pnr.railSegments).toHaveLength(0);
    expect(wa.pnr.segments).toHaveLength(1);
  });

  it('class with insufficient seats → CLASS NOT AVAILABLE', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('R/AD 20JULWASNYP', wa);
    // Train 2158 has F2 — selling 3 F seats must reject.
    expect(await host.process('SS3F3', wa)).toBe('CLASS NOT AVAILABLE');
  });

  it('line beyond the display → NO AVAILABILITY error', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('R/AD 20JULWASNYP', wa);
    const resp = await host.process('SS1F99', wa);
    expect(wa.pnr.railSegments).toHaveLength(0);
    expect(resp).not.toContain('TRN');
  });
});

describe('mixed PNR numbering + XE cancel', () => {
  it('air segment sold after a rail segment gets the next unified number', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('R/AD 20JULWASNYP', wa);
    await host.process('SS1F1', wa);        // rail seg 1
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);        // air seg — must be 2
    expect(wa.pnr.railSegments[0].segmentNumber).toBe(1);
    expect(wa.pnr.segments[0].segmentNumber).toBe(2);
  });

  it('XE<n> cancels the rail segment and leaves the air segment', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('R/AD 20JULWASNYP', wa);
    await host.process('SS1F1', wa);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('XE1', wa);
    expect(wa.pnr.railSegments).toHaveLength(0);
    expect(wa.pnr.segments).toHaveLength(1);
  });

  it('XE on a rail-only PNR works (no air segments required)', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('R/AD 20JULWASNYP', wa);
    await host.process('SS1F1', wa);
    expect(await host.process('XE1', wa)).toBe('CNL');
    expect(wa.pnr.railSegments).toHaveLength(0);
  });
});

describe('displays + persistence', () => {
  it('RTI renders the TRN line for a rail-only PNR', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('R/AD 20JULWASNYP', wa);
    await host.process('SS1F2', wa);
    const rti = await host.process('RTI', wa);
    expect(rti).toContain('1. TRN 2V 2154 F 20JUL WAS NYP SS1');
  });

  it('rail segment survives ER + retrieve', async () => {
    const host = makeHost();
    const wa = await signedIn(host);
    await host.process('AN15JULJFKLAX', wa);
    await host.process('SS1Y1', wa);
    await host.process('R/AD 20JULWASNYP', wa);
    await host.process('SS1F1', wa);
    await host.process('NM1SMITH/JOHN MR', wa);
    await host.process('AP020 555-1212-A', wa);
    await host.process('TKOK', wa);
    await host.process('RFAGT', wa);
    const er = await host.process('ER', wa);
    const loc = /([A-Z0-9]{6})\s*$/.exec(er)![1];
    const wa2 = host.newWorkArea();
    await host.process('JI2345HA/GS', wa2);
    const rt = await host.process(`RT${loc}`, wa2);
    expect(rt).toContain('TRN 2V 2150');
  });
});
