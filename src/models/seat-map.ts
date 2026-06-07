/**
 * Seat map model — cross-dialect, vendor-agnostic.
 *
 * Mirrors the Travelport v11 `/seatmaps` response shape (per chunk 0
 * of `docs/seatmap-design.md`) so the live mapper is one-pass.
 * Cabin → Layout + Row → Space hierarchy with per-seat Characteristic
 * codes (IATA PADIS 9825) and a separate status-grouped availability
 * list, also matching live.
 *
 * Closed/open asymmetry — intentional:
 *   - Model fields are OPEN (`string`, `string[]`) so live responses
 *     with vendor extensions don't break parsing.
 *   - The synthesizer + emulated emit paths use the CLOSED unions
 *     (`SccCode`, `SeatAvailabilityStatus`) so a typo trips typecheck.
 *
 * SCC + status enums verbatim in
 * `references/iata-padis-9825-seat-codes.md`.
 */

/**
 * IATA PADIS 9825 seat characteristic codes — ~115 values.
 * Sourced verbatim from `references/iata-padis-9825-seat-codes.md`.
 * Used by the synthesizer + emulated emit paths; live mapper passes
 * any non-listed code through as a literal string (open input).
 */
export type SccCode =
  // Single-character
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J'
  | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'S' | 'T' | 'U'
  | 'V' | 'W' | 'X' | 'Z'
  // Two-character
  | 'AA' | 'AB' | 'AC' | 'AG' | 'AJ' | 'AL' | 'AM' | 'AR' | 'AS' | 'AT'
  | 'AU' | 'AV' | 'AW' | 'BA' | 'BC' | 'BE' | 'BK' | 'BR' | 'BS'
  | 'CC' | 'CH' | 'CL' | 'CS' | 'DE' | 'EA' | 'EC' | 'EK' | 'ES' | 'EX'
  | 'FC' | 'FS' | 'GF' | 'GN' | 'GR' | 'IA' | 'IE' | 'IF' | 'IK' | 'IR'
  | 'JS' | 'KA' | 'KN' | 'LA' | 'LB' | 'LE' | 'LF' | 'LG' | 'LH' | 'LL'
  | 'LR' | 'LS' | 'LT' | 'MA' | 'ML' | 'MS' | 'MX' | 'OW' | 'PC' | 'PE'
  | 'RS' | 'SC' | 'SO' | 'ST' | 'TA' | 'UP' | 'US' | 'WA'
  // Numeric + mixed
  | '1' | '2' | '3' | '4' | '6' | '7' | '8' | '9'
  | '10' | '11' | '12' | '13' | '14' | '15' | '16' | '17' | '18' | '19'
  | '20' | '21' | '22' | '23' | '24' | '25' | '26' | '27' | '28' | '29'
  | '30'
  | '1A' | '1B' | '1C' | '1D' | '1E' | '1M' | '1W'
  | '3A' | '3B' | '6A' | '6B' | '7A' | '7B'
  | '33' | '34' | '35' | '36' | '37' | '38' | '39' | '40'
  | '61' | '62' | '63' | '64' | '65' | '66'
  | '70' | '71' | '72' | '73';

/**
 * Travelport `seatAvailabilityStatus` enum — 5 values.
 * Sourced from
 * `support.travelport.com/webhelp/JSONAPIs/Airv11/Content/Air11/Seats/`
 * `APIRef_SeatMap.htm`.
 */
export type SeatAvailabilityStatus =
  | 'Available'
  | 'Reserved'
  | 'Blocked'
  | 'NoSeat'
  | 'Unavailable';

/**
 * Human-readable labels for SCC codes. Drives the chunk-2 renderer
 * legend. Verbatim from `references/iata-padis-9825-seat-codes.md`;
 * not every code has a label here (we curated the ~25 codes most
 * relevant to display) — unknown codes render as `[code]` per the
 * default-fallback policy in chunk 0.
 */
export const SCC_LABELS: Partial<Record<SccCode, string>> = {
  A: 'Aisle seat',
  W: 'Window seat',
  M: 'Seat without a movie view',
  MS: 'Middle seat',
  '9': 'Center seat (not window, not aisle)',
  K: 'Bulkhead seat',
  E: 'Exit and emergency exit',
  H: 'Seat with facilities for handicapped/incapacitated passenger',
  L: 'Leg space seat',
  U: 'Seat suitable for unaccompanied minors',
  BR: 'Seat is broken – not available for use',
  CH: 'Chargeable seat',
  EK: 'Economy comfort seat',
  D: 'No seat - exit door',
  EX: 'No seat - emergency Exit',
  LA: 'No seat – lavatory',
  GN: 'No seat - galley',
  SO: 'No seat - storage space',
  ST: 'No seat - stairs to upper deck',
  TA: 'No seat - table',
  CL: 'No seat - closet',
  KN: 'Bulkhead, no seat',
  '8': 'No seat at this location',
  N: 'No smoking seat',
};

