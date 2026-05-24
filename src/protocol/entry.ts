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
  date: SabreDate;
  origin: string;
  destination: string;
  /** Optional preferred departure time as typed, e.g. "2030". */
  time?: string;
}

export interface SellEntry extends BaseEntry {
  kind: 'sell';
  seats: number;
  bookingClass: string;
  /** Line number from the last availability display. */
  line: number;
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

export interface DisplayEntry extends BaseEntry {
  kind: 'display';
  /** Everything after '*': a locator, "-NAME", or a section code (A/I/N/P/T). */
  argument: string;
}

export interface EndTransactionEntry extends BaseEntry {
  kind: 'end_transaction';
  redisplay: boolean; // ER redisplays the PNR; E / ET do not
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
  | EndTransactionEntry
  | IgnoreEntry
  | SignInEntry
  | SignOutEntry
  | UnsupportedEntry;
