/**
 * Back-office interface pipeline — practices from the Tres "Sabre
 * GDS Integration — Setup and Interface" guide (entry forms
 * verbatim; responses + file layout reconstructed). Generation is
 * dialect-agnostic (IUR/AIR/MIR at ticketing); the DX/DW/DV control
 * verbs are Sabre's.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';
import { readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DIR = join(tmpdir(), `gds-iface-${process.pid}`);

beforeAll(() => { process.env.GDS_INTERFACE_DIR = DIR; });
afterAll(() => { rmSync(DIR, { recursive: true, force: true }); delete process.env.GDS_INTERFACE_DIR; });

async function sabreTicketed(h: GdsHost) {
  const wa = h.newWorkArea();
  await h.process('SI*', wa);
  await h.process('115JUNJFKLAX', wa);
  await h.process('01Y1', wa);
  await h.process('-COHEN/YEHONATAN MR', wa);
  await h.process('9305-555-1212-H', wa);
  await h.process('7TAW15JUN', wa);
  await h.process('6AGT', wa);
  await h.process('WPRQ', wa);
  await h.process("W'PQ1", wa);
  return wa;
}

describe('DV invoice numbering + record generation (Interface Option 6)', () => {
  it('DV assigns the next invoice number; ticketing generates an IUR with it', async () => {
    const h = new GdsHost({ port: 0, logLevel: 'error', pcc: 'A0UC' });
    const wa = h.newWorkArea();
    await h.process('SI*', wa);
    expect(await h.process('DV*PTR', wa)).toBe('NEXT INVOICE NBR 0000001');
    expect(await h.process('DV1234', wa)).toBe('OK - NEXT INVOICE NBR 0001234');
    await sabreTicketed(h);
    const rec = h.backend.interfacePos.records[0];
    expect(rec.kind).toBe('IUR');
    expect(rec.invoiceNumber).toBe(1234);
    expect(rec.passenger).toBe('COHEN/Y');
    expect(await h.process('DV*PTR', wa)).toBe('NEXT INVOICE NBR 0001235');
  });

  it('Galileo TKP generates MIR; Amadeus TTP generates AIR (dialect-agnostic concept)', async () => {
    const g = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
    const gw = g.newWorkArea();
    await g.process('SON/ZGS', gw);
    await g.process('A15JULJFKLAX', gw);
    await g.process('N1Y1', gw);
    await g.process('N.SMITH/A', gw);
    await g.process('FQ', gw);
    await g.process('TKP', gw);
    expect(g.backend.interfacePos.records[0]?.kind).toBe('MIR');

    const a = new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC' });
    const aw = a.newWorkArea();
    await a.process('JI2345HA/GS', aw);
    await a.process('AN15JULJFKLAX', aw);
    await a.process('SS1Y1', aw);
    await a.process('NM1SMITH/KATY MS', aw);
    await a.process('FXP', aw);
    await a.process('TTP', aw);
    expect(a.backend.interfacePos.records[0]?.kind).toBe('AIR');
  });
});

describe('DX/DW control family (forms verbatim from the Tres guide)', () => {
  it('STATUS → TRANSMIT writes one .txt per record (SJPM multiple-file mode) → DWLIST → DW1 retransmits', async () => {
    rmSync(DIR, { recursive: true, force: true });
    const h = new GdsHost({ port: 0, logLevel: 'error', pcc: 'A0UC' });
    const wa = await sabreTicketed(h);
    expect(await h.process('DX STATUS', wa)).toContain('Q2  ON HOLD  1 MSG');
    expect(await h.process('DX TRANSMIT', wa)).toBe('TRANSMISSION STARTED - 1 RECORD SENT');
    const files = readdirSync(DIR);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^A0UC-\d{7}\.txt$/);
    expect(await h.process('DWLIST', wa)).toContain('COHEN/Y');
    expect(await h.process('DW1', wa)).toBe('RETRANSMITTED 1 RECORD');
    expect(await h.process('DW9', wa)).toBe('NOT ON DWLIST');
    expect(await h.process('DX HOLD', wa)).toContain('TRANSMISSION HELD');
    expect(await h.process('DX HISTORY', wa)).toContain('TRANSMITTED');
  });

  it('DWALL requires DWYES confirmation; TJR toggles + PE* display', async () => {
    const h = new GdsHost({ port: 0, logLevel: 'error', pcc: 'A0UC' });
    const wa = await sabreTicketed(h);
    await h.process('DX TRANSMIT', wa);
    expect(await h.process('DWYES', wa)).toBe('NOTHING TO CONFIRM - USE DWALL FIRST');
    expect(await h.process('DWALL', wa)).toContain('CONFIRM WITH DWYES');
    expect(await h.process('DWYES', wa)).toMatch(/^RETRANSMITTED \d+ RECORD/);
    expect(await h.process("W/VOD'ON", wa)).toBe('OK - VOD ON');
    const pe = await h.process('PE*A0UC', wa);
    expect(pe).toContain('BRNCH (INTERFACE OPTION LEVEL)  6');
    expect(pe).toContain('VOD');
  });
});

describe('spec-shaped record bodies (specs in references/interface/)', () => {
  it('IUR carries M0/M1/M2/M5 message IDs; MIR the T5+7733 header; AIR the 206 block', async () => {
    const { recordBody } = await import('../../src/session/interface-records.js');
    const base = {
      seq: 1, invoiceNumber: 1234, locator: 'GZW1CS', passenger: 'COHEN/Y',
      documentNumber: '0064692507094', total: 273.48, currency: 'USD',
      pcc: 'A0UC', createdAt: new Date('2026-06-12T00:00:00Z'), transmitted: false,
    };
    const iur = recordBody({ ...base, kind: 'IUR' as const });
    const [m0, m1, m2] = iur.split('\n');
    // Fixed columns per the in-tree IUR Programmer Guide v40:
    expect(m0.slice(0, 2)).toBe('AA');        // transmission header origination
    expect(m0.slice(11, 13)).toBe('M0');      // IU0MID @12/2
    expect(m0.slice(13, 14)).toBe('1');       // IU0TYP invoice/ticket
    expect(m0.slice(14, 16)).toBe('40');      // IU0VER
    expect(m0.slice(36, 43)).toBe('0001234'); // IU0IVN @37/7
    expect(m0.slice(53, 61)).toBe('GZW1CS  ');// IU0PNR @54/8
    expect(m1.slice(0, 2)).toBe('M1');
    expect(m1.slice(4, 11)).toBe('COHEN/Y');  // IU1PNM @5
    expect(m2.slice(0, 2)).toBe('M2');
    expect(m2.slice(4, 7)).toBe('ADT');       // IU2PTY @5/3
    expect(m2.slice(233, 243)).toBe('4692507094'); // IU2TNO @234/10
    const mir = recordBody({ ...base, kind: 'MIR' as const });
    const hdr = mir.split('\n')[0];
    // Fixed columns per the in-tree MIR User Guide (0-indexed offsets):
    expect(hdr.slice(0, 2)).toBe('T5');     // T50BID @0/2
    expect(hdr.slice(2, 4)).toBe('1G');     // T50TRC @2/2
    expect(hdr.slice(4, 8)).toBe('7733');   // T50SPC @4/4
    expect(hdr.slice(98, 104)).toBe('GZW1CS'); // T50RCL @98/6
    const air = recordBody({ ...base, kind: 'AIR' as const });
    expect(air).toContain('AIR-BLK206');
  });
});

describe('Amadeus B* + Galileo HM* control families (Trams guides, forms verbatim)', () => {
  it('Amadeus: BB status, BD list, BASTART transmits, BSSTOP stops', async () => {
    const { AmadeusDialect } = await import('../../src/dialects/amadeus/index.js');
    const h = new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC' });
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    expect(await h.process('BB', wa)).toContain('APPLICATION QUEUE STOPPED - 0 AIR(S) PENDING');
    await h.process('AN15JULJFKLAX', wa);
    await h.process('SS1Y1', wa);
    await h.process('NM1SMITH/KATY MS', wa);
    await h.process('FXP', wa);
    await h.process('TTP', wa);
    expect(await h.process('BD', wa)).toContain('PENDING');
    expect(await h.process('BASTART', wa)).toMatch(/TRANSMISSION STARTED - \d+ AIR\(S\) SENT/);
    expect(await h.process('BSSTOP', wa)).toBe('TRANSMISSION STOPPED');
    expect(await h.process('BB', wa)).toContain('STOPPED');
  });

  it('Galileo: HMLM link, HMLD status, HQC counts, HMOM up/down', async () => {
    const h = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
    const wa = h.newWorkArea();
    await h.process('SON/ZGS', wa);
    expect(await h.process('HMLMC0FFEEDA', wa)).toBe('LINKAGE ESTABLISHED - MIR DEV C0FFEE');
    expect(await h.process('HMLD', wa)).toContain('MIR DEV');
    await h.process('A15JULJFKLAX', wa);
    await h.process('N1Y1', wa);
    await h.process('N.SMITH/A', wa);
    await h.process('FQ', wa);
    await h.process('TKP', wa);
    expect(await h.process('HQC', wa)).toMatch(/PENDING +SENT/);
    expect(await h.process('HMOMC0FFEE-U', wa)).toMatch(/UP - \d+ RECORD\(S\) SENT/);
    expect(await h.process('HMOMC0FFEE-D', wa)).toContain('DOWN');
  });
});
