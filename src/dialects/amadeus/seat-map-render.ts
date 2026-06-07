/**
 * Render a SeatMap for the Amadeus `SM` family.
 *
 * Targets the ASCII anchor pinned in `docs/seatmap-design.md` chunk 2:
 *
 *   SM 1 — UA2430 15JUL DEN-ORD — 777
 *        A  B    D  E  F  G    K  L
 *   F   1.W  .    .  .  .  .    .  W
 *   F   2.W  X    .  X  .  X    X  W
 *       3.W  .    A  .  .  A    .  W
 *       4.W  .    X  X  X  X    .  W
 *   --- EXIT ROW ---
 *   Y   5.W  .    .  .  .  .    .  W
 *   ...
 *
 * Cabin code shown only at the cabin's boundary row (blank for
 * subsequent rows in the same cabin). Per-seat character uses status
 * glyph unless the seat has a structural position SCC (W/A/M/K/E/H),
 * which takes precedence — chunk 2 anchor calls this out and the
 * `references/iata-padis-9825-seat-codes.md` renderer-glyph mapping
 * spells the precedence rule.
 *
 * Vertical (`/V`, default) renders rows top-to-bottom, columns left-
 * to-right with aisle gaps. Horizontal (`/H`) transposes — columns
 * top-to-bottom, rows left-to-right — useful when the seat map's
 * column count is small but row count is large.
 */

