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
  /**
   * When true, the renderer uses Amadeus's mirrored row format:
   * cabin-code + row-number framing on BOTH sides of each row, top
   * and bottom column headers per cabin, and per-row wing/bulkhead
   * markers (`<>` / `<E E>` / `B`).
   *
   * Per the Amadeus AA0505 sample (Service Hub solution 794907):
   *
   *          A  B  C     D  E  F
   *  Y  8 B  L  L  L     +  +  L  B 8  Y
   *     9    L  L  L     L  L  L    9
   *    13 <  .  V  V     V  V  .  > 13
   *    16 <E L  L  L     L  L  L E> 16
   *
   * Wing-row detection is heuristic: middle 60% of each cabin's
   * rows (per-equipment wing data isn't seeded). Bulkhead = first
   * row of each cabin. Combined wing+exit = `<E ... E>`.
   *
   * Sabre + Galileo glyph maps leave this false → existing
   * simple-row format. Default false everywhere.
   */
  mirroredRows?: boolean;
  /**
   * When true, the renderer overlays `-BLKHD-` between aisles on
   * bulkhead rows (first row of each cabin), per the Sabre Basic
   * Course DL/MD90 sample (chunk 7 deferred #10).
   */
  bulkheadOverlay?: boolean;
  /**
   * When true, the renderer appends `P` to row labels where any seat
   * in the row carries V (preferred) decoration. Per the Sabre Basic
   * Course DL/MD90 sample row-3 marker.
   */
  preferredRowPrefix?: boolean;
  /**
   * When true, skip the cross-dialect "ECONOMY (Y)" cabin-label
   * header line. Sabre + Amadeus conventions don't print it; only
   * the cross-dialect default + Galileo do.
   */
  skipCabinLabel?: boolean;
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
  // Position priority — order is overlay-precedence. E (exit) wins
  // even on occupied seats; L (legroom) / V (preferred) / Y
  // (chargeable) overlay status glyphs per the Amadeus AA0505 sample
  // convention (a chargeable seat that's also occupied still shows Y,
  // not +, because the position SCC is the more informative marker).
  positionPriority: ['E', 'L', 'V', 'Y', 'H'],
  legend: 'LEGEND: . AVAILABLE  + OCCUPIED  X BLOCKED  <> WING  B BULKHEAD  E EXIT  L LEGROOM  V PREF.SEAT  Y CHARGEABLE  H HANDICAP  (Amadeus Service Hub solution 794907)',
  mirroredRows: true,
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
  legend: 'LEGEND: * AVAIL  . TAKEN  - BLOCK  E EXIT ROW  H HANDICAP  -BLKHD- BULKHEAD  P PREFERRED ROW  (Sabre Basic Course DL/MD90 + Eurostar 2026)',
  bulkheadOverlay: true,
  preferredRowPrefix: true,
  skipCabinLabel: true,
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
  opts: {
    rowOffset?: number;
    rowsPerPage?: number;
    showLegend?: boolean;
    glyphs?: SeatMapGlyphs;
    /** Per-seat extra characteristic codes (e.g. from
     *  `synthesizeDecorations`). Merged with each seat's existing
     *  Characteristic for position-priority lookup. */
    decorations?: Map<string, string[]>;
  } = {},
): string {
  const glyphs = opts.glyphs ?? GALILEO_GLYPHS;
  const decorations = opts.decorations;
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
    sections.push(...renderCabin(visibleCabin, statusByLabel, orientation, glyphs, decorations));
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
  decorations?: Map<string, string[]>,
): string[] {
  const columns = cabin.Layout
    .filter((e) => e.value)
    .map((e) => e.value!);
  const aisleAfter = cabin.aisleAfterColumn ?? [];
  if (orientation === 'H') return renderHorizontal(cabin, columns, aisleAfter, statusByLabel, glyphs, decorations);
  if (glyphs.mirroredRows) {
    return renderCabinMirrored(cabin, columns, aisleAfter, statusByLabel, glyphs, decorations);
  }

  const lines: string[] = [];
  const cabinLabel = `${cabin.name} (${cabinLetter(cabin.name)})`;
  const headerCols = formatRow(columns, columns, aisleAfter);
  // Column-position math: header letter lands at col `cabin_pad + 2`;
  // row data lands at col `row_pad + 6` (1 sigil + row_pad + 1 sep + 3
  // row label + 1 sep). For both to align: cabin_pad = row_pad + 4.
  // Bumping row labels right by 1 (row_pad 11 → 12) bumps cabin_pad
  // 14 → 16 to track. Exit-row indent matches the new data position.
  if (!glyphs.skipCabinLabel) {
    lines.push(` ${cabinLabel.padEnd(16)} ${headerCols}`);
  } else {
    // Skip cabin-label header but still print the column header on a
    // dedicated line so the rows below align with column letters.
    lines.push(` ${' '.repeat(16)} ${headerCols}`);
  }
  cabin.Row.forEach((row, rowIdx) => {
    const isExitRow = row.Space.some((s) => s.Characteristic?.includes('E'));
    const isBulkhead = rowIdx === 0;
    const hasPreferred = decorations
      ? row.Space.some((s) => (decorations.get(`${row.label}${s.location}`) ?? []).includes('V'))
      : false;
    if (isExitRow && !glyphs.skipCabinLabel) lines.push(' '.repeat(17) + ' --- EXIT ROW ---');
    const seatChars = columns.map((col) => {
      const space = row.Space.find((s) => s.location === col);
      if (!space) return ' ';
      return renderSeat(`${row.label}${col}`, space, statusByLabel, glyphs, decorations);
    });
    let seats = formatRow(columns, seatChars, aisleAfter);
    // BLKHD overlay: replace the per-cell glyphs with the BLKHD label
    // spanning the aisle gap. We only attempt this when bulkhead AND
    // bulkheadOverlay are true; the column-content underneath gets
    // replaced with a centered "-BLKHD-" marker.
    if (isBulkhead && glyphs.bulkheadOverlay) {
      seats = overlayBlkhd(seats);
    }
    // Preferred-row prefix: append `P` to the row label so the
    // operator can see which rows charge for preferred-seat
    // selection. Per the Sabre Basic Course DL/MD90 sample row-3
    // "3P" marker.
    const rawLabel = glyphs.preferredRowPrefix && hasPreferred
      ? `${row.label}P`
      : row.label;
    const rowLabel = rawLabel.padStart(3, ' ');
    lines.push(` ${' '.repeat(12)} ${rowLabel} ${seats}`);
  });
  return lines;
}

