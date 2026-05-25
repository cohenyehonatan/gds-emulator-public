/**
 * Parsed cryptic entry types.
 *
 * The parser turns a raw cryptic string (e.g. "01Y1") into one of these
 * discriminated structures, which handlers then apply to the work area.
 * Analogous to pectab's AeaMessage union, but for terminal→host entries.
 */

import type { SabreDate } from '../utils/validation.js';

export interface BaseEntry {
  /** The raw cryptic text as typed. */
  raw: string;
  timestamp: Date;
}

export interface AvailabilityEntry extends BaseEntry {
  kind: 'availability';
  /** display = 1<date><citypair>…; more = 1*; redisplay = 1*R/1*OA; return = 1R… */
  mode: 'display' | 'more' | 'redisplay' | 'return';
  date?: SabreDate; // present for display, optional for return (1R¥<days>)
  returnDays?: number; // 1R¥15 — add N days to the last availability date
  origin?: string;
  destination?: string;
  /** Optional preferred departure time as typed, e.g. "2030". */
  time?: string;
  /** Optional class-of-service qualifier ("-Y"). */
  bookingClass?: string;
  /** Optional preferred-airline qualifier ("¥AA", "¥UADLBA" → [UA,DL,BA]). */
  carriers?: string[];
  /** Direct-only qualifier ("/D"): nonstops/direct, no connections. */
  directOnly?: boolean;
}

/**
 * Sell entry (sigil '0'), two shapes:
 *  - mode 'availability': 0<seats><class><line>[LL]   (sell/waitlist from a CPA)
 *  - mode 'direct':       long-sell / passive / open by typed flight data
 */
export interface SellEntry extends BaseEntry {
  kind: 'sell';
  mode: 'availability' | 'direct';
  seats: number;
  bookingClass: string; // first leg's class (convenience for single-leg sells)
  // availability mode:
  line?: number; // first leg's line (convenience)
  legs?: { bookingClass: string; line: number }[]; // all legs (>=2 for connections)
  connectionStar?: boolean; // '*' = also sell following connection legs, same class
  waitlist?: boolean;
  // direct mode:
  carrier?: string;
  flightNumber?: string; // absent for open segments
  open?: boolean;
  date?: SabreDate;
  origin?: string;
  destination?: string;
  status?: string; // NN long-sell, LL waitlist, GK/BK passive, DS open
  airlineLocator?: string; // optional, after '*' on a passive sell
}

export interface NameEntry extends BaseEntry {
  kind: 'name';
  /** As typed after the dash, e.g. "ALONSO/EDITH". */
  text: string;
}

export interface PhoneEntry extends BaseEntry {
  kind: 'phone';
  text: string; // e.g. "415-555-2121-H"
}

export interface TicketingEntry extends BaseEntry {
  kind: 'ticketing';
  text: string; // e.g. "TAW22JAN/"
}

export interface ReceivedFromEntry extends BaseEntry {
  kind: 'received_from';
  text: string; // e.g. "NIGEL"
}

export interface SsrEntry extends BaseEntry {
  kind: 'ssr';
  code: string;
  carrier: string;
  text?: string;
  nameRef?: { item: number; passenger?: number };
}

export interface OsiEntry extends BaseEntry {
  kind: 'osi';
  carrier: string;
  text: string;
}

export interface RemarkEntry extends BaseEntry {
  kind: 'remark';
  remarkType: 'general' | 'fop' | 'historical';
  text: string;
}

export interface TimeLimitEntry extends BaseEntry {
  kind: 'time_limit';
  text: string; // e.g. "6P/17JUN"
}

export interface FrequentFlyerEntry extends BaseEntry {
  kind: 'frequent_flyer';
  operation: 'add' | 'change' | 'delete';
  line?: number; // for change/delete (FF1¤…)
  carrier?: string;
  number?: string;
  nameRef?: { item: number; passenger?: number };
}

