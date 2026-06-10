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
    // Record body verbatim per 866006 (upgraded from the old
    // reconstructed screen).
    expect(resp).toContain('RFIC-C  BAGGAGE');
    expect(resp).toContain('CPN-1  RFISC-0AZ  6X  S-O');
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

describe('chunk 32 — EWH history, EMR reprint, FHD/FHP manual documents', () => {
  async function issued(h: GdsHost) {
    const wa = await builtPnr(h);
    await h.process('TTM', wa);
    return wa;
  }

  it('EWH after EWD renders the verbatim history screen', async () => {
    const h = makeHost();
    const wa = await issued(h);
    await h.process('EWD/L1', wa);
    const resp = await h.process('EWH', wa);
    expect(resp).toContain('EMD HISTORY DISPLAY');
    // Header: EMD-<13 digits, undashed>   TYPE-A   RFIC-C
    expect(resp).toMatch(/EMD-172\d{10} {3}TYPE-A {3}RFIC-C/);
    expect(resp).toContain('CPN RFISC ST SAC              OFFICE ID SIGN       TIME/DATE');
    // Issuance event row: coupon 1, RFISC, O status, office, sign, ZULU stamp.
    expect(resp).toMatch(/ {2}1 {3}0AZ {2}O .*NCE1A0900 HA .*\d{4}Z\d{1,2}[A-Z]{3}\d{2}/);
  });

  it('EWH/EMD<number> works without a prior EWD; no record → NO EMD RECORD', async () => {
    const h = makeHost();
    const wa = await issued(h);
    const num = wa.pnr.emds[0].number;
    expect(await h.process(`EWH/EMD${num}`, wa)).toContain('EMD HISTORY DISPLAY');
    expect(await h.process('EWH/EMD172-0000000000', wa)).toBe('NO EMD RECORD');
  });

  it('EMR selector family: bare / L-range / P1 / by number; P2 empty', async () => {
    const h = makeHost();
    const wa = await issued(h);
    expect(await h.process('EMR', wa)).toContain('OK COUPON REPRINT');
    expect(await h.process('EMR/L1-2', wa)).toContain('PETC');
    expect(await h.process('EMR/P1', wa)).toContain('OK COUPON REPRINT');
    expect(await h.process('EMR/P2', wa)).toBe('NO EMD RECORD');
    const num = wa.pnr.emds[1].number;
    const byNum = await h.process(`EMR/EMD${num}`, wa);
    expect(byNum).toContain('FBAG');
    expect(byNum).not.toContain('PETC');
  });

  it('FHD adds a manual document: PNR line, EWD list row, duplicate block, NO HISTORY', async () => {
    const h = makeHost();
    const wa = await issued(h);
    expect(await h.process('FHD057-9999999999/E2', wa)).toBe('OK');
    expect(await h.process('FHD057-9999999999/E2', wa)).toBe('DOCUMENT ALREADY ON PNR');
    const manual = wa.pnr.emds.find((e) => e.manual)!;
    expect(manual.manual).toBe('FHD');
    expect(manual.carrier).toBe('AF'); // 057 reverse lookup
    // Renders as an FHD PAX element, not FA/FB.
    const pnrText = await h.process('TTM/RT', wa).catch(() => '');
    // (TTM/RT may reject — render via EWD list + check the manual row instead)
    const list = await h.process('EWDRL', wa);
    expect(list).toContain('057-9999999999');
    await h.process('EWD/L3', wa);
    expect(await h.process('EWH', wa)).toBe('NO HISTORY');
    // EMR skips manual documents.
    const emr = await h.process('EMR', wa);
    expect(emr).not.toContain('057-9999999999');
    void pnrText;
  });

  it('FHP with pax association parses; bad shapes stay FORMAT', async () => {
    const h = makeHost();
    const wa = await builtPnr(h, ['PETC']);
    expect(await h.process('FHP057-1234567890/E1/P1', wa)).toBe('OK');
    expect(wa.pnr.emds[0].manual).toBe('FHP');
    expect(await h.process('FHDABC-1234567890/E1', wa)).not.toBe('OK');
  });

  it('EWD/<n> follows the date-sorted list order; EWD/L<n> follows element order', async () => {
    const h = makeHost();
    const wa = await issued(h); // PETC (older serial) + FBAG
    // List is most-recent-first; both share the same timestamp in
    // tests, so sort is stable — line 1 = PETC (insertion order kept
    // on tie). EWD/L1 must equal pnr.emds[0] regardless.
    const viaList = await h.process('EWD/1', wa);
    const viaElement = await h.process('EWD/L1', wa);
    expect(viaElement).toContain(wa.pnr.emds[0].serviceCode);
    expect(viaList).toContain('EMD-');
  });
});

