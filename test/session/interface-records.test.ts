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