/**
 * Replace the existing per-cell seat glyphs in a formatted row with
 * a centered "-BLKHD-" marker on the bulkhead row, per the Sabre
 * Basic Course DL/MD90 sample row-2 marker. The overlay keeps the
 * row's left/right edges so column alignment stays consistent.
 */
function overlayBlkhd(seats: string): string {
  // Center BLKHD in the row's width.
  const width = seats.length;
  const marker = '-BLKHD-';
  if (width < marker.length + 4) return seats; // not wide enough; leave alone
  const pad = Math.max(0, Math.floor((width - marker.length) / 2));
  return seats.slice(0, pad) + marker + seats.slice(pad + marker.length);
}

/**
 * Amadeus mirrored row format — per Service Hub solution 794907's
 * AA0505 vertical sample:
 *
 *          A  B  C     D  E  F
 *   Y  8 B  L  L  L     +  +  L  B 8  Y    ← first row, bulkhead, cabin code mirrored
 *      9    L  L  L     L  L  L    9
 *     13 <  .  V  V     V  V  .  > 13      ← wing row
 *     16 <E L  L  L     L  L  L E> 16      ← wing + exit row
 *          A  B  C     D  E  F
 *
 * Per-cabin top + bottom column headers. Each row carries:
 *   <cabin? row leftMarker> <seats> <rightMarker row cabin?>
 * Cabin code prints on the FIRST row of each cabin (left + right).
 * leftMarker / rightMarker variants:
 *   `B ` ` B`   bulkhead (first row of cabin)
 *   `< ` ` >`   wing row (middle 60% of cabin)
 *   `<E` `E>`   wing + exit row
 *   `  ` `  `   interior (no marker)
 *
 * Wing-row heuristic: middle 60% of each cabin (per-equipment wing
 * data isn't seeded). For a 14-row cabin, wing covers rows ~3-11.
 */