export interface DisplayEntry extends BaseEntry {
  kind: 'display';
  /** Everything after '*': a locator, "-NAME", or a section code (A/I/N/P/T). */
  argument: string;
}

/**
 * Flight information (FLIFO / verify): by flight number (2 / V*), from an
 * availability line (VA*), or from an itinerary segment (VI*).
 */
export interface FlightInfoEntry extends BaseEntry {
  kind: 'flight_info';
  source: 'flight' | 'availability' | 'itinerary';
  carrier?: string;
  flightNumber?: string;
  date?: string; // Sabre date token
  lines?: number[]; // availability lines or itinerary segments (empty = all, itinerary)
}

export interface CancelEntry extends BaseEntry {
  kind: 'cancel';
  mode: 'segment' | 'multiple' | 'range' | 'itinerary' | 'all_air';
  /** Affected segment numbers (empty for whole-itinerary cancels). */
  segments: number[];
}

export interface SegmentStatusEntry extends BaseEntry {
  kind: 'segment_status';
  segment: number;
  status: string; // e.g. "HK"
}

/**
 * Field change / delete using the change key '¤' (workbook "DELETE AND CHANGE
 * PASSENGER DATA"):
 *   delete: <sigil><lineSpec>¤            -¤, -1¤, 91-3¤, 91,3¤
 *   change: <sigil><line>¤<new data>      -1¤JENSEN/KURT MR, 91¤..., 7¤TAW.../, 6¤JENS
 */
export interface ModifyEntry extends BaseEntry {
  kind: 'modify';
  field: 'name' | 'phone' | 'ticketing' | 'received_from' | 'remarks';
  operation: 'change' | 'delete';
  /** Affected 1-based line(s); empty = "the only one" / single-value field. */
  lines: number[];
  /** Passenger within a name item (the ".P" of a "1.1" reference). */
  passenger?: number;
  /** True for a name-reference-data op (¤*): newData holds the reference value. */
  reference?: boolean;
  newData?: string; // present for change
}

export interface EndTransactionEntry extends BaseEntry {
  kind: 'end_transaction';
  redisplay: boolean; // ER redisplays the PNR; E / ET do not
}

export interface PricingEntry extends BaseEntry {
  kind: 'pricing';
  mode: 'price' | 'redisplay' | 'bargain' | 'store' | 'farecalc'; // WP / WP* / WPNC / PQ / WPDF
  rebook?: boolean; // WPNCB rebooks the lowest class
  ignoreAvailability?: boolean; // WPNCS ignores availability
  passengerTypes?: string[]; // WPP ADT/C05/INF
  segments?: number[]; // WPS segment selection
  store?: boolean; // WPRQ: price and store a PQ record in one entry
  fareCalcLine?: number; // WPDF<n>: a specific fare-calculation line
}

export interface IgnoreEntry extends BaseEntry {
  kind: 'ignore';
}

export interface SignInEntry extends BaseEntry {
  kind: 'sign_in';
  argument: string;
}

export interface SignOutEntry extends BaseEntry {
  kind: 'sign_out';
  allAreas: boolean; // SO* signs out of every work area
}

/** Catch-all for entries that parse to a known sigil but aren't yet implemented. */
export interface UnsupportedEntry extends BaseEntry {
  kind: 'unsupported';
  sigil: string;
}

export type ParsedEntry =
  | AvailabilityEntry
  | SellEntry
  | NameEntry
  | PhoneEntry
  | TicketingEntry
  | ReceivedFromEntry
  | DisplayEntry
  | SsrEntry
  | OsiEntry
  | RemarkEntry
  | TimeLimitEntry
  | FrequentFlyerEntry
  | FlightInfoEntry
  | CancelEntry
  | SegmentStatusEntry
  | ModifyEntry
  | PricingEntry
  | EndTransactionEntry
  | IgnoreEntry
  | SignInEntry
  | SignOutEntry
  | UnsupportedEntry;
