/**
 * Amadeus v4 chunk 20 — TK ticketing-arrangement element family.
 *
 * Per QRG p.153 (PNR ELEMENTS / Ticketing Arrangement). Seven action
 * codes (OK/TL/DO/IN/MA/SS/XL) + cross-cutting qualifiers
 * (/<office>, /<HHMM>, /P<n>, /S<n>[-<m>], /C<n>, /-<freeflow>).
 *
 * Before this commit only TKOK + TKTL<date> were accepted. After,
 * the full TK family parses + validates + stores the raw entry on
 * pnr.ticketing.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

function makeHost() {
  return new GdsHost({
    port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC',
  });
}

async function bootstrap(host: GdsHost) {
  const wa = host.newWorkArea();
  await host.process('JI2345HA/GS', wa);
  await host.process('AN15JULJFKLAX', wa);
  await host.process('SS1Y1', wa);
  await host.process('NM1SMITH/JOHN MR', wa);
  return wa;
}

describe('TK action codes (chunk 20)', () => {
  for (const [verb, label] of [
    ['TKOK',          'tickets issued, no queue placement'],
    ['TKTL15SEP',     'time-limit by date'],
    ['TKDO17SEP',     'domestic itinerary'],
    ['TKIN16JUL',     'international itinerary'],
    ['TKMA12JUL',     'tickets to be mailed'],
    ['TKSS',          'self-service device'],
    ['TKXL06NOV',     'cancel itinerary if not ticketed'],
  ] as const) {
    it(`${verb} (${label}) accepts and stores on pnr.ticketing`, async () => {
      const host = makeHost();
      const wa = await bootstrap(host);
      expect(await host.process(verb, wa)).toBe('OK');
      expect(wa.pnr.ticketing).toBe(verb);
    });
  }
});

describe('TK qualifier suffixes (office / time / pax / seg / queue)', () => {
  for (const verb of [
    'TKDO17SEP/HELSK0200',     // /<office>
    'TKIN16JUL/PARAF0245',     // /<office>
    'TKTL30JUN/1800',          // /<time>
    'TKTL/1800/ROMAZ',         // /<time>/<office>
    'TKOK/P1/S1',              // /P/S association
    'TKTL15JUL/C20',           // /C queue category
    'TKXL06NOV/PARAF0345',     // /<office>
    'TKTL13APR/NCEAF0100/-FREEFLOW TEXT', // /<office>/-<freeflow>
  ]) {
    it(`${verb} accepts`, async () => {
      const host = makeHost();
      const wa = await bootstrap(host);
      expect(await host.process(verb, wa)).toBe('OK');
      expect(wa.pnr.ticketing).toBe(verb);
    });
  }
});

describe('TK validation', () => {
  it('TKTL with no date → FORMAT', async () => {
    const host = makeHost();
    const wa = await bootstrap(host);
    expect(await host.process('TKTL', wa)).toBe('FORMAT');
  });

  it('TKDO with no date → FORMAT', async () => {
    const host = makeHost();
    const wa = await bootstrap(host);
    expect(await host.process('TKDO', wa)).toBe('FORMAT');
  });

  it('TKTL15SEP/P99 (non-existent pax) → INVALID PASSENGER', async () => {
    const host = makeHost();
    const wa = await bootstrap(host);
    expect(await host.process('TKTL15SEP/P99', wa)).toBe('INVALID PASSENGER');
  });

  it('TKTL15SEP/S99 (non-existent segment) → INVALID SEGMENT', async () => {
    const host = makeHost();
    const wa = await bootstrap(host);
    expect(await host.process('TKTL15SEP/S99', wa)).toBe('INVALID SEGMENT');
  });

  it('TKTL15SEP/S1-99 (range past last segment) → INVALID SEGMENT', async () => {
    const host = makeHost();
    const wa = await bootstrap(host);
    expect(await host.process('TKTL15SEP/S1-99', wa)).toBe('INVALID SEGMENT');
  });
});

describe('TK history + replacement', () => {
  it('replacing TKOK → TKTL15SEP records history of the change', async () => {
    const host = makeHost();
    const wa = await bootstrap(host);
    await host.process('TKOK', wa);
    await host.process('TKTL15SEP', wa);
    expect(wa.pnr.ticketing).toBe('TKTL15SEP');
    // History should reflect both events. We assert the second
    // history line uses arrow notation for the replacement.
    const last = wa.pnr.history[wa.pnr.history.length - 1];
    expect(last.text).toMatch(/TKOK\s*→\s*TKTL15SEP/);
  });

  it('first TK on a fresh PNR records "TK <entry>" (no arrow)', async () => {
    const host = makeHost();
    const wa = await bootstrap(host);
    await host.process('TKOK', wa);
    const last = wa.pnr.history[wa.pnr.history.length - 1];
    expect(last.text).toBe('TK TKOK');
  });
});

describe('TKOK + TKSS pass through validation without a date', () => {
  it('TKOK accepts with /P/S qualifiers', async () => {
    const host = makeHost();
    const wa = await bootstrap(host);
    expect(await host.process('TKOK/P1/S1', wa)).toBe('OK');
  });

  it('TKSS accepts (no date required)', async () => {
    const host = makeHost();
    const wa = await bootstrap(host);
    expect(await host.process('TKSS', wa)).toBe('OK');
    expect(wa.pnr.ticketing).toBe('TKSS');
  });
});
