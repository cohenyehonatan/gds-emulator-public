/**
 * Chunk 34 — retrieved-PNR display calibrated to the VERBATIM layout
 * from Service Hub solutions 453392470 ("How to retrieve a PNR") and
 * 906462/797696 (post-issuance PNRs):
 *
 *   --- TST TSM RLR SFP ---
 *   RP/NCE1A0900/NCE1A0900            HA/SU  10JUN26/0327Z   LLXBGG
 *     1.SMITH/KATY MS
 *     2  6X 089 Y 15JAN 4 HELBKK HK1  1650 0735+1   *1A/E*
 *     3 AP NCE 555-1212-H
 *     4 TK OK/NCE1A0900
 *     5 SSR PETC YY NN1
 *
 * Pinned: status banner built from PNR state (TST priced / TSM EMDs
 * / RLR committed / SFP DOCS held), RP header with doubled office +
 * agent/SU + Zulu stamp + locator, unified element numbering across
 * names → segments → AP → TK → SSR → OSI → RM → FA/FB, name number
 * hard against the dot, segment lines with concatenated city pair +
 * ISO weekday digit + 24-hour times + overnight +1 + *1A/E*.
 * Not modeled: MSC banner tag, OPW/OPC elements, OPERATED BY
 * sublines, RT-list navigation (RT<n>/RT0 from a multi-match list).
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

function makeHost() {
  return new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'NCE1A0900' });
}

async function committedPnr(h: GdsHost, opts: { priced?: boolean; emd?: boolean } = {}) {
  const wa = h.newWorkArea();
  await h.process('JI2345HA/GS', wa);
  await h.process('AN15JANHELBKK', wa);
  await h.process('SS1Y1', wa);
  await h.process('NM1SMITH/KATY MS', wa);
  await h.process('AP NCE 555-1212-H', wa);
  await h.process('TKOK', wa);
  await h.process('SR PETC', wa);
  await h.process('SR DOCS', wa);
  await h.process('RM CLIENT VIP', wa);
  await h.process('RF AGT', wa);
  if (opts.priced) await h.process('FXP', wa);
  if (opts.emd) await h.process('TTM', wa);
  const er = await h.process('ER', wa);
  const locator = / - ([A-Z0-9]{6})/.exec(er)![1];
  const wa2 = h.newWorkArea();
  await h.process('JI2345HA/GS', wa2);
  return { display: await h.process(`RT${locator}`, wa2), locator };
}

describe('status banner', () => {
  it('full house: --- TST TSM RLR SFP --- when priced + EMDs + committed + DOCS', async () => {
    const h = makeHost();
    const { display } = await committedPnr(h, { priced: true, emd: true });
    expect(display.split('\n')[0]).toBe('--- TST TSM RLR SFP ---');
  });

  it('unpriced commit without EMDs: --- RLR SFP ---', async () => {
    const h = makeHost();
    const { display } = await committedPnr(h);
    expect(display.split('\n')[0]).toBe('--- RLR SFP ---');
  });
});

describe('RP header', () => {
  it('doubled office, agent/SU, Zulu stamp, locator', async () => {
    const h = makeHost();
    const { display, locator } = await committedPnr(h);
    const rp = display.split('\n')[1];
    expect(rp).toMatch(
      new RegExp(`^RP/NCE1A0900/NCE1A0900 +HA/SU {2}\\d{1,2}[A-Z]{3}\\d{2}/\\d{4}Z {3}${locator}$`),
    );
  });
});

describe('unified element numbering', () => {
  it('numbers run continuously across element types in the published order', async () => {
    const h = makeHost();
    const { display } = await committedPnr(h, { emd: true });
    const lines = display.split('\n');
    expect(lines[2]).toMatch(/^ {2}1\.SMITH\/KATY MS$/); // dot hard against number
    expect(lines[3]).toMatch(/^ {2}2 {2}6X {1,2}089 Y 15JAN [1-7] HELBKK HK1 {2}1650 0735\+1 {3}\*1A\/E\*$/);
    expect(lines[4]).toMatch(/^ {2}3 AP NCE 555-1212-H$/);
    expect(lines[5]).toMatch(/^ {2}4 TK OK\/NCE1A0900$/);
    expect(lines[6]).toMatch(/^ {2}5 SSR PETC/);
    expect(lines[7]).toMatch(/^ {2}6 SSR DOCS/);
    expect(lines[8]).toMatch(/^ {2}7 RM CLIENT VIP$/);
    expect(lines[9]).toMatch(/^ {2}8 FA PAX 172-\d{10}\/DT6X/);
    expect(lines[10]).toMatch(/^ {2}9 FB PAX \d{10} TTP\/O\/TTM\/RT OK ETICKET\/EMD/);
  });

  it('overnight segments carry +1 on the 24-hour arrival time', async () => {
    const h = makeHost();
    const { display } = await committedPnr(h);
    expect(display).toContain('1650 0735+1');
  });
});