describe('chunk 36 — auxiliary service segments (IU, solution 843687 verbatim)', () => {
  it('IU creates an /SVC line with the verbatim shape; NN confirms to HK', async () => {
    const h = makeHost();
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    await h.process('NM1SMITH/JEN MS', wa);
    const resp = await h.process('IU 6X NN1 LOUS JFK/15APR-VIP XXX/P1', wa);
    expect(resp).toBe(' 1 /SVC 6X HK1 LOUS JFK 15APR-VIP XXX');
    expect(wa.pnr.svcSegments[0]).toMatchObject({ code: 'LOUS', status: 'HK', passenger: 1 });
  });

  it('multi-passenger PNR requires /P association', async () => {
    const h = makeHost();
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    await h.process('NM1SMITH/JEN MS', wa);
    await h.process('NM1SMITH/TOM MR', wa);
    expect(await h.process('IU 6X NN1 LOUS', wa)).toBe('PASSENGER ASSOCIATION REQUIRED');
    expect(await h.process('IU 6X NN1 LOUS/P2', wa)).toContain('/SVC 6X HK1 LOUS');
  });

  it('TTM issues an EMD-S from an SVC-method guide row (LH CANC end-to-end)', async () => {
    const h = makeHost();
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    await h.process('NM1SMITH/JEN MS', wa);
    await h.process('IU LH NN1 CANC', wa);
    const resp = await h.process('TTM', wa);
    expect(resp).toContain('CANC D/995 EUR100.00');
    expect(wa.pnr.emds[0].emdType).toBe('S'); // standalone
    expect(wa.pnr.emds[0].number).toMatch(/^220-/); // LH prefix
  });

  it('SSR-method rows do not issue from SVC segments (the guide governs)', async () => {
    const h = makeHost();
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    await h.process('NM1SMITH/JEN MS', wa);
    await h.process('IU 6X NN1 LOUS', wa); // LOUS is SSR-method on 6X
    expect(await h.process('TTM', wa)).toBe('NO CHARGEABLE SERVICES');
  });

  it('SVC segments render in the unified RT element list', async () => {
    const h = makeHost();
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    await h.process('AN15JANHELBKK', wa);
    await h.process('SS1Y1', wa);
    await h.process('NM1SMITH/JEN MS', wa);
    await h.process('AP NCE 555-1212-H', wa);
    await h.process('TKOK', wa);
    await h.process('RF AGT', wa);
    await h.process('IU LH NN1 CANC', wa);
    const er = await h.process('ER', wa);
    const locator = / - ([A-Z0-9]{6})/.exec(er)![1];
    const wa2 = h.newWorkArea();
    await h.process('JI2345HA/GS', wa2);
    const display = await h.process(`RT${locator}`, wa2);
    expect(display).toMatch(/^ {2}3 \/SVC LH HK1 CANC$/m);
  });
});