function renderCabinMirrored(
  cabin: Cabin,
  columns: string[],
  aisleAfter: string[],
  statusByLabel: Map<string, SeatAvailabilityStatus>,
  glyphs: SeatMapGlyphs,
  decorations?: Map<string, string[]>,
): string[] {
  const lines: string[] = [];
  const cabinCode = cabinLetter(cabin.name);
  const headerCols = formatRow(columns, columns, aisleAfter);
  // Indent the column header to align with the seat cells in row lines.
  // Row line: ` <cab> <row3>  <leftM>  <seats>` — that's 1 + 1 + 1 +
  // 3 + 2 + 2 + 2 + 1 = 13 chars before the seats start. Header gets
  // the same indent.
  const headerIndent = ' '.repeat(13);
  lines.push(`${headerIndent}${headerCols}`);

  // Wing-row band: middle 60% of cabin (rows[20% .. 80%)).
  const total = cabin.Row.length;
  const wingStart = Math.floor(total * 0.2);
  const wingEnd = Math.ceil(total * 0.8);

  cabin.Row.forEach((row, idx) => {
    const isBulkhead = idx === 0;
    const isWing = idx >= wingStart && idx < wingEnd;
    const isExit = row.Space.some((s) => s.Characteristic?.includes('E'));

    let leftMarker = '  ';
    let rightMarker = '  ';
    if (isBulkhead) {
      leftMarker = 'B ';
      rightMarker = ' B';
    } else if (isWing && isExit) {
      leftMarker = '<E';
      rightMarker = 'E>';
    } else if (isWing) {
      leftMarker = '< ';
      rightMarker = ' >';
    } else if (isExit) {
      // Non-wing exit rows still get an E marker (rare in practice;
      // wide-body exits are usually wing-adjacent, but we honour the
      // structural E SCC even when outside the wing band).
      leftMarker = 'E ';
      rightMarker = ' E';
    }

    const leftCabin = idx === 0 ? cabinCode : ' ';
    const rightCabin = idx === 0 ? cabinCode : ' ';

    const seatChars = columns.map((col) => {
      const space = row.Space.find((s) => s.location === col);
      if (!space) return ' ';
      return renderSeat(`${row.label}${col}`, space, statusByLabel, glyphs, decorations);
    });
    const seats = formatRow(columns, seatChars, aisleAfter);
    const rowLabel = row.label.padStart(2, ' ');

    // Layout: <space><leftCabin><space><rowLabel><space><leftMarker><space><seats><space><rightMarker><space><rowLabel><space><rightCabin>
    lines.push(` ${leftCabin} ${rowLabel}  ${leftMarker}  ${seats}  ${rightMarker}  ${rowLabel} ${rightCabin}`);
  });

  // Bottom column header — same indent as the top.
  lines.push(`${headerIndent}${headerCols}`);
  return lines;
}

