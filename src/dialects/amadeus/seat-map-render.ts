/**
 * Render a SeatMap for the Amadeus `SM` family.
 *
 * Targets the ASCII anchor pinned in `docs/seatmap-design.md` chunk 2,
 * with one structural revision discovered during chunk 2 visual review:
 * **render each cabin with its own column header + aisle positions**,
 * not a merged-superset header across cabins. Cabins on the same
 * aircraft can have very different layouts (777 F is 2-2-2 / 6 cols,
 * Y is 3-3-3 / 9 cols), and a shared header forces an aisle-position
 * compromise that misaligns one of them.
 *
 * Per-cabin format:
 *
 *   FIRST     A  B    D  E    G  H
 *     1 W  A    A  A    A  W
 *     2 W  A    A  A    A  W
 *     ...
 *
 *   ECONOMY   A  B  C    D  E  F    G  H  J
 *    14 E  E  E    E  E  E    E  E  E
 *    15 W  .  A    A  .  A    A  .  W
 *     ...
 *
 * Column header drawn from each cabin's own column letters + aisle
 * positions (from `Cabin.aisleAfterColumn`). Per-cell precedence (per
 * the design-doc anchor):
 *   no-seat SCC (LA/GN/...) → blank
 *   exit (E) → E
 *   window (W) → W
 *   aisle (A) → A
 *   middle (M) → M
 *   handicapped (H) → H
 *   status glyph (./X/-/space)
 *
 * K (bulkhead) intentionally not in the per-cell priority — the cabin
 * label already marks the boundary, so per-cell K is visual noise.
 *
 * `/V` (default) renders rows top-to-bottom; `/H` transposes per cabin.
 */

import type {
  Cabin,
  SeatAvailabilityList,
  SeatAvailabilityStatus,
  SeatMap,
  SeatSpace,
} from '../../models/seat-map.js';
import { STATUS_GLYPHS } from '../../models/seat-map.js';
import type { AirSegment } from '../../models/segment.js';

export type RenderOrientation = 'V' | 'H';

const NO_SEAT_CHARACTERISTICS: ReadonlySet<string> = new Set([
  'LA', 'GN', 'SO', 'ST', 'TA', 'CL', 'KN', 'D', 'EX', '8',
]);

const POSITION_PRIORITY: ReadonlyArray<string> = ['E', 'W', 'A', 'M', 'H'];

const CABIN_LETTER: Record<string, string> = {
  FIRST: 'F',
  BUSINESS: 'J',
  ECONOMY: 'Y',
  PREMIUM: 'W',
};

function cabinLetter(name: string): string {
  return CABIN_LETTER[name.toUpperCase()] ?? name.charAt(0).toUpperCase();
}

export function renderSeatMap(
  seatMap: SeatMap,
  availability: SeatAvailabilityList[],
  segment: AirSegment,
  segmentNumber: number,
  orientation: RenderOrientation = 'V',
): string {
  const header = `SM ${segmentNumber} — ${seatMap.carrier}${seatMap.flightNumber} ${segment.date} ${segment.origin}-${segment.destination} — ${seatMap.equipment}`;
  const statusByLabel = new Map<string, SeatAvailabilityStatus>();
  for (const bucket of availability) {
    const status = bucket.seatAvailabilityStatus as SeatAvailabilityStatus;
    for (const label of bucket.value) statusByLabel.set(label, status);
  }
  const sections: string[] = [];
  for (const cabin of seatMap.Cabin) {
    sections.push('');
    sections.push(...renderCabin(cabin, statusByLabel, orientation));
  }
  return [header, ...sections, '', renderLegend()].join('\n');
}

function renderCabin(
  cabin: Cabin,
  statusByLabel: Map<string, SeatAvailabilityStatus>,
  orientation: RenderOrientation,
): string[] {
  const columns = cabin.Layout
    .filter((e) => e.value)
    .map((e) => e.value!);
  const aisleAfter = cabin.aisleAfterColumn ?? [];
  if (orientation === 'H') return renderHorizontal(cabin, columns, aisleAfter, statusByLabel);

  const lines: string[] = [];
  const cabinLabel = `${cabin.name} (${cabinLetter(cabin.name)})`;
  const headerCols = formatRow(columns, columns, aisleAfter);
  // Column-position math: header letter lands at col `cabin_pad + 2`;
  // row data lands at col `row_pad + 6` (1 sigil + row_pad + 1 sep + 3
  // row label + 1 sep). For both to align: cabin_pad = row_pad + 4.
  // Bumping row labels right by 1 (row_pad 11 → 12) bumps cabin_pad
  // 14 → 16 to track. Exit-row indent matches the new data position.
  lines.push(` ${cabinLabel.padEnd(16)} ${headerCols}`);
  for (const row of cabin.Row) {
    const isExitRow = row.Space.some((s) => s.Characteristic?.includes('E'));
    if (isExitRow) lines.push(' '.repeat(17) + ' --- EXIT ROW ---');
    const seatChars = columns.map((col) => {
      const space = row.Space.find((s) => s.location === col);
      if (!space) return ' ';
      return renderSeat(`${row.label}${col}`, space, statusByLabel);
    });
    const seats = formatRow(columns, seatChars, aisleAfter);
    const rowLabel = row.label.padStart(3, ' ');
    lines.push(` ${' '.repeat(12)} ${rowLabel} ${seats}`);
  }
  return lines;
}

function renderHorizontal(
  cabin: Cabin,
  columns: string[],
  aisleAfter: string[],
  statusByLabel: Map<string, SeatAvailabilityStatus>,
): string[] {
  const lines: string[] = [];
  const cabinLabel = `${cabin.name} (${cabinLetter(cabin.name)})`;
  const headerRows = cabin.Row.map((r) => r.label.padStart(3, ' ')).join(' ');
  lines.push(` ${cabinLabel.padEnd(14)} ${headerRows}`);
  for (let ci = 0; ci < columns.length; ci++) {
    const col = columns[ci];
    const cells = cabin.Row.map((row) => {
      const space = row.Space.find((s) => s.location === col);
      if (!space) return '   ';
      return renderSeat(`${row.label}${col}`, space, statusByLabel).padStart(3, ' ');
    });
    lines.push(` ${' '.repeat(11)} ${col}   ${cells.join(' ')}`);
    // Blank line between aisle-separated column rows for visual gap.
    if (aisleAfter.includes(col) && ci < columns.length - 1) lines.push('');
  }
  return lines;
}

function renderSeat(
  label: string,
  space: SeatSpace,
  statusByLabel: Map<string, SeatAvailabilityStatus>,
): string {
  const chars = space.Characteristic ?? [];
  if (chars.some((c) => NO_SEAT_CHARACTERISTICS.has(c))) return ' ';
  for (const code of POSITION_PRIORITY) {
    if (chars.includes(code)) return code;
  }
  const status = statusByLabel.get(label);
  return status ? STATUS_GLYPHS[status] : '?';
}

/**
 * Render a row of cells with aisle gaps inserted after specified
 * columns. `columns` is the ordered column letters; `cells` is
 * parallel-indexed (same length, same order). Aisle gap goes after
 * any cell whose corresponding column letter is in `aisleAfter`.
 */
function formatRow(columns: string[], cells: string[], aisleAfter: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    parts.push(cells[i]);
    if (aisleAfter.includes(columns[i]) && i < cells.length - 1) {
      parts.push(' '); // extra gap marker — appears as a wider space
    }
  }
  return parts.join('  ');
}

function renderLegend(): string {
  return 'LEGEND: . avail  X reserved  - blocked   W window  A aisle  M middle  K bulkhead  E exit  H handicapped';
}
