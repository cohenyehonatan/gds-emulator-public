import { describe, it, expect } from 'vitest';
import { Inventory } from '../../src/store/inventory.js';
import { SEAT_MAP_SEED } from '../../src/store/seat-map-seed.js';
import {
  synthesizeAvailability,
  SCC_LABELS,
  STATUS_GLYPHS,
  type SeatAvailabilityStatus,
} from '../../src/models/seat-map.js';

describe('Inventory.seatMapFor', () => {
  it('returns a seat map for every equipment type in SCHEDULE', () => {
    const inv = new Inventory();
    // Every flight in SCHEDULE should resolve to a SeatMap via its equipment.
    const cases: Array<[string, string, string]> = [
      ['B6', '615', '32A'],
      ['AA', '100', '738'],
      ['UA', '240', '320'],
      ['AA', '180', '32B'],
      ['DL', '422', '76W'],
      ['BA', '192', '777'],
      ['AA', '300', '738'],
      ['AA', '350', '739'],
      ['UA', '500', '752'],
      ['UA', '550', '320'],
      ['FI', '670', '75W'],
      ['FI', '520', '7M9'],
    ];
    for (const [carrier, flight, expectedEq] of cases) {
      const sm = inv.seatMapFor(carrier, flight);
      expect(sm, `${carrier}${flight} should have a seat map`).toBeDefined();
      expect(sm!.equipment).toBe(expectedEq);
      expect(sm!.Cabin.length).toBeGreaterThan(0);
    }
  });

  it('returns undefined for a flight not in SCHEDULE', () => {
    const inv = new Inventory();
    expect(inv.seatMapFor('XX', '9999')).toBeUndefined();
  });

  it('returns undefined for an unseeded equipment when explicitly requested', () => {
    const inv = new Inventory();
    expect(inv.seatMapFor('AA', '100', 'UNKNOWN_EQUIP')).toBeUndefined();
  });

  it('equipment override beats the SCHEDULE equipment when both apply', () => {
    const inv = new Inventory();
    // AA100 normally maps to 738; override to 320.
    const sm = inv.seatMapFor('AA', '100', '320');
    expect(sm?.equipment).toBe('320');
  });
});