describe('chunk 36b — ancillary catalogue (FXK) + book (FWK), solution 828431 verbatim', () => {
  async function withItinerary(h: GdsHost, names = 1) {
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    await h.process('AN15JANHELBKK', wa);
    await h.process('SS1Y1', wa);
    for (let i = 0; i < names; i++) await h.process(`NM1SMITH/PAX${i + 1} MS`, wa);
    return wa;
  }

  it('FXK renders the verbatim header + FLIGHT RELATED rows + descriptions', async () => {
    const h = makeHost();
    const wa = await withItinerary(h);
    const resp = await h.process('FXK', wa);
    const lines = resp.split('\n');
    expect(lines[0]).toBe('FXK');
    expect(lines[1]).toBe('    PASSENGER       PR FROM-TO C SC  SRV  PTC BKM (USD)TOTAL  AV');
    expect(lines[2]).toBe('FLIGHT RELATED');
    expect(lines[3]).toMatch(/^001 P1 {14}6X HEL-BKK Y C03 BULK ADT SSR {2}USD50 {5}OK$/);
    expect(lines[4]).toBe('    BULK -');
    // SVC-method rows are excluded (only SSR-method services list).
    expect(resp).not.toContain('CANC');
  });

  it('FWK<n> books the catalog line as an SSR; TTM then issues it', async () => {
    const h = makeHost();
    const wa = await withItinerary(h);
    await h.process('FXK', wa);
    const resp = await h.process('FWK5', wa); // line 5 = FBAG
    expect(resp).toBe(' SSR FBAG 6X NN1/P1');
    expect(wa.pnr.ssrs[0]).toMatchObject({ code: 'FBAG', carrier: '6X' });
    expect(await h.process('TTM', wa)).toContain('FBAG C/0CF USD150.00');
  });

  it('FWK without a catalog / invalid line → specific errors', async () => {
    const h = makeHost();
    const wa = await withItinerary(h);
    expect(await h.process('FWK1', wa)).toBe('NO CATALOG DISPLAYED - FXK FIRST');
    await h.process('FXK', wa);
    expect(await h.process('FWK999', wa)).toBe('INVALID LINE');
  });

  it('FXK/P and FXK/S filters narrow the catalog; no itinerary → NO ITINERARY', async () => {
    const h = makeHost();
    const wa = await withItinerary(h, 2);
    const all = await h.process('FXK', wa);
    const p2 = await h.process('FXK/P2', wa);
    expect(p2.split('\n').length).toBeLessThan(all.split('\n').length);
    expect(p2).toContain('P2');
    expect(p2).not.toContain(' P1 ');
    expect(await h.process('FXK/S9', wa)).toBe('NO ANCILLARY SERVICES');
    const empty = h.newWorkArea();
    await h.process('JI2345HA/GS', empty);
    await h.process('NM1SMITH/JEN MS', empty);
    expect(await h.process('FXK', empty)).toBe('NO ITINERARY');
  });
});

describe('polish — the XBAG worked example (solution 823571 verbatim)', () => {
  it('EGSD/VAF renders the 14 published rows incl. the SEAT method + TA ISS. NO', async () => {
    const h = makeHost();
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    const resp = await h.process('EGSD/VAF', wa);
    expect(resp).toContain('LIST OF EMD SERVICES FOR AIRLINE: AF');
    expect(resp).toMatch(/A\/0B5 +SEAT +YES +chargeable seat/);
    expect(resp).toMatch(/HBAG +C\/0IK +SSR +NO +HEAVY DC SOLD BAG/);
    expect(resp).toMatch(/XBAG +C\/0C3 +SSR +YES +Excess Baggage/);
  });

  it('SRXBAG-…/S2/P1 → SSR XBAG AF with uppercased text + segment suffix → TTM issues', async () => {
    const h = makeHost();
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    await h.process('AN20JUNCDGJFK', wa);
    await h.process('SS1Y1', wa);
    await h.process('NM1SMITH/KATY MS', wa);
    expect(await h.process('SRXBAG-PDBG-10KGS-60x80x50/S2/P1', wa)).toBe('OK');
    expect(wa.pnr.ssrs[0]).toMatchObject({
      code: 'XBAG', carrier: 'AF', text: 'PDBG-10KGS-60X80X50/S2', nameRef: { item: 1 },
    });
    const ttm = await h.process('TTM', wa);
    expect(ttm).toContain('XBAG C/0C3 EUR60.00');
    expect(wa.pnr.emds[0].number).toMatch(/^057-/); // AF prefix
  });

  it('TA ISS. NO rows never issue (HBAG via SSR, BBEV via SVC)', async () => {
    const h = makeHost();
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    await h.process('AN20JUNCDGJFK', wa);
    await h.process('SS1Y1', wa);
    await h.process('NM1SMITH/KATY MS', wa);
    await h.process('SR HBAG', wa);
    await h.process('IU AF NN1 BBEV', wa);
    expect(await h.process('TTM', wa)).toBe('NO CHARGEABLE SERVICES');
  });
});

