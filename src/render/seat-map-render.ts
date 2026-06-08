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
} from '../models/seat-map.js';
import { STATUS_GLYPHS } from '../models/seat-map.js';
import type { AirSegment } from '../models/segment.js';

export type RenderOrientation = 'V' | 'H';

const NO_SEAT_CHARACTERISTICS: ReadonlySet<string> = new Set([
  'LA', 'GN', 'SO', 'ST', 'TA', 'CL', 'KN', 'D', 'EX', '8',
]);

const POSITION_PRIORITY: ReadonlyArray<string> = ['E', 'W', 'A', 'M', 'H'];

/**
 * Per-dialect glyph map. Lets each dialect override the per-cell
 * characters the renderer emits without forking the whole renderer.
 * See `docs/seatmap-output-parity.md` for the source convention each
 * map aligns to (or doesn't — Galileo has no public cryptic sample,
 * so its map is the cross-dialect default).
 *
 * Three presets exported below:
 *   GALILEO_GLYPHS — cross-dialect default; `.`=avail / `X`=reserved /
 *                    `-`=blocked / position SCC W/A/M/E/H per-cell.
 *   AMADEUS_GLYPHS — per Service Hub solution 794907 sample:
 *                    `.`=avail / `+`=occupied / `X`=blocked. Drops
 *                    per-cell W/A/M (Amadeus convention doesn't show
 *                    column-position SCCs per cell — sample shows
 *                    L/Y/V/+/. only). Keeps E (exit) per-cell since
 *                    Amadeus marks exit rows with E in cells.
 *   SABRE_GLYPHS   — per Basic Course DL/MD90 + Eurostar 2026 (both
 *                    agree . = TAKEN): `*`=avail / `.`=taken /
 *                    `-`=blocked. Drops per-cell W/A/M (Sabre
 *                    convention doesn't render those per cell). Keeps
 *                    E for exit rows.
 */
export interface SeatMapGlyphs {
  /** Char per status. Maps each `SeatAvailabilityStatus` to a glyph. */
  statusGlyphs: Record<SeatAvailabilityStatus, string>;
  /** Position-SCC priority list. Per-cell first match wins over the
   *  status glyph. Empty array = pure status display (no per-cell
   *  position labeling — matches Amadeus + Sabre convention). */
  positionPriority: ReadonlyArray<string>;
  /** Optional legend override. If absent the default cross-dialect
   *  legend prints. */
  legend?: string;
}

export const GALILEO_GLYPHS: SeatMapGlyphs = {
  statusGlyphs: STATUS_GLYPHS,
  positionPriority: POSITION_PRIORITY,
  legend: 'LEGEND: . avail  X reserved  - blocked   W window  A aisle  M middle  K bulkhead  E exit  H handicapped',
};

export const AMADEUS_GLYPHS: SeatMapGlyphs = {
  statusGlyphs: {
    Available: '.',
    Reserved: '+',
    Blocked: 'X',
    NoSeat: ' ',
    Unavailable: 'X',
  },
  positionPriority: ['E', 'H'],
  legend: 'LEGEND: . AVAILABLE  + OCCUPIED  X BLOCKED  E EXIT  H HANDICAP  (Amadeus Service Hub solution 794907)',
};

export const SABRE_GLYPHS: SeatMapGlyphs = {
  statusGlyphs: {
    Available: '*',
    Reserved: '.',
    Blocked: '-',
    NoSeat: ' ',
    Unavailable: '.',
  },
  positionPriority: ['E', 'H'],
  legend: 'LEGEND: * AVAIL  . TAKEN  - BLOCK  E EXIT ROW  H HANDICAP  (Sabre Basic Course DL/MD90 + Eurostar 2026)',
};

const CABIN_LETTER: Record<string, string> = {
  FIRST: 'F',
  BUSINESS: 'J',
  ECONOMY: 'Y',
  PREMIUM: 'W',
};

function cabinLetter(name: string): string {
  return CABIN_LETTER[name.toUpperCase()] ?? name.charAt(0).toUpperCase();
}

/**
 * Cross-dialect seat-map renderer. Header is built by the caller so
 * each dialect can emit its own wording (Amadeus says
 * `SM 1 — BA192 ...`, Sabre says `192Y 15JUL DFW-LHR / SEATS
 * INVENTORY DETAIL`). Body (cabin headers, per-row seat rendering,
 * exit-row dividers, legend) is dialect-agnostic.
 *
 * Optional `rowOffset` + `rowsPerPage` enable pagination for
 * chunk 7's MD/MU/MB/MT scrolling verbs. Without them (or with
 * `rowsPerPage` omitted), the renderer emits every row — preserving
 * the current behavior for chunks 1-6. When pagination is in effect,
 * a `ROWS X-Y OF Z` footer prints above the legend so the operator
 * can see their scroll position.
 */
