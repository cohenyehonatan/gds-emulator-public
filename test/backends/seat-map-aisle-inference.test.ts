/**
 * Tests for the aisle-position inference in `mapSeatAvailabilities`.
 *
 * The mapper has to derive `Cabin.aisleAfterColumn` from Travelport's
 * Layout block alone (the response doesn't include explicit aisle
 * markers). Two signals are available — letter gaps in the column
 * sequence + consecutive position-`A` columns — and each is reliable
 * for different cabin types. The two-pass algorithm (see
 * `inferAisleAfterColumn` in travelport-mapper.ts) gets all four
 * common layouts right.
 */

import { describe, it, expect } from 'vitest';
import { mapSeatAvailabilities } from '../../src/backends/travelport-mapper.js';

/** Build a one-cabin Travelport-shape response with a given Layout block. */
function makeResponse(cabin: {
  name: string;
  layout: Array<{ startRow?: number; endRow?: number; position?: string[]; value?: string }>;
}) {
  return {
    CatalogOfferingsAncillaryListResponse: {
      CatalogOfferingsID: [
        {
          Flight: [{ carrier: 'XX', number: '1', equipment: 'TEST' }],
          CatalogOffering: [
            {
              ProductOptions: [
                {
                  Product: [
                    {
                      SeatAvailability: [],
                      SeatingChartRef: 'chart_1',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      ReferenceList: [
        {
          SeatingChart: [
            {
              id: 'chart_1',
              Cabin: [
                {
                  name: cabin.name,
                  Layout: cabin.layout,
                  Row: [],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

describe('aisle inference — letter-gap + consecutive-A two-pass algorithm', () => {
  it('3-3 narrow-body (ABCDEF, no skip) → C-D via Pass 2 consecutive-A', () => {
    const resp = makeResponse({
      name: 'ECONOMY',
      layout: [
        { startRow: 1, endRow: 30 },
        { position: ['W'], value: 'A' },
        { position: ['M'], value: 'B' },
        { position: ['A'], value: 'C' },
        { position: ['A'], value: 'D' },
        { position: ['M'], value: 'E' },
        { position: ['W'], value: 'F' },
      ],
    });
    const mapped = mapSeatAvailabilities(resp);
    expect(mapped!.seatMap.Cabin[0].aisleAfterColumn).toEqual(['C']);
  });

  it('2-4-2 wide-body (ABDEFGKL, skip C+HIJ) → B and G via Pass 1', () => {
    const resp = makeResponse({
      name: 'FIRST',
      layout: [
        { startRow: 1, endRow: 4 },
        { position: ['W'], value: 'A' },
        { position: ['A'], value: 'B' },
        { position: ['A'], value: 'D' },
        { position: ['C'], value: 'E' },
        { position: ['C'], value: 'F' },
        { position: ['A'], value: 'G' },
        { position: ['A'], value: 'K' },
        { position: ['W'], value: 'L' },
      ],
    });
    const mapped = mapSeatAvailabilities(resp);
    expect(mapped!.seatMap.Cabin[0].aisleAfterColumn).toEqual(['B', 'G']);
  });

  it('2-2-2 wide-body (ABDEGH, skip C+F) → B and E via Pass 1; NOT D (no false positive)', () => {
    // The critical case: positions W A A A A W. Without Pass 1's
    // letter-gap test the consecutive-A heuristic would mark D as an
    // aisle too (D and E are both A) — wrong.
    const resp = makeResponse({
      name: 'BUSINESS',
      layout: [
        { startRow: 1, endRow: 4 },
        { position: ['W'], value: 'A' },
        { position: ['A'], value: 'B' },
        { position: ['A'], value: 'D' },
        { position: ['A'], value: 'E' },
        { position: ['A'], value: 'G' },
        { position: ['W'], value: 'H' },
      ],
    });
    const mapped = mapSeatAvailabilities(resp);
    expect(mapped!.seatMap.Cabin[0].aisleAfterColumn).toEqual(['B', 'E']);
    // Explicit no-false-positive check.
    expect(mapped!.seatMap.Cabin[0].aisleAfterColumn).not.toContain('D');
  });

  it('3-3-3 wide-body (ABCDEFGHJ, skip I) → C and F via Pass 2; NOT H (cosmetic skip not aisle)', () => {
    // The other critical case: H→J letter gap exists but H=M and J=W
    // (not both A), so Pass 1 doesn't count it as a "real" gap. Pass 2
    // then fires for C-D and F-G (both consecutive-A pairs in the
    // 3-3-3 standard pattern).
    const resp = makeResponse({
      name: 'ECONOMY',
      layout: [
        { startRow: 14, endRow: 40 },
        { position: ['W'], value: 'A' },
        { position: ['M'], value: 'B' },
        { position: ['A'], value: 'C' },
        { position: ['A'], value: 'D' },
        { position: ['M'], value: 'E' },
        { position: ['A'], value: 'F' },
        { position: ['A'], value: 'G' },
        { position: ['M'], value: 'H' },
        { position: ['W'], value: 'J' },
      ],
    });
    const mapped = mapSeatAvailabilities(resp);
    expect(mapped!.seatMap.Cabin[0].aisleAfterColumn).toEqual(['C', 'F']);
    expect(mapped!.seatMap.Cabin[0].aisleAfterColumn).not.toContain('H');
  });

  it('2-2 narrow-body first (ABDE, skip C) → B via Pass 1', () => {
    const resp = makeResponse({
      name: 'FIRST',
      layout: [
        { startRow: 1, endRow: 3 },
        { position: ['W'], value: 'A' },
        { position: ['A'], value: 'B' },
        { position: ['A'], value: 'D' },
        { position: ['W'], value: 'E' },
      ],
    });
    const mapped = mapSeatAvailabilities(resp);
    expect(mapped!.seatMap.Cabin[0].aisleAfterColumn).toEqual(['B']);
  });

  it('layout with no aisles (impossible but defensive: pure window) → empty', () => {
    const resp = makeResponse({
      name: 'X',
      layout: [
        { startRow: 1, endRow: 1 },
        { position: ['W'], value: 'A' },
        { position: ['W'], value: 'B' },
      ],
    });
    const mapped = mapSeatAvailabilities(resp);
    expect(mapped!.seatMap.Cabin[0].aisleAfterColumn).toEqual([]);
  });
});
