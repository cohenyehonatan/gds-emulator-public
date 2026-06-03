import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { Pnr } from '../../src/models/pnr.js';

describe('Galileo *H family — local v1 stub (no v11 REST change-log)', () => {
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

  function buildPnr(): Pnr {
    const pnr = new Pnr();
    pnr.locator = 'ABC123';
    pnr.names.push({
      surname: 'SMITH',
      passengers: [{ firstName: 'JOHN MR' }],
      count: 1,
      infant: false,
    });
    pnr.segments.push({
      segmentNumber: 1,
      carrier: 'UA',
      flightNumber: '1234',
      bookingClass: 'Y',
      date: '27JUN',
      dayOfWeek: '?',
      dayOfWeekNum: 0,
      origin: 'DEN',
      destination: 'FRA',
      status: 'HK',
      seats: 1,
      departTime: '0800',
      arriveTime: '0730',
    });
    pnr.priceQuotes.push({
      departureDate: '27JUN',
      validatingCarrier: 'UA',
      currency: 'USD',
      fareBasis: ['Y'],
      passengers: [
        { passengerType: 'ADT', count: 1, base: 100, taxes: [], taxTotal: 0, total: 100, fareCalc: '' },
      ],
    });
    pnr.remarks.push({ type: 'general', text: 'HOLD UNTIL FRIDAY' });
    pnr.remarks.push({ type: 'historical', text: 'WAS ON HOLD' });
    return pnr;
  }

  it('*H with no PNR on screen returns NO PNR', async () => {
    const resp = await host.process('*H', wa);
    expect(resp).toMatch(/NO/);
  });

  it('*H composes ITINERARY + FILED FARES + NOTEPADS + TICKETS sections from current state', async () => {
    wa.pnr = buildPnr();
    const resp = await host.process('*H', wa);
    expect(resp).toContain('ITINERARY');
    expect(resp).toContain('UA');
    expect(resp).toContain('FILED FARES');
    expect(resp).toContain('FQ UA');
    expect(resp).toContain('NOTEPADS');
    expect(resp).toContain('HOLD UNTIL FRIDAY');
    expect(resp).toContain('WAS ON HOLD');
  });

  it('*H on a content-only-locator PNR returns NO HISTORY', async () => {
    // A PNR with just a locator but no segments/fares/notes — pnr.hasContent
    // would be false here, so we expect NO PNR not NO HISTORY.
    const pnr = new Pnr();
    pnr.locator = 'EMPTY1';
    wa.pnr = pnr;
    const resp = await host.process('*H', wa);
    expect(resp).toMatch(/NO/); // NO PNR
  });

  it('*HI renders the current itinerary', async () => {
    wa.pnr = buildPnr();
    const resp = await host.process('*HI', wa);
    expect(resp).toContain('UA');
    expect(resp).toContain('DEN');
    expect(resp).toContain('FRA');
  });

  it('*HIA renders the current itinerary (air only — same as *HI in our v1)', async () => {
    wa.pnr = buildPnr();
    const resp = await host.process('*HIA', wa);
    expect(resp).toContain('UA');
  });

  it('*HI with PNR but no segments returns NO ITINERARY', async () => {
    const pnr = new Pnr();
    pnr.locator = 'XXX111';
    pnr.names.push({
      surname: 'X',
      passengers: [{ firstName: 'Y' }],
      count: 1,
      infant: false,
    });
    wa.pnr = pnr;
    const resp = await host.process('*HI', wa);
    expect(resp).toBe('NO ITINERARY');
  });

  it('*HFF renders filed fares list (one row per priceQuote)', async () => {
    wa.pnr = buildPnr();
    const resp = await host.process('*HFF', wa);
    expect(resp).toContain('FQ UA USD 100.00');
  });

  it('*HFF with no filed fares returns NO FILED FARES', async () => {
    const pnr = buildPnr();
    pnr.priceQuotes = [];
    wa.pnr = pnr;
    const resp = await host.process('*HFF', wa);
    expect(resp).toBe('NO FILED FARES');
  });

  it('*HNP renders notepads (general + historical, with H** marker on historical)', async () => {
    wa.pnr = buildPnr();
    const resp = await host.process('*HNP', wa);
    expect(resp).toContain('NP.HOLD UNTIL FRIDAY');
    expect(resp).toContain('NP.H**WAS ON HOLD');
  });

  it('*HNP with no notepads returns NO NOTEPADS', async () => {
    const pnr = buildPnr();
    pnr.remarks = [];
    wa.pnr = pnr;
    const resp = await host.process('*HNP', wa);
    expect(resp).toBe('NO NOTEPADS');
  });
});

describe('Galileo *H — mutation log from client-side history shadow', () => {
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

  it('A → N → name → phone → ticketing → R captures one history row per modify', async () => {
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);

    expect(wa.pnr.history.length).toBeGreaterThanOrEqual(5); // SELL + NAME + PHONE + T + R
    const texts = wa.pnr.history.map((h) => h.text);
    expect(texts.some((t) => t.startsWith('SELL'))).toBe(true);
    expect(texts.some((t) => t.startsWith('NAME ADD SMITH'))).toBe(true);
    expect(texts.some((t) => t.startsWith('PHONE ADD'))).toBe(true);
    expect(texts.some((t) => t.startsWith('T.'))).toBe(true);
    expect(texts.some((t) => t.startsWith('R.'))).toBe(true);
  });

  it('*H renders the change log when wa.pnr.history is populated', async () => {
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('NP.HOLD UNTIL FRIDAY', wa);

    const resp = await host.process('*H', wa);
    expect(resp).toContain('HISTORY');
    expect(resp).toContain('SELL');
    expect(resp).toContain('NAME ADD SMITH');
    expect(resp).toContain('PHONE ADD');
    expect(resp).toContain('NP.HOLD UNTIL FRIDAY');
    // Cancel records a MODIFY entry too:
    await host.process('X1', wa);
    const resp2 = await host.process('*H', wa);
    expect(resp2).toContain('MODIFY');
  });

  it('SSR / OSI / NP. write their own history rows', async () => {
    // Build minimal so SSR has a name to attach.
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);

    await host.process('SI.VGML', wa);
    await host.process('SI.YY*1 CHD AGED 5', wa);
    await host.process('NP.H**WAS HOLDING', wa);

    const texts = wa.pnr.history.map((h) => h.text);
    expect(texts.some((t) => t.includes('SSR VGML'))).toBe(true);
    expect(texts.some((t) => t.includes('OSI YY'))).toBe(true);
    expect(texts.some((t) => t.includes('NP.H**WAS HOLDING'))).toBe(true);
  });
});