/** Renderer glyph per status code. */
export const STATUS_GLYPHS: Record<SeatAvailabilityStatus, string> = {
  Available: '.',
  Reserved: 'X',
  Blocked: '-',
  NoSeat: ' ',
  Unavailable: 'X',
};

/** Position labels for cabin-level column specs. */
export type ColumnPosition = 'W' | 'A' | 'C' | 'M';

/**
 * Cabin Layout entry — mixed-shape array per the live response.
 * An entry is EITHER a row-range marker (`startRow` + `endRow`) OR a
 * column-position marker (`position` + `value`). Mirrors the live
 * shape verbatim so the mapper is one-pass.
 */
export interface CabinLayoutEntry {
  startRow?: number;
  endRow?: number;
  position?: string[];
  value?: string;
}

/** A single seat (column slot in a row). */
export interface SeatSpace {
  location: string;
  /** PADIS 9825 codes — open string array; SccCode for typed emits. */
  Characteristic?: string[];
}

/** One row in a cabin. */
export interface SeatRow {
  label: string;
  Space: SeatSpace[];
}

/** A cabin partition (F / J / W / Y). */
export interface Cabin {
  name: string;
  Layout: CabinLayoutEntry[];
  Row: SeatRow[];
}

/** Top-level seat map. */
export interface SeatMap {
  carrier: string;
  flightNumber: string;
  equipment: string;
  Cabin: Cabin[];
}

/**
 * Status-grouped availability list — same shape Travelport emits.
 * Synthesizer produces this; live mapper produces the equivalent.
 */
export interface SeatAvailabilityList {
  /** Open string — `SeatAvailabilityStatus` for typed emits. */
  seatAvailabilityStatus: string;
  value: string[];
}

/**
 * Synthesize per-seat availability for the seat map, deterministic
 * keyed on (locator, date, seat label). Same query → same answer
 * across multiple calls; different locators → different distributions.
 *
 * Distribution roughly matches what live returns based on the v11
 * sample we extracted: ~70% Available, ~20% Reserved, ~5% Blocked,
 * ~5% NoSeat. Seats marked with structural no-seat SCCs (LA / GN /
 * SO / ST / TA / CL / KN / D / EX / `8`) always return NoSeat — the
 * status is a property of the position, not chance.
 */
export function synthesizeAvailability(
  seatMap: SeatMap,
  locator: string,
  date: string,
): SeatAvailabilityList[] {
  const buckets = new Map<SeatAvailabilityStatus, string[]>();
  for (const cabin of seatMap.Cabin) {
    for (const row of cabin.Row) {
      for (const space of row.Space) {
        const seatLabel = `${row.label}${space.location}`;
        const status = assignStatus(space, seatLabel, locator, date);
        if (!buckets.has(status)) buckets.set(status, []);
        buckets.get(status)!.push(seatLabel);
      }
    }
  }
  // Mirror live: one entry per status, value[] sorted for diff-friendliness.
  return [...buckets.entries()].map(([seatAvailabilityStatus, value]) => ({
    seatAvailabilityStatus,
    value: value.sort(),
  }));
}

const NO_SEAT_CHARACTERISTICS: ReadonlySet<string> = new Set([
  'LA', 'GN', 'SO', 'ST', 'TA', 'CL', 'KN', 'D', 'EX', '8',
]);

function assignStatus(
  space: SeatSpace,
  seatLabel: string,
  locator: string,
  date: string,
): SeatAvailabilityStatus {
  // Position-driven: structural no-seat codes are always NoSeat.
  if (space.Characteristic?.some((c) => NO_SEAT_CHARACTERISTICS.has(c))) {
    return 'NoSeat';
  }
  const seed = djb2(`${locator}|${date}|${seatLabel}`);
  const r = seed % 1000;
  if (r < 700) return 'Available';
  if (r < 900) return 'Reserved';
  if (r < 950) return 'Blocked';
  return 'NoSeat';
}

/**
 * DJB2 string hash — deterministic, no Math.random / Date.now. Used
 * by the synthesizer to seed per-seat status assignment from
 * (locator, date, seat) without persistence.
 */
function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
