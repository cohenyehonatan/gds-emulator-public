/**
 * Chunk 31.2 — EMD issuance (TTM) + record display (EWD).
 *
 * Sources: QRG p.172 (TTM forms) + p.214 (EWD forms); Service Hub
 * solution 797696 ("How to issue an EMD") for the TTM qualifier
 * table, the FA/FB PNR-line shapes (FA PAX <num>/DT<cxr>/… /E<n>,
 * FB PAX … OK ETICKET/EMD/E<n>), and TTP/TTM ordering; solution
 * 873296 ("How to display an EMD record") for the VERBATIM EMD list
 * screen, the EWD/L semantics, EWDRT/EWDRL, EWD/EMD<prefix>-<num>
 * (whose example pins 6X's numeric prefix as 172), and the 6X 089
 * HEL-BKK flight now seeded verbatim from its PNR sample.
 *
 * The EMD record body screen is RECONSTRUCTED on the TWD pattern
 * (no published sample) — flagged in the renderer.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

function makeHost() {
  return new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'NCE1A0900' });
}

/** Build a 6X HEL-BKK PNR with chargeable SSRs (PETC + FBAG are in
 *  6X's EMD guide; DOCS is not). */
async function builtPnr(h: GdsHost, ssrs: string[] = ['PETC', 'FBAG']) {
  const wa = h.newWorkArea();
  await h.process('JI2345HA/GS', wa);
  await h.process('AN15JANHELBKK', wa);
  await h.process('SS1Y1', wa);
  await h.process('NM1SMITH/KATY MS', wa);
  for (const code of ssrs) await h.process(`SR ${code}`, wa);
  return wa;
}

describe('TTM — EMD issuance', () => {
  it('issues one EMD per chargeable SSR with the dashed 172- prefix', async () => {
    const h = makeHost();
    const wa = await builtPnr(h);
    const resp = await h.process('TTM', wa);
    expect(resp).toContain('OK EMD');
    expect(resp).toContain('PETC C/0AZ USD100.00');
    expect(resp).toContain('FBAG C/0CF USD150.00');
    expect(wa.pnr.emds).toHaveLength(2);
    expect(wa.pnr.emds[0].number).toMatch(/^172-\d{10}$/);
    expect(wa.pnr.emds[0].status).toBe('OPEN');
  });

  it('non-chargeable SSRs do not issue; re-issue is blocked', async () => {
    const h = makeHost();
    const wa = await builtPnr(h, ['DOCS']); // not in the EMD guide
    expect(await h.process('TTM', wa)).toBe('NO CHARGEABLE SERVICES');
    const wa2 = await builtPnr(h);
    await h.process('TTM', wa2);
    expect(await h.process('TTM', wa2)).toBe('EMD ALREADY ISSUED');
  });

  it('TTM/L<n> issues a single chargeable element', async () => {
    const h = makeHost();
    const wa = await builtPnr(h);
    const resp = await h.process('TTM/L2', wa);
    expect(resp).toContain('FBAG');
    expect(resp).not.toContain('PETC');
    expect(wa.pnr.emds).toHaveLength(1);
  });

  it('TTM/RT appends the PNR with the verbatim FA/FB line shapes', async () => {
    const h = makeHost();
    const wa = await builtPnr(h, ['PETC']);
    const resp = await h.process('TTM/RT', wa);
    // FA PAX 172-XXXXXXXXXX/DT6X/USD100.00/<date>/NCE1A0900/00000001/E1
    expect(resp).toMatch(/FA PAX 172-\d{10}\/DT6X\/USD100\.00\/\d{1,2}[A-Z]{3}\d{2}\/NCE1A0900\/\d{8}\/E1/);
    expect(resp).toMatch(/FB PAX \d{10} TTP\/O\/TTM\/RT OK ETICKET\/EMD\/E1/);
  });

  it('TTP/TTM issues tickets then EMDs (TTP always first)', async () => {
    const h = makeHost();
    const wa = await builtPnr(h, ['PETC']);
    await h.process('FXP', wa);
    const resp = await h.process('TTP/TTM', wa);
    const ticketIdx = resp.indexOf('OK ETKT');
    const emdIdx = resp.indexOf('OK EMD');
    expect(ticketIdx).toBeGreaterThanOrEqual(0);
    expect(emdIdx).toBeGreaterThan(ticketIdx);
    expect(wa.pnr.tickets.length).toBeGreaterThan(0);
    expect(wa.pnr.emds).toHaveLength(1);
  });
});

describe('EWD — record display family', () => {
  async function issued(h: GdsHost) {
    const wa = await builtPnr(h);
    await h.process('TTM', wa);
    return wa;
  }

  it('bare EWD with several records shows the verbatim list layout', async () => {
    const h = makeHost();
    const wa = await issued(h);
    const resp = await h.process('EWD', wa);
    expect(resp).toContain('EMD NBR          NAME         S   DOI      RFI     DESCRIPTION');
    expect(resp).toMatch(/1 172-\d{10}  SMITH\/KATY  O   \d{1,2}[A-Z]{3}\d{2}  C\//);
  });

  it('bare EWD with exactly one record displays it directly', async () => {
    const h = makeHost();
    const wa = await builtPnr(h, ['PETC']);
    await h.process('TTM', wa);
    const resp = await h.process('EWD', wa);
    expect(resp).toContain('EMD-172-');
    expect(resp).toContain('RFIC C  RFISC 0AZ  PETC');
  });

  it('EWD/<n> from the list, EWDRT redisplay, EWDRL relist', async () => {
    const h = makeHost();
    const wa = await issued(h);
    const rec = await h.process('EWD/2', wa);
    expect(rec).toContain('FBAG');
    expect(await h.process('EWDRT', wa)).toBe(rec);
    expect(await h.process('EWDRL', wa)).toContain('EMD NBR');
  });

  it('EWD/EMD<prefix>-<number> finds by document number', async () => {
    const h = makeHost();
    const wa = await issued(h);
    const num = wa.pnr.emds[1].number;
    const resp = await h.process(`EWD/EMD${num}`, wa);
    expect(resp).toContain(`EMD-${num}`);
  });

  it('no EMDs → NO EMD RECORD; EWDRT before any display → specific message', async () => {
    const h = makeHost();
    const wa = await builtPnr(h, ['PETC']);
    expect(await h.process('EWD', wa)).toBe('NO EMD RECORD');
    await h.process('TTM', wa);
    expect(await h.process('EWDRT', wa)).toBe('NO EMD RECORD TO REDISPLAY');
  });
});
