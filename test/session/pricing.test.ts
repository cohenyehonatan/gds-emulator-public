import { describe, it, expect, beforeEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';
import { priceItinerary } from '../../src/session/handlers/pricing-handler.js';
import { fareFor } from '../../src/store/tariff.js';

describe('fare engine', () => {
  it('prices a market/class from the tariff', () => {
    const y = fareFor('JFK', 'LAX', 'Y');
    expect(y.base).toBe(245);
    expect(y.fareBasis).toBe('Y14');
    const f = fareFor('JFK', 'LAX', 'F'); // premium multiplier
    expect(f.base).toBeGreaterThan(y.base);
  });
});

describe('WP pricing', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*4321', wa);
  });

  function bookRoundTrip(): void {
    host.process('115JUNJFKLAX', wa);
    host.process('01Y2', wa); // AA 100 Y (market base 245)
    host.process('120JUNLAXJFK', wa);
    host.process('01Y1', wa); // DL 422 Y
  }

  it('prices the itinerary as booked with base + taxes + total', () => {
    bookRoundTrip();
    host.process('-SMITH/JOHN MR', wa);
    const resp = host.process('WP', wa);
    expect(resp).toContain('BASE FARE');
    expect(resp).toContain('USD490.00'); // 245 + 245
    expect(resp).toContain('ADT');
    expect(resp).toContain('VALIDATING CARRIER - AA');

    const adt = wa.lastPricing!.passengers[0];
    expect(adt.base).toBe(490);
    expect(adt.total).toBe(adt.base + adt.taxTotal);
    expect(wa.lastPricing!.fareBasis).toEqual(['Y14', 'Y14']);
  });

  it('counts seat-occupying passengers (ignores infants)', () => {
    bookRoundTrip();
    host.process('-SMITH/JOHN MR', wa);
    host.process('-I/SMITH/BABY', wa);
    expect(priceItinerary(wa.pnr)!.passengers[0].count).toBe(1);
  });

  it('prices multiple passenger types with WPP (child + infant discounts)', () => {
    bookRoundTrip();
    const resp = host.process('WPPADT/C05/INF', wa);
    const types = wa.lastPricing!.passengers;
    expect(types.map((p) => p.passengerType)).toEqual(['ADT', 'C05', 'INF']);
    expect(types[1].base).toBe(367.5); // child = 75% of 490
    expect(types[2].base).toBe(49); // infant = 10% of 490
    expect(resp).toContain('C05');
    expect(resp).toContain('INF');
  });

  it('prices a subset of segments with WPS', () => {
    bookRoundTrip(); // two segments
    host.process('WPS1', wa); // first segment only
    expect(wa.lastPricing!.fareBasis).toEqual(['Y14']);
    expect(wa.lastPricing!.passengers[0].base).toBe(245);
  });

  it('rejects WPS for a non-existent segment', () => {
    bookRoundTrip();
    expect(host.process('WPS9', wa)).toContain('SEGMENT');
  });

  it('stores the last quote as a PQ record (PQ) and displays it (*PQ)', () => {
    bookRoundTrip();
    host.process('-SMITH/JOHN MR', wa);
    host.process('WP', wa);
    const stored = host.process('PQ', wa);
    expect(stored).toContain('PRICE QUOTE RECORD RETAINED');
    expect(stored).toContain('PQ 1');
    expect(wa.pnr.priceQuotes).toHaveLength(1);
    expect(host.process('*PQ', wa)).toContain('PQ 1');
    expect(host.process('*PQ1', wa)).toContain('VALIDATING CARRIER');
  });

  it('prices and stores in one entry with WPRQ', () => {
    bookRoundTrip();
    const resp = host.process('WPRQ', wa);
    expect(resp).toContain('PRICE QUOTE RECORD RETAINED');
    expect(wa.pnr.priceQuotes).toHaveLength(1);
  });

  it('creates one PQ record per passenger type', () => {
    bookRoundTrip();
    host.process('WPPADT/C05/INF', wa);
    host.process('PQ', wa);
    expect(wa.pnr.priceQuotes).toHaveLength(3); // ADT, C05, INF
    expect(host.process('*PQ2', wa)).toContain('C05');
  });

  it('rejects PQ with nothing priced, and *PQ with no records', () => {
    bookRoundTrip();
    expect(host.process('PQ', wa)).toContain('NO PRICING TO STORE');
    expect(host.process('*PQ', wa)).toContain('NO PQ RECORDS');
  });

  it('includes a fare-calculation line in the quote and shows it via WPDF', () => {
    bookRoundTrip();
    const wp = host.process('WP', wa);
    expect(wp).toContain('JFK AA LAX245.00Y14 DL JFK245.00Y14 490.00 END');
    const df = host.process('WPDF', wa);
    expect(df).toContain('FARE CALCULATION');
    expect(df).toContain('ADT  JFK AA LAX245.00Y14 DL JFK245.00Y14 490.00 END');
  });

  it('WPDF<n> selects a passenger-type fare-calc line', () => {
    bookRoundTrip();
    host.process('WPPADT/C05', wa);
    const df = host.process('WPDF2', wa); // C05 line (child, 75%)
    expect(df).toContain('C05  JFK AA LAX183.75'); // 245 * 0.75
  });

  it('rejects WPDF with nothing priced', () => {
    bookRoundTrip();
    expect(host.process('WPDF', wa)).toContain('NO PRICING TO DISPLAY');
  });

  it('redisplays the last quote with WP*', () => {
    bookRoundTrip();
    const first = host.process('WP', wa);
    expect(host.process('WP*', wa)).toBe(first);
  });

  it('rejects WP with no itinerary, and WP* with nothing priced', () => {
    expect(host.process('WP', wa)).toContain('NO ITINERARY');
    expect(host.process('WP*', wa)).toContain('NO PRICING');
  });

  it('rejects an unsupported pricing format (until later commits)', () => {
    bookRoundTrip();
    expect(host.process('WPXP', wa)).toBe('FORMAT'); // exclude-penalty qualifier not modeled
  });

  it('WPA overrides the validating carrier; WPM sets the currency label', () => {
    bookRoundTrip();
    host.process('WPALH', wa);
    expect(wa.lastPricing!.validatingCarrier).toBe('LH');
    host.process('WPMEUR', wa);
    expect(wa.lastPricing!.currency).toBe('EUR');
  });

  it('WPTN exempts all taxes; WPTE exempts taxes but keeps fees', () => {
    bookRoundTrip();
    host.process('WPTN', wa);
    expect(wa.lastPricing!.passengers[0].taxTotal).toBe(0);
    host.process('WPTE', wa);
    expect(wa.lastPricing!.passengers[0].taxes.map((t) => t.code)).toEqual(['XF', 'AY']);
  });

  it('¥N prices a single named passenger', () => {
    host.process('115JUNJFKLAX', wa);
    host.process('02Y1', wa); // 2 seats
    host.process('-SMITH/JOHN MR', wa);
    host.process('-JONES/MARY MS', wa);
    host.process('WP¥N1.1', wa);
    expect(wa.lastPricing!.passengers[0].count).toBe(1);
  });

  it('combines qualifiers with ¥ (segment + currency)', () => {
    bookRoundTrip();
    host.process('WP¥S1¥MGBP', wa);
    expect(wa.lastPricing!.fareBasis).toHaveLength(1); // one segment priced
    expect(wa.lastPricing!.currency).toBe('GBP');
  });
});

describe('bargain finder (WPNC family)', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*4321', wa);
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa); // AA 100 Y (M is cheaper and available)
  });

  it('WPNC advises a cheaper available class without changing the PNR', () => {
    const resp = host.process('WPNC', wa);
    expect(resp).toContain('REBOOK');
    expect(resp).toContain('Y TO M'); // M is the cheapest available class on AA100
    expect(wa.pnr.segments[0].bookingClass).toBe('Y'); // PNR untouched
    expect(wa.lastPricing!.passengers[0].base).toBeLessThan(245); // cheaper than the Y fare
  });

  it('WPNCS ignores availability and finds the globally cheapest class', () => {
    const resp = host.process('WPNCS', wa);
    expect(resp).toContain('Y TO V'); // V has the lowest multiplier in the tariff
    expect(wa.pnr.segments[0].bookingClass).toBe('Y'); // still advisory only
  });

  it('WPNCB rebooks the class in the PNR', () => {
    const resp = host.process('WPNCB', wa);
    expect(resp).toContain('REBOOKED');
    expect(wa.pnr.segments[0].bookingClass).toBe('M');
    // a second WPNCB finds nothing cheaper available
    expect(host.process('WPNCB', wa)).toContain('LOWEST AVAILABLE');
  });
});