import type {
  Cabin,
  CabinLayoutEntry,
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

/**
 * Per-cell render priority for structural SCCs. Order matters: the
 * first match wins over the status glyph. K (bulkhead) is intentionally
 * omitted — the cabin-code prefix on the left margin already marks
 * cabin boundaries, so per-cell K is visual noise without information
 * (matches the doc's render anchor where row 1 shows status glyphs,
 * not K letters).
 */
const POSITION_PRIORITY: ReadonlyArray<string> = ['E', 'W', 'A', 'M', 'H'];

const CABIN_LETTER: Record<string, string> = {
  FIRST: 'F',
  BUSINESS: 'J',
  ECONOMY: 'Y',
  PREMIUM: 'W',
};

/** Map a cabin display name to its single-letter code. */
function cabinLetter(name: string): string {
  return CABIN_LETTER[name.toUpperCase()] ?? name.charAt(0).toUpperCase();
}

/**
 * Render the seat map in the orientation requested. Vertical is the
 * default Amadeus convention; horizontal transposes.
 */
export function renderSeatMap(
  seatMap: SeatMap,
  availability: SeatAvailabilityList[],
  segment: AirSegment,
  segmentNumber: number,
  orientation: RenderOrientation = 'V',
): string {
  const header = `SM ${segmentNumber} — ${seatMap.carrier}${seatMap.flightNumber} ${segment.date} ${segment.origin}-${segment.destination} — ${seatMap.equipment}`;
  // Build a per-seat status lookup keyed on seat label ("1A", "12C").
  const statusByLabel = new Map<string, SeatAvailabilityStatus>();
  for (const bucket of availability) {
    const status = bucket.seatAvailabilityStatus as SeatAvailabilityStatus;
    for (const label of bucket.value) statusByLabel.set(label, status);
  }
  const body = orientation === 'H'
    ? renderHorizontal(seatMap, statusByLabel)
    : renderVertical(seatMap, statusByLabel);
  const legend = renderLegend();
  return [header, ...body, '', legend].join('\n');
}

/** Vertical default: rows top-to-bottom, columns left-to-right. */
function renderVertical(
  seatMap: SeatMap,
  statusByLabel: Map<string, SeatAvailabilityStatus>,
): string[] {
  const lines: string[] = [];
  // Column header: drawn once from the first cabin's Layout (all cabins
  // typically share the same column letters; if they differ the chunk-2
  // renderer aligns by the widest cabin).
  const columnEntries = collectColumnEntries(seatMap.Cabin);
  const aisleAfter = computeAisleAfter(columnEntries);
  const headerCols = formatColumnRow(columnEntries.map((c) => c.value!), aisleAfter);
  lines.push(`     ${headerCols}`);
  for (const cabin of seatMap.Cabin) {
    const letter = cabinLetter(cabin.name);
    for (let i = 0; i < cabin.Row.length; i++) {
      const row = cabin.Row[i];
      const isExitRow = row.Space.some((s) => s.Characteristic?.includes('E'));
      const isCabinBoundary = i === 0;
      if (isExitRow) lines.push(' --- EXIT ROW ---');
      const cabinPrefix = isCabinBoundary ? letter : ' ';
      const seatChars = row.Space.map((space) => renderSeat(`${row.label}${space.location}`, space, statusByLabel));
      const seats = formatColumnRow(seatChars, aisleAfter);
      const rowLabel = row.label.padStart(2, ' ');
      lines.push(` ${cabinPrefix}  ${rowLabel} ${seats}`);
    }
  }
  return lines;
}

/** Horizontal transpose: columns top-to-bottom, rows left-to-right. */
function renderHorizontal(
  seatMap: SeatMap,
  statusByLabel: Map<string, SeatAvailabilityStatus>,
): string[] {
  const lines: string[] = [];
  const columnEntries = collectColumnEntries(seatMap.Cabin);
  // Row header along the top.
  const allRows: { row: string; cabin: string }[] = [];
  for (const cabin of seatMap.Cabin) {
    for (const r of cabin.Row) {
      allRows.push({ row: r.label, cabin: cabinLetter(cabin.name) });
    }
  }
  const headerRows = allRows.map((r) => r.row.padStart(3, ' ')).join(' ');
  lines.push(`     ${headerRows}`);
  // One line per column.
  for (const colEntry of columnEntries) {
    const colLetter = colEntry.value!;
    const cells: string[] = [];
    for (const { row } of allRows) {
      const space = findSpace(seatMap.Cabin, parseInt(row, 10), colLetter);
      if (!space) {
        cells.push('   ');
        continue;
      }
      cells.push(renderSeat(`${row}${colLetter}`, space, statusByLabel).padStart(3, ' '));
    }
    lines.push(` ${colLetter}   ${cells.join(' ')}`);
  }
  return lines;
}

/**
 * Pick the render character for a single seat. Priority: NoSeat
 * characteristics (LA/GN/...) → blank; structural position SCC (E
 * exit / K bulkhead / W window / A aisle / M middle / H handicapped)
 * → that letter; status glyph (./X/-/space).
 */
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

/** Find the Space for a (row, column) across all cabins. */
function findSpace(cabins: Cabin[], row: number, column: string): SeatSpace | undefined {
  for (const cabin of cabins) {
    const r = cabin.Row.find((rr) => rr.label === String(row));
    if (r) return r.Space.find((s) => s.location === column);
  }
  return undefined;
}

/**
 * Walk every cabin's Layout for column entries; merge into a single
 * ordered column list (later cabins may add new columns — wide-body
 * Y has more columns than narrow F).
 */
function collectColumnEntries(cabins: Cabin[]): CabinLayoutEntry[] {
  const seen = new Set<string>();
  const merged: CabinLayoutEntry[] = [];
  for (const cabin of cabins) {
    for (const entry of cabin.Layout) {
      if (entry.value && !seen.has(entry.value)) {
        seen.add(entry.value);
        merged.push(entry);
      }
    }
  }
  return merged;
}

/**
 * Identify aisle gaps: adjacent columns where the FIRST is positioned
 * 'A' (aisle) AND the SECOND is positioned 'A' indicates a cross-aisle
 * pair — the gap goes BETWEEN them.
 */
function computeAisleAfter(columns: CabinLayoutEntry[]): number[] {
  const gaps: number[] = [];
  for (let i = 0; i < columns.length - 1; i++) {
    const curIsAisle = columns[i].position?.includes('A') ?? false;
    const nextIsAisle = columns[i + 1].position?.includes('A') ?? false;
    if (curIsAisle && nextIsAisle) gaps.push(i);
  }
  return gaps;
}

/** Format a row of column cells with aisle gaps. */
function formatColumnRow(cells: string[], aisleAfter: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    parts.push(cells[i]);
    if (aisleAfter.includes(i)) parts.push(' '); // extra gap
  }
  return parts.join('  ');
}

function renderLegend(): string {
  return 'LEGEND: . avail  X reserved  - blocked   W window  A aisle  M middle  K bulkhead  E exit  H handicapped';
}
