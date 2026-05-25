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

    const fq = wa.lastPricing!;
    expect(fq.base).toBe(490);
    expect(fq.total).toBe(fq.base + fq.taxTotal);
    expect(fq.fareBasis).toEqual(['Y14', 'Y14']);
  });

  it('counts seat-occupying passengers (ignores infants)', () => {
    bookRoundTrip();
    host.process('-SMITH/JOHN MR', wa);
    host.process('-I/SMITH/BABY', wa);
    expect(priceItinerary(wa.pnr)!.passengerCount).toBe(1);
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
    expect(host.process('WPNCB', wa)).toBe('FORMAT');
  });
});