function renderHorizontal(
  cabin: Cabin,
  columns: string[],
  aisleAfter: string[],
  statusByLabel: Map<string, SeatAvailabilityStatus>,
  glyphs: SeatMapGlyphs,
  decorations?: Map<string, string[]>,
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
      return renderSeat(`${row.label}${col}`, space, statusByLabel, glyphs, decorations).padStart(3, ' ');
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
  decorations?: Map<string, string[]>,
): string {
  const baseChars = space.Characteristic ?? [];
  if (baseChars.some((c) => NO_SEAT_CHARACTERISTICS.has(c))) return ' ';
  // Merge per-seat decorations (Y/V/L from `synthesizeDecorations`)
  // with the seat's structural Characteristic. Decorations are
  // additive — they appear in the per-cell position-priority lookup
  // alongside the structural codes.
  const decor = decorations?.get(label) ?? [];
  for (const code of glyphs.positionPriority) {
    if (baseChars.includes(code) || decor.includes(code)) return code;
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
/**
 * Carrier-name lookup for the Sabre equipment-description line. Only
 * a small curated set of the most common carriers in our seed data —
 * unknown carriers print their 2-letter code as the airline name.
 * Sourced from IATA airline-code public registry.
 */
const SABRE_CARRIER_NAMES: Record<string, string> = {
  AA: 'AMERICAN',
  DL: 'DELTA',
  UA: 'UNITED',
  WN: 'SOUTHWEST',
  B6: 'JETBLUE',
  AS: 'ALASKA',
  NK: 'SPIRIT',
  F9: 'FRONTIER',
  HA: 'HAWAIIAN',
  BA: 'BRITISH AIRWAYS',
  LH: 'LUFTHANSA',
  AF: 'AIR FRANCE',
  KL: 'KLM',
  IB: 'IBERIA',
  QF: 'QANTAS',
  NH: 'ANA',
  JL: 'JAPAN AIRLINES',
};

/**
 * Equipment-name lookup for the Sabre equipment-description line.
 * IATA standard equipment codes; matches what carriers print in
 * the response. Unknown codes print the code alone.
 */
const SABRE_EQUIPMENT_NAMES: Record<string, string> = {
  '737': 'BOEING 737',
  '738': 'BOEING 737-800',
  '739': 'BOEING 737-900',
  '747': 'BOEING 747',
  '757': 'BOEING 757',
  '767': 'BOEING 767',
  '777': 'BOEING 777',
  '787': 'BOEING 787',
  '320': 'AIRBUS A320',
  '321': 'AIRBUS A321',
  '32A': 'AIRBUS A320',
  '32B': 'AIRBUS A321',
  '330': 'AIRBUS A330',
  '350': 'AIRBUS A350',
  '380': 'AIRBUS A380',
  'M80': 'MCDONNELL DOUGLAS MD-80',
  'M90': 'MCDONNELL DOUGLAS MD-90',
  CRJ: 'BOMBARDIER CRJ',
  E90: 'EMBRAER 190',
};

/**
 * Build Sabre's two-line header per the Basic Course DL/MD90 sample
 * (`references/Sabre-Basic-Reservation-Course.pdf` p.~74 + the
 * parity-doc Eurostar 2026 cross-reference):
 *
 *   615Y 15JUL JFKLAX   SEATS INVENTORY DETAIL    M90-Y1/SHIP 000
 *   M90 DELTA MD90 Y-138 SEATS ECONOMY CLASS
 *
 * Line 1: flight + class + date + city pair + "SEATS INVENTORY
 *         DETAIL" + equipment code + cabin code + "/SHIP <tail>"
 * Line 2: equipment code + airline name + equipment type + cabin
 *         + total-seats + cabin-class label
 *
 * Ship tail number is not modeled in our seed — we print "000" as a
 * placeholder, which matches the parity-doc sample's choice.
 */
export function sabreSeatMapHeader(
  seatMap: SeatMap,
  segment: AirSegment,
): string {
  const cls = segment.bookingClass || 'Y';
  const equipment = seatMap.equipment;
  const cabinCode = cabinLetter(seatMap.Cabin.find((c) => /^(ECONOMY|MAIN)/i.test(c.name))?.name ?? 'ECONOMY');
  // Per-cabin total seat count.
  const totalSeats = seatMap.Cabin.reduce((sum, c) => {
    return sum + c.Row.reduce((rs, r) => rs + r.Space.filter((s) => !s.Characteristic?.some((x) => NO_SEAT_CHARACTERISTICS.has(x))).length, 0);
  }, 0);
  const carrierName = SABRE_CARRIER_NAMES[segment.carrier] ?? segment.carrier;
  const equipmentName = SABRE_EQUIPMENT_NAMES[equipment] ?? equipment;
  // Cabin class label — first cabin's name as the "primary" class.
  const primaryCabin = seatMap.Cabin[0]?.name ?? 'ECONOMY';
  const line1 = `${seatMap.flightNumber}${cls} ${segment.date} ${segment.origin}${segment.destination}   SEATS INVENTORY DETAIL    ${equipment}-${cabinCode}1/SHIP 000`;
  const line2 = `${equipment} ${carrierName} ${equipmentName} ${cabinCode}-${totalSeats} SEATS ${primaryCabin} CLASS`;
  return `${line1}\n${line2}`;
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
