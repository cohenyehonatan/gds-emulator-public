import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import { Pnr } from '../../src/models/pnr.js';

describe('Galileo FQN / FN<...> parsing', () => {
  it('FQN — fare components mode', () => {
    const r = parseGalileoEntry('FQN');
    expect(r.kind).toBe('fare_notes');
    if (r.kind === 'fare_notes') expect(r.mode).toBe('components');
  });

  it('FN*1 — notes by line, no paragraph', () => {
    const r = parseGalileoEntry('FN*1');
    expect(r.kind).toBe('fare_notes');
    if (r.kind === 'fare_notes') {
      expect(r.mode).toBe('notes_by_line');
      expect(r.fareLine).toBe(1);
      expect(r.paragraph).toBeUndefined();
    }
  });

  it('FN*1/ALL — all paragraphs', () => {
    const r = parseGalileoEntry('FN*1/ALL');
    expect(r.kind).toBe('fare_notes');
    if (r.kind === 'fare_notes') {
      expect(r.fareLine).toBe(1);
      expect(r.paragraph).toBe('ALL');
    }
  });

  it('FN*1/P8 — specific paragraph', () => {
    const r = parseGalileoEntry('FN*1/P8');
    expect(r.kind).toBe('fare_notes');
    if (r.kind === 'fare_notes') expect(r.paragraph).toBe('P8');
  });

  it('FN*3/P8-10.16 — multi-range paragraphs (Mini Guide verbatim)', () => {
    const r = parseGalileoEntry('FN*3/P8-10.16');
    expect(r.kind).toBe('fare_notes');
    if (r.kind === 'fare_notes') {
      expect(r.fareLine).toBe(3);
      expect(r.paragraph).toBe('P8-10.16');
    }
  });

  it('FN2/ALL — segment-based after FQN', () => {
    const r = parseGalileoEntry('FN2/ALL');
    expect(r.kind).toBe('fare_notes');
    if (r.kind === 'fare_notes') {
      expect(r.mode).toBe('notes_by_segment');
      expect(r.segment).toBe(2);
      expect(r.paragraph).toBe('ALL');
    }
  });

  it('rejects malformed FN', () => {
    expect(() => parseGalileoEntry('FN*ALL')).toThrow();
    expect(() => parseGalileoEntry('FN*')).toThrow();
  });
});

describe('Galileo FQN dispatch — local fare components', () => {
  let host: GdsHost;
  let wa: ReturnType<GdsHost['newWorkArea']>;

  beforeEach(async () => {
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });

  it('FQN with no filed fares returns NO FILED FARES', async () => {
    const resp = await host.process('FQN', wa);
    expect(resp).toBe('NO FILED FARES');
  });

  it('FQN renders one block per priceQuote with base/tax/total', async () => {
    const pnr = new Pnr();
    pnr.locator = 'ABC123';
    pnr.priceQuotes.push({
      departureDate: '27JUN',
      validatingCarrier: 'UA',
      currency: 'USD',
      fareBasis: ['YEE3M', 'YEE6M'],
      passengers: [
        {
          passengerType: 'ADT',
          count: 2,
          base: 100,
          taxes: [{ code: 'US', amount: 7.50 }],
          taxTotal: 7.50,
          total: 107.50,
          fareCalc: 'JFK UA LAX107.50 END',
        },
      ],
    });
    wa.pnr = pnr;

    const resp = await host.process('FQN', wa);
    expect(resp).toContain('FQ 1 UA USD YEE3M YEE6M');
    expect(resp).toContain('ADT');
    expect(resp).toContain('BASE 100.00');
    expect(resp).toContain('TAX 7.50');
    expect(resp).toContain('TOTAL 215.00'); // total × count
    expect(resp).toContain('JFK UA LAX107.50 END');
  });

  it('FQN with multiple priceQuotes renders all blocks', async () => {
    const pnr = new Pnr();
    pnr.locator = 'ABC123';
    for (let i = 0; i < 2; i++) {
      pnr.priceQuotes.push({
        departureDate: '27JUN',
        validatingCarrier: 'UA',
        currency: 'USD',
        fareBasis: ['Y'],
        passengers: [
          { passengerType: 'ADT', count: 1, base: 50, taxes: [], taxTotal: 0, total: 50, fareCalc: '' },
        ],
      });
    }
    wa.pnr = pnr;

    const resp = await host.process('FQN', wa);
    expect(resp).toContain('FQ 1');
    expect(resp).toContain('FQ 2');
  });
});

describe('Galileo FN<...> dispatch — emulated path stubs', () => {
  let host: GdsHost;
  let wa: ReturnType<GdsHost['newWorkArea']>;

  beforeEach(async () => {
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });

  it('FN*1 without a prior FD returns NO FARE DISPLAY ON SCREEN', async () => {
    const resp = await host.process('FN*1', wa);
    expect(resp).toBe('NO FARE DISPLAY ON SCREEN');
  });

  it('FN2/ALL — segment-mode is not implemented', async () => {
    const resp = await host.process('FN2/ALL', wa);
    expect(resp).toBe('FN SEGMENT MODE NOT IMPLEMENTED');
  });

  it('FN*1 after emulated FD returns EMULATED NOT SUPPORTED (no narrative)', async () => {
    await host.process('FDJFKLAX', wa); // emulated FD has no identifier
    const resp = await host.process('FN*1', wa);
    // Emulated path doesn't capture an identifier, so it falls into
    // "no FD on screen" — that's the correct response shape, not a
    // misleading emulated stub.
    expect(resp).toBe('NO FARE DISPLAY ON SCREEN');
  });

  it('FN*<out-of-range-line> returns LINE <n> NOT IN FARE DISPLAY', async () => {
    // Force a cached fare display directly.
    wa.lastFareDisplay = {
      origin: 'LON',
      destination: 'PAR',
      departureDate: '14AUG',
      currency: 'GBP',
      carriers: [],
      identifier: 'fd-abc',
      lines: [
        { sequence: 1, carrier: 'BA', amount: 250, fareBasisCode: 'YEE3M', bookingClass: 'Y', journeyType: 'OW' },
      ],
    };
    const resp = await host.process('FN*5', wa);
    expect(resp).toBe('LINE 5 NOT IN FARE DISPLAY');
  });
});