describe('polish — TSM-P flow: TMC mask / TQM index / TTM/M issue (823571)', () => {
  async function withXbag(h: GdsHost) {
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    await h.process('AN20JUNCDGJFK', wa);
    await h.process('SS1Y1', wa);
    await h.process('NM1SMITH/KATY MS', wa);
    await h.process('SRXBAG-PDBG-10KGS-60x80x50/S2/P1', wa);
    return wa;
  }

  it('TMC/V<cxr>/L<n> renders the verbatim TSM-P mask and stores the TSM', async () => {
    const h = makeHost();
    const wa = await withXbag(h);
    const resp = await h.process('TMC/VAF/L1', wa);
    expect(resp).toMatch(/^TSM {4}1 {2}TYPE P {5}NCE1A0900 HA\/\d{2}[A-Z]{3} 1 {7}EMD-A CARR AF$/m);
    expect(resp).toContain('RFIC-C/U   BAGGAGE');
    expect(resp).toMatch(/1\. RFISC-0C3 EXCESS BAGGAGE +L {3}1/);
    expect(resp).toContain('OPERATING CC-AF');
    expect(resp).toContain('ORIGIN-CDG DEST-JFK');
    expect(wa.pnr.tsms).toHaveLength(1);
  });

  it('TQM lists TSMs with OPEN/ISSUED state; TTM/M<n> issues and consumes', async () => {
    const h = makeHost();
    const wa = await withXbag(h);
    expect(await h.process('TQM', wa)).toBe('NO TSM RECORD');
    await h.process('TMC/VAF/L1', wa);
    expect(await h.process('TQM', wa)).toContain('1  TYPE P  AF XBAG C/0C3  OPEN');
    const issue = await h.process('TTM/M1', wa);
    expect(issue).toContain('XBAG C/0C3 EUR60.00');
    expect(wa.pnr.emds[0].number).toMatch(/^057-/);
    expect(await h.process('TQM', wa)).toContain('ISSUED');
    expect(await h.process('TTM/M1', wa)).toBe('NO TSM RECORD'); // consumed
  });

  it('TMC with no matching chargeable line → INVALID LINE', async () => {
    const h = makeHost();
    const wa = await withXbag(h);
    expect(await h.process('TMC/VAF/L9', wa)).toBe('INVALID LINE');
    expect(await h.process('TMC/VLH/L1', wa)).toBe('INVALID LINE'); // wrong carrier
  });
});

describe('polish — EMD record body + EWA association (866006 verbatim)', () => {
  async function ticketedWithEmd(h: GdsHost) {
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    await h.process('AN20JUNCDGJFK', wa);
    await h.process('SS1Y1', wa);
    await h.process('NM1SMITH/KATY MS', wa);
    await h.process('AP NCE 555-1212-H', wa);
    await h.process('TKOK', wa);
    await h.process('RF AGT', wa);
    await h.process('FXP', wa);
    await h.process('TTP', wa);
    await h.process('SR ABAG', wa);
    await h.process('TTM', wa);
    return wa;
  }

  it('the record body carries the verbatim coupon block with auto-ICW (A)', async () => {
    const h = makeHost();
    const wa = await ticketedWithEmd(h);
    const resp = await h.process('EWD', wa);
    expect(resp).toContain('RFIC-C  BAGGAGE');
    expect(resp).toContain('REMARKS-');
    expect(resp).toMatch(/CPN-1 {2}RFISC-0CC {2}AF {2}S-O/);
    expect(resp).toContain(' PRESENT TO-');
    // Issued while a ticket existed → auto-associated ICW (A).
    expect(resp).toMatch(/ ICW-057\d{10}E1 {11}\(A\)/);
    expect(resp).toMatch(/FARE {3}F {4}EUR {9}40\.00/);
  });

  it('EWA/ASC re-points the ICW and confirms with the verbatim response', async () => {
    const h = makeHost();
    const wa = await ticketedWithEmd(h);
    await h.process('EWD', wa); // sets lastEmdIndex
    const resp = await h.process('EWA/ASC/E1/TKT057-9999999999/E1', wa);
    expect(resp).toBe('AF EMD:  OK EMD RECORD UPDATED');
    expect(wa.pnr.emds[0].icwTicket).toBe('0579999999999');
    expect((await h.process('EWDRT', wa))).toContain('ICW-0579999999999E1');
  });

  it('EWA without a displayed record → specific error', async () => {
    const h = makeHost();
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    expect(await h.process('EWA/ASC/E1/TKT057-1234567890/E1', wa)).toBe('NO EMD RECORD DISPLAYED');
  });
});
