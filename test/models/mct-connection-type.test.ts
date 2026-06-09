/**
 * Chunk 28 — connection-type inference + layered MCT in the
 * auto-connect builder.
 *
 * Closes the two scope-notes deferred from chunk 26:
 *   1. DD/DI/ID/II inference from airport country tags (was: DMI
 *      hard-coded DD)
 *   2. connectionsFor() resolving the hub MCT through the layered
 *      model with leg-carrier context (was: flat 45 constant)
 */

import { describe, it, expect } from 'vitest';
import {
  airportCountry,
  isDomesticLeg,
  connectionTypeFor,
} from '../../src/models/mct.js';
import { Inventory } from '../../src/store/inventory.js';

describe('airportCountry + isDomesticLeg', () => {
  it('maps seed airports to countries', () => {
    expect(airportCountry('JFK')).toBe('US');
    expect(airportCountry('LHR')).toBe('GB');
    expect(airportCountry('FRA')).toBe('DE');
    expect(airportCountry('KEF')).toBe('IS');
    expect(airportCountry('ZRH')).toBe('CH');
  });

  it('unknown airports default to US (preserves the chunk 26 DD default)', () => {
    expect(airportCountry('XYZ')).toBe('US');
  });

  it('JFK→LAX is domestic; DFW→LHR is not; ZRH→GVA is domestic (CH)', () => {
    expect(isDomesticLeg('JFK', 'LAX')).toBe(true);
    expect(isDomesticLeg('DFW', 'LHR')).toBe(false);
    expect(isDomesticLeg('ZRH', 'GVA')).toBe(true);
  });
});

describe('connectionTypeFor', () => {
  const leg = (origin: string, destination: string) => ({ origin, destination });

  it('domestic→domestic = DD', () => {
    expect(connectionTypeFor(leg('JFK', 'ORD'), leg('ORD', 'SFO'))).toBe('DD');
  });

  it('domestic→international = DI', () => {
    expect(connectionTypeFor(leg('JFK', 'ORD'), leg('ORD', 'FRA'))).toBe('DI');
  });

  it('international→domestic = ID', () => {
    expect(connectionTypeFor(leg('LHR', 'JFK'), leg('JFK', 'LAX'))).toBe('ID');
  });

  it('international→international = II', () => {
    expect(connectionTypeFor(leg('DEN', 'KEF'), leg('KEF', 'FRA'))).toBe('II');
  });
});

describe('auto-connect builder resolves the layered MCT', () => {
  it('existing connections still build (hubs ORD/DEN/KEF are unseeded → 45 fallback)', () => {
    const inv = new Inventory();
    // JFK→SFO connects via ORD and DEN; both unseeded so behavior is
    // identical to the pre-chunk-28 flat constant.
    const lines = inv.availability('15JUL', { letter: 'W', num: 3 }, 'JFK', 'SFO');
    const connections = lines.filter((l) => l.connectionGroup != null);
    expect(connections.length).toBeGreaterThan(0);
  });

  it('DEN→FRA via KEF still builds (II at unseeded KEF → 45 fallback)', () => {
    const inv = new Inventory();
    const lines = inv.availability('27JUN', { letter: 'S', num: 6 }, 'DEN', 'FRA');
    const connections = lines.filter((l) => l.connectionGroup != null);
    expect(connections.length).toBeGreaterThan(0);
  });
});
