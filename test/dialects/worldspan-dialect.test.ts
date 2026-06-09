/**
 * Worldspan (1P) dialect — v6 arc, commit W.1.
 *
 * Co-built from Galileo via a pre-parse translator, the Apollo
 * pattern. Translation rules verbatim from the in-tree Comparison
 * Guide's "Worldspan to Travelport+" chapter (pp.19-33). Emulated-
 * only — no live 1P tenant.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import {
  WorldspanDialect,
  translateWorldspanToGalileo as t,
} from '../../src/dialects/worldspan/index.js';

describe('translateWorldspanToGalileo — the Comparison Guide Rosetta', () => {
  it('sign on/off + area switch', () => {
    expect(t('BSI$5467AB/GS')).toBe('SON/ZAB');
    expect(t('BSO$')).toBe('SOF');
    expect(t('BB')).toBe('SB');
    expect(t('BE')).toBe('SE');
  });

  it('sells: reference rewritten, direct + open pass with status fix', () => {
    expect(t('01C2')).toBe('N1C2');
    expect(t('03C2Y3')).toBe('N3C2Y3');
    expect(t('0AY631C11JULHELARNNN1')).toBe('0AY631C11JULHELARNNN1'); // direct unchanged
    expect(t('0YYOPENYCPHFRAPS1')).toBe('0YYOPENYCPHFRANO1');
  });

  it('status change + rebook-to-class', () => {
    expect(t('.1HK')).toBe('@1HK');
    expect(t('X3-5#0/F')).toBe('@3-5/F');
    expect(t('X2')).toBe('X2'); // plain cancel unchanged
  });

  it('availability carrier qualifier + flight details', () => {
    expect(t('A23JULFRAROM-LH')).toBe('A23JULFRAROM/LH');
    expect(t('A21NOVJFKLAX')).toBe('A21NOVJFKLAX');
    expect(t('V$2')).toBe('TTL2');
  });

  it('name field: add / change / delete', () => {
    expect(t('-WATKINS/OSCAR MR')).toBe('N.WATKINS/OSCAR MR');
    expect(t('-3@REED/CMRS')).toBe('N.P3@REED/CMRS');
    expect(t('-3@')).toBe('N.P3@');
  });

  it('phone / received / ticketing / remarks sigils', () => {
    expect(t('9*DEN3035551234-A')).toBe('P.DEN3035551234-A');
    expect(t('92@LON 0207 675 9989B')).toBe('P.2@LON 0207 675 9989B');
    expect(t('6JACKIE')).toBe('R.JACKIE');
    expect(t('6@')).toBe('R.@');
    expect(t('7TAW/00/21DEC')).toBe('T.TAU/21DEC');
    expect(t('7T/')).toBe('T.T*');
    expect(t('7@')).toBe('T.@');
    expect(t('5 PREFERS WINDOW')).toBe('NP.PREFERS WINDOW');
    expect(t('51@')).toBe('NP.1@');
  });

  it('SSR / OSI sigil 3', () => {
    expect(t('3SAVGML')).toBe('SI.VGML');
    expect(t('3S5N1WCHR')).toBe('SI.P1S5/WCHR');
    expect(t('3OSI YY VIP ROCK STAR')).toBe('SI.YY*VIP ROCK STAR');
  });

  it('retrieve by name + seat map from availability', () => {
    expect(t('**-HARRIS')).toBe('*-HARRIS');
    expect(t('41*Y')).toBe('SM*A1Y');
  });

  it('identical verbs pass through untouched', () => {
    for (const same of ['E', 'ER', 'I', 'IR', 'XI', 'X2', '*R', '*H', '*ABC123']) {
      expect(t(same)).toBe(same);
    }
  });
});

describe('WorldspanDialect — full PNR lifecycle through the translator', () => {
  it('sign on → avail → sell → mandatory fields → ER → retrieve by name', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new WorldspanDialect(), pcc: '1P',
    });
    const wa = host.newWorkArea();
    expect(await host.process('BSI$5467AB/GS', wa)).toContain('AB SIGNED ON');
    expect(await host.process('A21NOVJFKLAX', wa)).toContain('JFK-LAX');
    expect(await host.process('01Y1', wa)).toContain('SS 1');
    await host.process('-WATKINS/OSCAR MR', wa);
    await host.process('9*DEN3035551234-A', wa);
    await host.process('6JACKIE', wa);
    await host.process('7TAW/00/21DEC', wa);
    const er = await host.process('ER', wa);
    expect(er).toMatch(/[A-Z0-9]{6}/); // locator issued

    const wa2 = host.newWorkArea();
    await host.process('BSI$5467AB/GS', wa2);
    const byName = await host.process('**-WATKINS', wa2);
    expect(byName).toContain('WATKINS/OSCAR MR');
    expect(byName).toContain('T. TAU/21DEC');
    // Status change through the Worldspan sigil.
    expect(await host.process('.1HK', wa2)).toContain('HK');
    expect(await host.process('BSO$', wa2)).toContain('SIGNED OFF');
  });

  it('SSR + OSI + remark land on the PNR', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new WorldspanDialect(), pcc: '1P',
    });
    const wa = host.newWorkArea();
    await host.process('BSI$5467AB/GS', wa);
    await host.process('A21NOVJFKLAX', wa);
    await host.process('01Y1', wa);
    await host.process('3SAVGML', wa);
    await host.process('3OSI YY VIP ROCK STAR', wa);
    await host.process('5 PREFERS WINDOW', wa);
    expect(wa.pnr.ssrs.some((s) => s.code === 'VGML')).toBe(true);
    expect(wa.pnr.osis.some((o) => o.text.includes('VIP ROCK STAR'))).toBe(true);
    expect(wa.pnr.remarks.length).toBeGreaterThan(0);
  });

  it('V$<n> flight details work from a cached availability', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new WorldspanDialect(), pcc: '1P',
    });
    const wa = host.newWorkArea();
    await host.process('BSI$5467AB/GS', wa);
    await host.process('A21NOVJFKLAX', wa);
    expect(await host.process('V$1', wa)).toContain('FLIGHT B6 615');
  });

  it('unknown entries surface the Galileo FORMAT error', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new WorldspanDialect(), pcc: '1P',
    });
    const wa = host.newWorkArea();
    await host.process('BSI$5467AB/GS', wa);
    const resp = await host.process('ZZZ?!', wa);
    expect(host.dialect.isErrorResponse(resp)).toBe(true);
  });
});

describe('Worldspan hotel + car (Comparison Guide 5-way table)', () => {
  it('translator maps the hotel + car family', () => {
    expect(t('HLLON6FEB09FEB2')).toBe('HOA6FEB-09FEBLON2');
    expect(t('HLLON')).toBe('HOILON');
    expect(t('HLLON/CHI')).toBe('HOILON/HI');
    expect(t('HA1')).toBe('HOC1');
    expect(t('CRA23AUG-25AUGLON/ARR-1P')).toBe('CAL23AUG-25AUGLON/ARR-1P');
    expect(t('CR04')).toBe('N1A4');
  });

  it('end-to-end: HL avail → HA complete → CRA avail → CR0 sell', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new WorldspanDialect(), pcc: '1P',
    });
    const wa = host.newWorkArea();
    await host.process('BSI$5467AB/GS', wa);
    const avail = await host.process('HLLON6FEB09FEB2', wa);
    expect(avail).toContain('HOTEL AVAILABILITY LON 6FEB-09FEB');
    const complete = await host.process('HA1', wa);
    expect(complete).toContain('HILON HOLIDAY INN');
    const carAvail = await host.process('CRA23AUG-25AUGLON', wa);
    expect(carAvail).toContain('CAR AVAILABILITY LON');
    const sold = await host.process('CR04', wa);
    expect(sold).toContain('CAR SOLD');
    expect(wa.pnr.carSegments).toHaveLength(1);
  });
});
