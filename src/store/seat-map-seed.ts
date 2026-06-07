/**
 * Per-equipment seat-map seed data.
 *
 * Covers every equipment code in `src/store/inventory.ts` SCHEDULE
 * as of chunk 1: 32A, 32B, 320, 738, 739, 752, 76W, 75W, 777, 7M9.
 * Adding a new equipment code to SCHEDULE means adding a layout
 * here; `Inventory.seatMapFor` returns undefined for unseeded
 * equipment, which mocked tests should catch.
 *
 * Layouts are illustrative-realistic — narrow-body 3-3 with optional
 * 2-2 first, twin-aisle 2-2-2 first/business + 2-3-2 or 3-3-3
 * economy. Exit-row positions roughly match real configurations but
 * aren't audited against per-airline cabin charts (chunk 1 doesn't
 * model fleet-specific variations). The chunk-2 renderer + chunk-1
 * synthesizer don't depend on cabin-specific accuracy — only on the
 * structural shape being consistent.
 */

import type { Cabin, CabinLayoutEntry, SeatRow, SeatSpace } from '../models/seat-map.js';

/**
 * Build a single narrow-body cabin (3-3 economy or 2-2 first).
 *
 * `pattern` is a column spec like 'WA-AW' where each letter is a
 * column and `-` marks an aisle gap. Letter assignment is left-to-
 * right starting at the first ASCII letter pair (A, B, then skip aisle,
 * C, D, ...); we use canonical A B [aisle] C D for 2-2, A B C [aisle]
 * D E F for 3-3.
 *
 * Exit rows get an E Characteristic on every seat in that row;
 * bulkhead rows (the first row of a cabin) get K.
 */
function makeCabin(
  name: string,
  fromRow: number,
  toRow: number,
  pattern: 'F22' | 'Y33' | 'J222' | 'Y232' | 'Y333',
  exitRows: number[] = [],
): Cabin {
  const layouts: Record<string, { columns: string[]; aisleAfter: number[] }> = {
    F22:  { columns: ['A', 'B', 'C', 'D'], aisleAfter: [1] }, // A B | C D
    Y33:  { columns: ['A', 'B', 'C', 'D', 'E', 'F'], aisleAfter: [2] }, // ABC|DEF
    J222: { columns: ['A', 'B', 'C', 'D', 'E', 'F'], aisleAfter: [1, 3] }, // AB|CD|EF
    Y232: { columns: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], aisleAfter: [1, 4] }, // AB|CDE|FG
    Y333: { columns: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J'], aisleAfter: [2, 5] }, // ABC|DEF|GHJ
  };
  const spec = layouts[pattern];
  const Layout: CabinLayoutEntry[] = [{ startRow: fromRow, endRow: toRow }];
  // Column position: first column is W, last is W, columns adjacent
  // to an aisle gap are A (Aisle), everything else is M (Middle/Center).
  for (let i = 0; i < spec.columns.length; i++) {
    const letter = spec.columns[i];
    const isWindow = i === 0 || i === spec.columns.length - 1;
    const isAisle = spec.aisleAfter.includes(i) || spec.aisleAfter.includes(i - 1);
    const position = isWindow ? ['W'] : isAisle ? ['A'] : ['C'];
    Layout.push({ position, value: letter });
  }
  const Row: SeatRow[] = [];
  for (let r = fromRow; r <= toRow; r++) {
    const Space: SeatSpace[] = spec.columns.map((letter, i) => {
      const characteristic: string[] = [];
      const isWindow = i === 0 || i === spec.columns.length - 1;
      const isAisle = spec.aisleAfter.includes(i) || spec.aisleAfter.includes(i - 1);
      if (isWindow) characteristic.push('W');
      if (isAisle) characteristic.push('A');
      if (r === fromRow) characteristic.push('K'); // bulkhead
      if (exitRows.includes(r)) characteristic.push('E');
      return { location: letter, Characteristic: characteristic };
    });
    Row.push({ label: String(r), Space });
  }
  return { name, Layout, Row };
}

/** A320 standard / sharklets / alt — all-Y narrow body, 30 rows. */
const A320_STD: Cabin[] = [
  makeCabin('ECONOMY', 1, 30, 'Y33', [11, 12]),
];

/** A320 with small first cabin (CityHopper-style). */
const A320_F: Cabin[] = [
  makeCabin('FIRST', 1, 3, 'F22'),
  makeCabin('ECONOMY', 4, 30, 'Y33', [12, 13]),
];

/** 737-800. */
const B737800: Cabin[] = [
  makeCabin('FIRST', 1, 3, 'F22'),
  makeCabin('ECONOMY', 4, 31, 'Y33', [12, 14]),
];

/** 737-900. */
const B737900: Cabin[] = [
  makeCabin('FIRST', 1, 3, 'F22'),
  makeCabin('ECONOMY', 4, 37, 'Y33', [12, 14]),
];

/** 737 MAX 9. */
const B737M9: Cabin[] = [
  makeCabin('FIRST', 1, 3, 'F22'),
  makeCabin('ECONOMY', 4, 38, 'Y33', [12, 16]),
];

/** 757-200. */
const B757200: Cabin[] = [
  makeCabin('FIRST', 1, 4, 'F22'),
  makeCabin('ECONOMY', 5, 31, 'Y33', [10, 18]),
];

/** 757-300 (long-haul winglet variant). */
const B757300: Cabin[] = [
  makeCabin('FIRST', 1, 4, 'F22'),
  makeCabin('ECONOMY', 5, 38, 'Y33', [12, 22]),
];

/** 767-300ER — 2-2-2 in F/J, 2-3-2 in Y. */
const B767300: Cabin[] = [
  makeCabin('FIRST', 1, 4, 'J222'),
  makeCabin('BUSINESS', 5, 12, 'J222'),
  makeCabin('ECONOMY', 14, 30, 'Y232', [14, 22]),
];

/** 777-200 — 2-2-2 in F/J, 3-3-3 in Y. */
const B777: Cabin[] = [
  makeCabin('FIRST', 1, 4, 'J222'),
  makeCabin('BUSINESS', 5, 12, 'J222'),
  makeCabin('ECONOMY', 14, 40, 'Y333', [14, 27]),
];

export const SEAT_MAP_SEED: Record<string, Cabin[]> = {
  '320': A320_STD,
  '32A': A320_STD,
  '32B': A320_F,
  '738': B737800,
  '739': B737900,
  '7M9': B737M9,
  '752': B757200,
  '75W': B757300,
  '76W': B767300,
  '777': B777,
};