export function renderSeatMap(
  seatMap: SeatMap,
  availability: SeatAvailabilityList[],
  header: string,
  orientation: RenderOrientation = 'V',
  opts: { rowOffset?: number; rowsPerPage?: number; showLegend?: boolean; glyphs?: SeatMapGlyphs } = {},
): string {
  const glyphs = opts.glyphs ?? GALILEO_GLYPHS;
  const statusByLabel = new Map<string, SeatAvailabilityStatus>();
  for (const bucket of availability) {
    const status = bucket.seatAvailabilityStatus as SeatAvailabilityStatus;
    for (const label of bucket.value) statusByLabel.set(label, status);
  }
  const totalRows = seatMap.Cabin.reduce((sum, c) => sum + c.Row.length, 0);
  const offset = opts.rowOffset ?? 0;
  const limit = opts.rowsPerPage;
  const sections: string[] = [];
  // Walk cabins in order; clip each cabin's Row[] to the visible
  // window. Cabin header still renders so the operator sees which
  // cabin they're in.
  let rowsSeen = 0;
  let rowsEmitted = 0;
  for (const cabin of seatMap.Cabin) {
    const cabinRowCount = cabin.Row.length;
    const cabinFirstRow = rowsSeen;
    const cabinLastRow = rowsSeen + cabinRowCount - 1;
    rowsSeen += cabinRowCount;
    if (limit !== undefined) {
      // Skip cabins entirely before the offset.
      if (cabinLastRow < offset) continue;
      // Skip cabins entirely after the visible window.
      if (cabinFirstRow >= offset + limit) continue;
    }
    // Clip the cabin's Row[] to the visible slice within this cabin.
    let visibleCabin = cabin;
    if (limit !== undefined) {
      const skipInCabin = Math.max(0, offset - cabinFirstRow);
      const remainingBudget = (offset + limit) - cabinFirstRow - skipInCabin;
      const sliceLen = Math.min(remainingBudget, cabinRowCount - skipInCabin);
      visibleCabin = { ...cabin, Row: cabin.Row.slice(skipInCabin, skipInCabin + sliceLen) };
      rowsEmitted += sliceLen;
    }
    sections.push('');
    sections.push(...renderCabin(visibleCabin, statusByLabel, orientation, glyphs));
  }
  const footer: string[] = [];
  if (limit !== undefined) {
    const firstRow = offset + 1;
    const lastRow = Math.min(offset + (rowsEmitted || limit), totalRows);
    footer.push('');
    footer.push(`ROWS ${firstRow}-${lastRow} OF ${totalRows}`);
  }
  const showLegend = opts.showLegend ?? true;
  const trailer = showLegend ? ['', glyphs.legend ?? renderLegend()] : [];
  return [header, ...sections, ...footer, ...trailer].join('\n');
}

function renderCabin(
  cabin: Cabin,
  statusByLabel: Map<string, SeatAvailabilityStatus>,
  orientation: RenderOrientation,
  glyphs: SeatMapGlyphs,
): string[] {
  const columns = cabin.Layout
    .filter((e) => e.value)
    .map((e) => e.value!);
  const aisleAfter = cabin.aisleAfterColumn ?? [];
  if (orientation === 'H') return renderHorizontal(cabin, columns, aisleAfter, statusByLabel, glyphs);

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
      return renderSeat(`${row.label}${col}`, space, statusByLabel, glyphs);
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
  glyphs: SeatMapGlyphs,
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
      return renderSeat(`${row.label}${col}`, space, statusByLabel, glyphs).padStart(3, ' ');
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
  glyphs: SeatMapGlyphs,
): string {
  const chars = space.Characteristic ?? [];
  if (chars.some((c) => NO_SEAT_CHARACTERISTICS.has(c))) return ' ';
  for (const code of glyphs.positionPriority) {
    if (chars.includes(code)) return code;
  }
  const status = statusByLabel.get(label);
  return status ? glyphs.statusGlyphs[status] : '?';
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

/**
 * Build the Amadeus-style header line. Format:
 *   SM <n> — <carrier><flight> <date> <orig>-<dest> — <equipment>
 */
export function amadeusSeatMapHeader(
  seatMap: SeatMap,
  segment: AirSegment,
  segmentNumber: number,
): string {
  return `SM ${segmentNumber} — ${seatMap.carrier}${seatMap.flightNumber} ${segment.date} ${segment.origin}-${segment.destination} — ${seatMap.equipment}`;
}

/**
 * Build the Sabre-style header. Per Sabre Basic Course (Display Seat
 * Maps section) the format is:
 *   <flight><class> <date> <citypair>
 *   SEATS INVENTORY DETAIL
 * Verbatim example from the PDF: "864Y 25OCT DFWSLC".
 */
export function sabreSeatMapHeader(
  seatMap: SeatMap,
  segment: AirSegment,
): string {
  const cls = segment.bookingClass || 'Y';
  return `${seatMap.flightNumber}${cls} ${segment.date} ${segment.origin}${segment.destination}\nSEATS INVENTORY DETAIL`;
}

/**
 * Build the Galileo-style header. The Pocket Guide doesn't pin the
 * exact wording; reconstructed from the documented entry forms +
 * Galileo's general single-flight display conventions:
 *   <carrier><flight>/<class> <date> <orig><dest>  EQP <equipment>
 * Single line, all-caps tokens, space-separated.
 */
export function galileoSeatMapHeader(
  seatMap: SeatMap,
  segment: AirSegment,
): string {
  const cls = segment.bookingClass || 'Y';
  return `${seatMap.carrier}${seatMap.flightNumber}/${cls} ${segment.date} ${segment.origin}${segment.destination}  EQP ${seatMap.equipment}`;
}
