/**
 * Chunk 31.1 — EMD service guide (EGSD).
 *
 * Verbs + screen layouts VERBATIM from Amadeus Service Hub solution
 * 848456 ("How to search for information in the EMD guide"). The
 * seed's service rows (codes, RFIC/RFISC, booking methods,
 * descriptions) are as published for 6X (Amadeus's test airline)
 * and LH; only the fee amounts are synthetic.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';
import { Inventory } from '../../src/store/inventory.js';

function makeHost() {
  return new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC' });
}

async function signedIn(h: GdsHost) {
  const wa = h.newWorkArea();
  await h.process('JI2345HA/GS', wa);
  return wa;
}

describe('Inventory.emdServicesFor', () => {
  it('6X guide carries the published service rows', () => {
    const inv = new Inventory();
    const svcs = inv.emdServicesFor('6X');
    expect(svcs.length).toBeGreaterThan(10);
    const fbag = svcs.find((s) => s.code === 'FBAG')!;
    expect(fbag.rfic).toBe('C');
    expect(fbag.rfisc).toBe('0CF');
  });

  it('unseeded carrier returns empty', () => {
    expect(new Inventory().emdServicesFor('ZZ')).toEqual([]);
  });
});

describe('EGSD/V<carrier> — the verbatim list screen', () => {
  it('renders the published header + column line + rows', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('EGSD/V6X', wa);
    expect(resp).toContain('LIST OF EMD SERVICES FOR AIRLINE: 6X');
    expect(resp).toContain('CODE  RFIC/SC  BOOK  TA ISS. DESCRIPTION');
    expect(resp).toMatch(/1 +BULK +A\/C03 +SSR +YES +Bulk/);
    expect(resp).toMatch(/AVIH +C\/0BS +SSR +YES +Pet carriage - animal in hold/);
  });

  it('unknown carrier → NO EMD GUIDE FOR AIRLINE', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    expect(await h.process('EGSD/VZZ', wa)).toBe('NO EMD GUIDE FOR AIRLINE');
  });
});

describe('EGSD detail screens — the verbatim FBAG field set', () => {
  it('EGSD/VLH/SC-FBAG reproduces every published detail line', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('EGSD/VLH/SC-FBAG', wa);
    // Every line below appears verbatim in the Service Hub sample.
    for (const line of [
      'FBAG: 1ST BAG UPTO50LB23KG 62LI158CM',
      'VALIDATING CARRIER:LH RFIC:C RFISC:0CC EMD TYPE:A',
      'BOOKING METHOD: SSR',
      'MONOCOUPON EMD: NO',
      'CONSUMED AT ISSUANCE: NO',
      'ADDITIONAL DOCUMENT IN EXCHANGE: NO',
      'RESIDUAL VALUE: NO',
      'ROUTING INFORMATION MANDATORY FOR ISSUANCE: YES',
      'ISSUED IN CONNECTION WITH MANDATORY FOR ISSUANCE: YES',
      'EXCESS BAGGAGE INFORMATION MANDATORY FOR ISSUANCE: YES',
      'REFUNDABLE (ONLY FOR MANUAL PRICING): NO',
      'EXCHANGEABLE (ONLY FOR MANUAL PRICING): YES',
      'INTERLINEABLE: YES',
      'ENDORSABLE: YES',
      'ISSUABLE BY TRAVEL AGENT: YES',
      'DISPLAYABLE BY TRAVEL AGENT IF ISSUED BY AIRLINE AGENT: YES',
      'REFUNDABLE/EXCHANGEABLE BY T/A IF ISSUED BY AIRLINE AGENT: YES',
      'TRAVEL AGENT ALLOWED TO ASSOCIATE AND DISASSOCIATE: NO',
    ]) {
      expect(resp).toContain(line);
    }
  });

  it('EGSD/V<cxr>/L<n> shows the detail for the listed line', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('EGSD/V6X/L2', wa);
    expect(resp).toContain('AVIH: Pet carriage - animal in hold');
    expect(resp).toContain('RFISC:0BS');
  });

  it('unknown service code / line → specific errors', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    expect(await h.process('EGSD/V6X/SC-ZZZZ', wa)).toBe('SERVICE CODE NOT FOUND');
    expect(await h.process('EGSD/V6X/L99', wa)).toBe('INVALID LINE');
  });
});

describe('EGSD filters', () => {
  it('/RFIC-D on LH lists the financial-impact rows (the published sample)', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('EGSD/VLH/RFIC-D', wa);
    expect(resp).toContain('CANC');
    expect(resp).toContain('CANCELLATION FEE');
    expect(resp).not.toContain('FBAG'); // RFIC C, filtered out
  });

  it('/BM-SVC vs /BM-SSR split by booking method', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const svc = await h.process('EGSD/VLH/BM-SVC', wa);
    expect(svc).toContain('CANC');
    expect(svc).not.toContain('FBAG');
    expect(await h.process('EGSD/V6X/BM-SVC', wa)).toBe('NO SERVICES FOR BOOKING METHOD');
  });
});