describe('Seat-map seed coverage', () => {
  it('seeds all 10 equipment codes present in SCHEDULE', () => {
    const expected = ['320', '32A', '32B', '738', '739', '7M9', '752', '75W', '76W', '777'];
    for (const eq of expected) {
      expect(SEAT_MAP_SEED[eq], `seed missing for ${eq}`).toBeDefined();
    }
  });

  it('every cabin has at least one Layout entry, one Row, and a non-empty name', () => {
    for (const [eq, cabins] of Object.entries(SEAT_MAP_SEED)) {
      for (const cabin of cabins) {
        expect(cabin.name.length, `${eq} ${cabin.name} name should be non-empty`).toBeGreaterThan(0);
        expect(cabin.Layout.length, `${eq} ${cabin.name} Layout should be non-empty`).toBeGreaterThan(0);
        expect(cabin.Row.length, `${eq} ${cabin.name} Row should be non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it('first Layout entry of every cabin is a row-range marker (startRow + endRow)', () => {
    for (const cabins of Object.values(SEAT_MAP_SEED)) {
      for (const cabin of cabins) {
        const first = cabin.Layout[0];
        expect(first.startRow).toBeDefined();
        expect(first.endRow).toBeDefined();
        expect(first.endRow!).toBeGreaterThanOrEqual(first.startRow!);
      }
    }
  });

  it('column-position markers use closed {W,A,C,M} set', () => {
    const allowed = new Set(['W', 'A', 'C', 'M']);
    for (const cabins of Object.values(SEAT_MAP_SEED)) {
      for (const cabin of cabins) {
        const cols = cabin.Layout.filter((l) => l.position);
        for (const col of cols) {
          for (const pos of col.position!) {
            expect(allowed.has(pos), `unexpected position ${pos}`).toBe(true);
          }
        }
      }
    }
  });

  it('row labels in a cabin match the Layout row-range bounds', () => {
    for (const [eq, cabins] of Object.entries(SEAT_MAP_SEED)) {
      for (const cabin of cabins) {
        const range = cabin.Layout[0];
        const labels = cabin.Row.map((r) => parseInt(r.label, 10));
        const min = Math.min(...labels);
        const max = Math.max(...labels);
        expect(min, `${eq} ${cabin.name} min row`).toBe(range.startRow);
        expect(max, `${eq} ${cabin.name} max row`).toBe(range.endRow);
      }
    }
  });

  it('exit rows have an E characteristic on every seat in that row', () => {
    const cabins = SEAT_MAP_SEED['738'];
    // 738 has exit rows at 12 and 14 per the seed.
    const econ = cabins.find((c) => c.name === 'ECONOMY')!;
    const row12 = econ.Row.find((r) => r.label === '12')!;
    for (const space of row12.Space) {
      expect(space.Characteristic).toContain('E');
    }
    const row14 = econ.Row.find((r) => r.label === '14')!;
    for (const space of row14.Space) {
      expect(space.Characteristic).toContain('E');
    }
  });

  it('first row of each cabin has the K (bulkhead) characteristic', () => {
    for (const [eq, cabins] of Object.entries(SEAT_MAP_SEED)) {
      for (const cabin of cabins) {
        const firstRow = cabin.Row[0];
        for (const space of firstRow.Space) {
          expect(
            space.Characteristic,
            `${eq} ${cabin.name} row ${firstRow.label} should have K`,
          ).toContain('K');
        }
      }
    }
  });

  it('window seats are labeled W; aisle seats are labeled A', () => {
    const cabin = SEAT_MAP_SEED['738'].find((c) => c.name === 'ECONOMY')!;
    // 738 Y is 3-3 (A B C | D E F): A and F are windows, C and D are aisles.
    const row5 = cabin.Row.find((r) => r.label === '5')!; // non-bulkhead, non-exit
    const seatA = row5.Space.find((s) => s.location === 'A')!;
    const seatF = row5.Space.find((s) => s.location === 'F')!;
    const seatC = row5.Space.find((s) => s.location === 'C')!;
    const seatD = row5.Space.find((s) => s.location === 'D')!;
    expect(seatA.Characteristic).toContain('W');
    expect(seatF.Characteristic).toContain('W');
    expect(seatC.Characteristic).toContain('A');
    expect(seatD.Characteristic).toContain('A');
  });
});

describe('synthesizeAvailability', () => {
  const inv = new Inventory();
  const sm = inv.seatMapFor('AA', '100')!; // 738

  it('is deterministic: same (locator, date, seatMap) → same output', () => {
    const a = synthesizeAvailability(sm, 'ABC123', '15JUL');
    const b = synthesizeAvailability(sm, 'ABC123', '15JUL');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different locators → different distributions', () => {
    const a = synthesizeAvailability(sm, 'AAA111', '15JUL');
    const b = synthesizeAvailability(sm, 'BBB222', '15JUL');
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('different dates → different distributions', () => {
    const a = synthesizeAvailability(sm, 'ABC123', '15JUL');
    const b = synthesizeAvailability(sm, 'ABC123', '16JUL');
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('every seat in the map appears exactly once across all status buckets', () => {
    const buckets = synthesizeAvailability(sm, 'XYZ999', '20AUG');
    const allSeats = new Set<string>();
    let total = 0;
    for (const b of buckets) {
      for (const s of b.value) {
        expect(allSeats.has(s), `duplicate seat ${s}`).toBe(false);
        allSeats.add(s);
        total++;
      }
    }
    // 738: 3 F rows × 4 + 28 Y rows × 6 = 12 + 168 = 180 seats
    expect(total).toBe(180);
  });

  it('only emits statuses from the closed enum', () => {
    const buckets = synthesizeAvailability(sm, 'XYZ999', '20AUG');
    const allowed = new Set<SeatAvailabilityStatus>([
      'Available', 'Reserved', 'Blocked', 'NoSeat', 'Unavailable',
    ]);
    for (const b of buckets) {
      expect(allowed.has(b.seatAvailabilityStatus as SeatAvailabilityStatus)).toBe(true);
    }
  });

  it('distribution roughly matches the documented mix', () => {
    // Sample across many flights to smooth the hash noise.
    const counts: Record<string, number> = {};
    let grand = 0;
    for (let i = 0; i < 50; i++) {
      const buckets = synthesizeAvailability(sm, `LOC${i.toString().padStart(3, '0')}`, '01JAN');
      for (const b of buckets) {
        counts[b.seatAvailabilityStatus] = (counts[b.seatAvailabilityStatus] ?? 0) + b.value.length;
        grand += b.value.length;
      }
    }
    const pct = (s: string) => (counts[s] ?? 0) / grand;
    // Target: 70/20/5/5 with looseness for hash variance.
    expect(pct('Available')).toBeGreaterThan(0.6);
    expect(pct('Available')).toBeLessThan(0.8);
    expect(pct('Reserved')).toBeGreaterThan(0.15);
    expect(pct('Reserved')).toBeLessThan(0.25);
    expect(pct('Blocked')).toBeGreaterThan(0.02);
    expect(pct('Blocked')).toBeLessThan(0.08);
  });

  it('seats with structural no-seat characteristic always return NoSeat', () => {
    // Synthesize a tiny map with a no-seat space and check the result.
    const mini = {
      carrier: 'XX',
      flightNumber: '1',
      equipment: 'TEST',
      Cabin: [{
        name: 'TEST',
        Layout: [{ startRow: 1, endRow: 1 }],
        Row: [{
          label: '1',
          Space: [
            { location: 'A', Characteristic: ['LA'] }, // lavatory
            { location: 'B', Characteristic: ['GN'] }, // galley
            { location: 'C', Characteristic: ['W'] },  // window seat
          ],
        }],
      }],
    };
    const buckets = synthesizeAvailability(mini, 'TEST', '01JAN');
    const noSeat = buckets.find((b) => b.seatAvailabilityStatus === 'NoSeat')?.value ?? [];
    expect(noSeat).toContain('1A');
    expect(noSeat).toContain('1B');
    // 1C is a normal window — depends on hash but shouldn't be NoSeat-only.
  });
});

describe('Renderer constants (SCC_LABELS + STATUS_GLYPHS)', () => {
  it('all PADIS 9825 position markers have labels', () => {
    expect(SCC_LABELS.W).toContain('Window');
    expect(SCC_LABELS.A).toContain('Aisle');
    expect(SCC_LABELS.K).toContain('Bulkhead');
    expect(SCC_LABELS.E).toContain('Exit');
  });

  it('all status codes have a renderer glyph', () => {
    expect(STATUS_GLYPHS.Available).toBe('.');
    expect(STATUS_GLYPHS.Reserved).toBe('X');
    expect(STATUS_GLYPHS.Blocked).toBe('-');
    expect(STATUS_GLYPHS.NoSeat).toBe(' ');
    expect(STATUS_GLYPHS.Unavailable).toBe('X');
  });
});
