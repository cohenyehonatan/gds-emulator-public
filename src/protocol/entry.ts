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
  /** Connecting-city qualifier (trailing 3-letter hub): connections via it only. */
  connectingCity?: string;
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
  source: 'flight' | 'availability' | 'itinerary' | 'connect'; // connect = VCT* min-connect
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
  /**
   * Optional rebook leg for the single-entry cancel-and-rebook forms
   * (Sabre Basic Reservation Course, p.~52):
   *   `cpa_line`            — `X<sel>¥0<seats><class><line>` (e.g. `X3¥01F1`),
   *                            sell from the cached availability display.
   *   `same_flight_new_date` — `X<sel>¥00<date>` (e.g. `X1¥0025APR`), re-sell
   *                            the same carrier/flight/class on a new date.
   * The cancel is executed first; if the rebook then fails, the cancellation
   * still stands (per the Zenon course's note: agent recovers via `IR`).
   */
  rebook?:
    | { kind: 'cpa_line'; seats: number; bookingClass: string; line: number }
    | { kind: 'same_flight_new_date'; newDate: string };
}

export interface SegmentStatusEntry extends BaseEntry {
  kind: 'segment_status';
  segment: number;
  status: string; // e.g. "HK"
}

/**
 * Passive cancel (`.<sel>XK`) — remove segments from the agent's itinerary
 * while leaving the airline-side reservation in place. Source: Sabre Basic
 * Reservation Course, "Passively cancel segments, no message sent to the
 * airline" — format `.(segment selection)XK`, example `.1-3XK`. Selection
 * grammar mirrors the X cancel (single, list `1/3`, range `1-3`); whole-
 * itinerary form (XI/XIA) has no passive analog.
 */
export interface PassiveCancelEntry extends BaseEntry {
  kind: 'passive_cancel';
  segments: number[];
}

/** Move/insert segments: /<after>/<from>[-<to>] — /0/2 moves seg 2 to the front. */
export interface MoveEntry extends BaseEntry {
  kind: 'move';
  after: number; // insert after this segment (0 = front)
  from: number;
  to?: number; // range end (inclusive)
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
  // ¥-separated qualifiers:
  nameRef?: { item: number; passenger?: number }; // ¥N1.1 — price one passenger
  validatingCarrier?: string; // WPA<carrier> / ¥A
  currency?: string; // WPM<currency> / ¥M (label only, no conversion)
  taxMode?: 'none' | 'fees'; // WPTN (exempt all) / WPTE (exempt taxes, keep fees)
}

export interface IgnoreEntry extends BaseEntry {
  kind: 'ignore';
  /**
   * Set by Galileo `IR` (ignore + retrieve) — after the workbench is
   * discarded and the work area cleared, re-retrieve whatever BF was
   * last on screen (by locator if there is one). Plain `I` leaves it
   * unset and the work area stays empty.
   */
  retrieve?: boolean;
}

export interface SignInEntry extends BaseEntry {
  kind: 'sign_in';
  argument: string;
}

/** Divide a PNR: D<refs> — split named passengers into a new PNR. */
export interface DivideEntry extends BaseEntry {
  kind: 'divide';
  refs: { item: number; passenger?: number }[];
}

/**
 * Queue ops:
 *   place   QP/<queue>[/<pic>]  — place the current PNR on a queue
 *   access  Q/<queue>           — access a queue, pull its first PNR
 *   remove  QR                  — remove the on-screen PNR, advance to the next
 *   exit    QX / QXI / QXE      — leave the queue without working the rest
 */
export interface QueueEntry extends BaseEntry {
  kind: 'queue';
  /**
   * `exit_ignore_redisplay` (QXIR) and `exit_end_redisplay` (QXER) are the
   * Zenon-course exit-and-redisplay variants — QXIR discards work-area
   * changes and brings the pristine PNR back; QXER end-transacts (commits)
   * and redisplays. Both leave the queue afterward.
   */
  op:
    | 'place'
    | 'access'
    | 'remove'
    /** `QRQ/ALL` — remove BF from ALL queues in the agency PCC. */
    | 'remove_all_in_pcc'
    | 'exit'
    /** `QXI` — exit + ignore active BF (composes with I semantics). */
    | 'exit_ignore'
    /** `QXE` — exit + end transaction (composes with E semantics). */
    | 'exit_end_tx'
    | 'exit_ignore_redisplay'
    | 'exit_end_redisplay'
    | 'skip'
    | 'requeue';
  queue?: string; // queue id (number, letter G/S/T/L, or PCC+letter like 2EA0G)
  pic?: string; // placement instruction code (QP/100/75)
  /**
   * Set by Galileo `QEB/<queue>` (combined end-transaction + place); absent
   * for plain `QP/<queue>` which requires the BF to be already committed
   * (no embedded commit phase).
   */
  endTransaction?: boolean;
  /** QL → 'LMTC'; QU → 'UTR'. Re-queue op only. */
  requeueTarget?: 'LMTC' | 'UTR';
  /**
   * Short message (≤15 chars per Zenon source) attached to a QL/QU. Logged
   * as a general remark on the PNR — Zenon note 1: "Entry logged in
   * Remarks Field of PNR if message added".
   */
  requeueMessage?: string;
  /**
   * QBI skip (Zenon course): `QBI¥4` moves forward 4 PNRs; `QBI-3` moves
   * backward 3 PNRs. Positive = forward (drops N from the queue front and
   * loads the new front); negative = backward (rejected — backward
   * navigation needs queue-cursor history we don't model).
   */
  skipCount?: number;
  /**
   * Multi-target chained placement (Zenon course): `QP/G¥S¥T` or
   * `QP/2EA0G¥5OT0S¥A`. The first target is in `queue`/`pic`; the rest
   * land here. Up to 9 addresses per the source. Place-op only.
   */
  additionalTargets?: { queue: string; pic?: string }[];
}

/** File a divided PNR (F) — commit the new PNR and restore the original. */
export interface FileEntry extends BaseEntry {
  kind: 'file';
}

/**
 * Issue e-ticket(s): W¥ / TTP issue for the whole PNR, W¥PQ<n> from a stored
 * PQ record, W¥N<item> for one name field. Optional ¥-separated qualifiers
 * after the base entry: validating carrier (A<carrier>), commission
 * percentage (KP<n>), commission flat amount (K<amount>). Source-grounded
 * via the single Basic Reservation Course example `W¥PQ1¥KP0¥ALH` (p.6 ICK
 * table footer, showing the cross-of-Lorraine as a qualifier separator).
 */
export interface TicketEntry extends BaseEntry {
  kind: 'ticket';
  source: 'pnr' | 'pq'; // price-as-booked/last quote vs a stored PQ record
  pqRecord?: number; // W¥PQ<n> — single PQ
  /**
   * `W¥PQ<n>-<m>` / `W¥PQ<n>/<m>` / `W¥PQ<n>-<m>/<o>` — multi-PQ list (Issue
   * Tickets QR p.1, "Issue tickets for multiple Enhanced PQ records").
   * Max 4 per QR source; ranges must be ascending; ticketing fulfills in
   * sequential order regardless of how the agent typed them.
   */
  pqRecords?: number[];
  /**
   * `W¥PQ<n>N<dotted>(¥PQ<m>N<dotted>)*` — per-PQ named selection (QR p.1
   * verbatim: `W¥PQ2N1.2¥PQ5N1.3-1.5`). Max 4 PQs per source; ticketing
   * fulfills in sequential order. Each entry pairs a PQ record with an
   * explicit list of passenger refs (range/list/single via
   * parsePassengerSelection).
   */
  pqNamedSelections?: { record: number; names: import('../utils/passenger-ref.js').PassengerRef[] }[];
  nameItem?: number; // W¥N<item>
  /** `A<carrier>` (e.g. ALH → LH) — override the validating carrier for issue. */
  validatingCarrier?: string;
  /** `KP<n>` commission percentage (whole number, no decimal in source example). */
  commissionPercent?: number;
  /** `K<amount>` commission flat amount in the fare-quote currency. */
  commissionAmount?: number;
  /** `S<n>` — issue ticket for a specific segment (Issue Tickets QR p.2). */
  segment?: number;
  /** `XETR` — issue a paper ticket overriding the default electronic ticketing (ARC only, p.3). */
  paperTicket?: boolean;
  /** `F<fop>` — form of payment (Issue Tickets QR p.2-3, four shapes). */
  formOfPayment?: FormOfPayment;
  /** `CVV<n>` — credit-card security code (separate ¥-qualifier alongside the F*<cc>/<exp> token). */
  cvv?: string;
  /** `DP` — issue ticket and invoice/itinerary document together (QR p.2; must appear last). */
  invoice?: boolean;
}

/**
 * Form of payment for the W¥F qualifier. Source: Issue Tickets QR p.2-3
 * verbatim formats:
 *   W¥FCASH                                              kind: 'cash'
 *   W¥FCHECK | W¥FCHEQUE | W¥FCK                          kind: 'check'
 *   W¥F*<cc><number>/<MMYY>(¥CVV<n>)                     kind: 'credit_card'
 *   W¥F*<cc><number>/<MMYY>*E<months>                    + extendedMonths
 *   W¥F*<cc><number>/<MMYY>*Z<approval>                  + approvalCode
 *   W¥F*Z<approval>                                      kind: 'preapproved'
 *                                                        (CC sits in PNR FOP field)
 */
export type FormOfPayment =
  | { kind: 'cash' }
  | { kind: 'check' }
  | {
      kind: 'credit_card';
      cardCode: string; // two-letter card code (VI/AX/MC/DC/CB/JC)
      cardNumber: string;
      expiry: string; // MMYY
      extendedMonths?: number;
      approvalCode?: string;
    }
  | { kind: 'preapproved'; approvalCode: string };

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
  | PassiveCancelEntry
  | MoveEntry
  | ModifyEntry
  | PricingEntry
  | EndTransactionEntry
  | IgnoreEntry
  | SignInEntry
  | SignOutEntry
  | DivideEntry
  | FileEntry
  | QueueEntry
  | TicketEntry
  | AuditTrailEntry
  | RefundEntry
  | CancelRefundEntry
  | AccountingDeleteEntry
  | AccountingAddEntry
  | AccountingModifyEntry
  | TicketDocumentDisplayEntry
  | VoidEntry
  | SwitchAreaEntry
  | UnsupportedEntry;

/**
 * Display an ETR (Electronic Ticket Record) or its database image.
 * Source: Sabre Ticket Display Tools QR p.1-2.
 *
 *   WETR*              redisplay last ETR
 *   WETR*<n>           by *T item number
 *   WETR*T<13-digit>   by ticket number
 *   WETR*<n>/E         enhanced (NVA/NVB + baggage + FCI)
 *   WETR*H             ETR history
 *   WTDB*<n>           database ticket image by *T item
 *   WTDB*T<13-digit>   image by ticket number
 *   WTDB*<n>/OB        image + OB ticketing fees
 *
 * Without a per-coupon model on TicketRecord, the renderer derives the
 * coupon (per-segment) lines from the PNR's segments. Flag the
 * approximation when this becomes load-bearing.
 */
export interface TicketDocumentDisplayEntry extends BaseEntry {
  kind: 'ticket_document_display';
  family: 'etr' | 'image';
  mode: 'redisplay' | 'by_item' | 'by_ticket' | 'history';
  itemNumber?: number;
  ticketNumber?: string;
  /** `/E` for WETR enhanced; `/OB` for WTDB OB-fees. */
  enhanced?: boolean;
}

/**
 * Delete accounting-line(s) (`AC¤…`). Source: Sabre Accounting Lines QR
 * p.1 verbatim:
 *   AC¤1           delete one accounting line
 *   AC¤ALL         delete all accounting lines
 *   AC¤3-5         delete a range
 *   AC¤1,3,6       delete a list
 * The separator here is `¤` (change key), NOT `¥` (cross of Lorraine) —
 * the QR p.1 documents this explicitly. Keyboard-alias `[` maps to `¤`,
 * so the parser handles ASCII `AC[1` as well.
 */
export interface AccountingDeleteEntry extends BaseEntry {
  kind: 'accounting_delete';
  /** `'all'` deletes the whole field; otherwise `lines` carries the explicit list. */
  mode: 'lines' | 'all';
  lines: number[];
}

/**
 * Add a manual accounting line (`AC/<carrier>/<tkt>/…`). Source: Sabre
 * Accounting Lines QR p.1. Parser populates every documented field; the
 * handler appends one ManualAccountingLine to the PNR.
 */
export interface AccountingAddEntry extends BaseEntry {
  kind: 'accounting_add';
  line: import('../models/manual-accounting.js').ManualAccountingLine;
}

/**
 * Modify an accounting line (`AC<n>/<carrier>[/<commission>]`). Source:
 * Sabre Accounting Lines QR p.1 — the QR notes the modify forms are
 * valid only for manual lines and NIET auto lines; the emulator allows
 * modify on any line and updates either the ManualAccountingLine in
 * place or the underlying TicketRecord depending on which range the
 * line number falls into.
 */
export interface AccountingModifyEntry extends BaseEntry {
  kind: 'accounting_modify';
  lineNumber: number;
  newCarrier: string;
  /**
   * Optional new commission. `commission` is the numeric value; the
   * flag captures whether it was supplied as a percentage (`P<n>`)
   * vs a flat amount.
   */
  newCommission?: number;
  newCommissionPercent?: boolean;
}

/**
 * Cancel a refund within the same day (`WTRX<ticket>`). Source: Zenon
 * QREX manual p.21 — quotes both legs of the two-step flow verbatim:
 *
 *   First entry:    WTRX0485633742763 «
 *                   RE-ENTER TO CANCEL REFUND FOR TKT
 *                   0485633742763
 *
 *   Re-enter same:  WTRX0485633742763 «
 *                   OK-REFUND
 *                   CANCELLED
 *
 * Two strings landed VERBATIM from QREX p.21 (third-party transcription
 * but quoted exactly). Same-day window isn't enforced — the emulator
 * doesn't model wall-clock cutoffs.
 */
export interface CancelRefundEntry extends BaseEntry {
  kind: 'cancel_refund';
  ticketNumber: string;
}

/**
 * Refund a ticket (`WFR<ticket>`) or its taxes only (`WFRT<ticket>`).
 * Source: Zenon QREX manual pp.7-9 (verbatim entries + mask responses
 * for the refund flow). Third-party transcription of Sabre's QREX
 * sigil family — strings landed from here are flagged "verbatim-
 * third-party" rather than first-party Sabre.
 *
 *   WFR<13-digit-ticket>           full refund
 *   WFRT<13-digit-ticket>          tax-only refund
 *
 * The QREX `WFR<ticket>¥AGF` "agent fare" qualifier and `WFR*` redisplay
 * are deferred to a follow-up — this commit lands the minimum
 * status-changing surface so the *TA / *TI partition (added in 690d6bd)
 * becomes meaningful end-to-end.
 */
export interface RefundEntry extends BaseEntry {
  kind: 'refund';
  /** `'redisplay'` is the WFR* form; the others carry a ticket number. */
  mode: 'full' | 'tax_only' | 'redisplay';
  ticketNumber?: string;
  /**
   * `¥AGF` — "agent's fare" qualifier (QREX p.7). Flags that the refund
   * uses the agent's filed fare rather than the published one; the
   * emulator records the flag but doesn't yet model fare-rule differences.
   */
  agentFare?: boolean;
  /**
   * `¥N<dotted-name>` — name-selected refund (QREX p.31 example
   * `WFR0012324252627¥N2.1¥AAA`). Dotted refs are `<item>.<passenger>`.
   */
  nameRefs?: import('../utils/passenger-ref.js').PassengerRef[];
}

/**
 * Audit Trail Report (DQB asterisk) — daily/branch ticket-issuance log.
 * Source: Sabre-Ticket-Display-Tools-QR.pdf p.2 (verbatim formats below;
 * `*` and `/` show through as plain glyphs in the doc, but JSDoc closes
 * its own block on a literal asterisk-slash so the examples below are
 * spaced to avoid that).
 *
 *   DQB *                  today's audit (current day, current PCC)
 *   DQB * 01OCT            specific day of current year (DDMMM)
 *   DQB * 12FEB01          specific day in previous year (DDMMMYY)
 *   DQB *  /B4T0           today, an authorized branch PCC
 *   DQB * 01OCT/B4T0       day + branch
 *   DQB * DELETE | DQB * YES   delete (requires EPR ATBRPT + duty code 9,
 *                              which the emulator doesn't enforce —
 *                              modeled as a no-op stub).
 */
export interface AuditTrailEntry extends BaseEntry {
  kind: 'audit_trail';
  mode: 'display' | 'delete_request' | 'delete_confirm';
  /** Sabre date token (`01OCT`, `12FEB01`, …). Empty / undefined = today. */
  date?: string;
  /** Branch PCC argument — the `B4T0` in `DQB*` + `/B4T0`. */
  branch?: string;
}

/**
 * Switch to a different work area. Sabre form: `¤<letter>` per the
 * Basic Reservation Course p.7 ("Change to a different work area:
 * A,B,C,D,E, or F", response e.g. `PCC0.PCC0*ALJ..D`). Galileo form:
 * `SA`/`SB`/`SC`/`SD`/`SE` per the Travelport+ Mini Format Guide v2
 * p.5 ("SB — Change to work area B"). Both dialects produce the same
 * semantic kind here; only the parsed surface syntax differs.
 *
 * `targetArea` is uppercased to a single letter. The handler delegates
 * to `WorkArea.switchTo()` which returns false on an invalid letter;
 * the response in that case is dialect-specific (FORMAT).
 */
export interface SwitchAreaEntry extends BaseEntry {
  kind: 'switch_area';
  targetArea: string;
}

/**
 * Void a ticket (`WV` family). Source: Sabre Travel Network Middle East
 * Quick Reference Guide (Sept 2007) p.13. The QR documents entries
 * verbatim but does NOT show host responses — those land reconstructed
 * in `void-handler.ts` and are flagged there.
 *
 * Forms (per QR p.13):
 *   WV<n>                                  void by *T item number; "(Twice)" —
 *                                          must be re-entered to confirm.
 *   WV‡<tkt>/<amount>/<fop>/<date>/<carrier>/<count>
 *                                          manual void when the ticket
 *                                          doesn't appear in *T.
 *   WV *                                   list of all voids same month.
 *   WV *DT<DDMMM>                          voids for one day.
 *   WV *DT<DDMMM>-<DDMMM>                  voids for a date range.
 *
 * Examples spaced to avoid the JSDoc literal asterisk-slash gotcha
 * (`*` + `/` would close the block). On the wire the entries are
 * contiguous: `WV*`, `WV*DT15SEP`, `WV*DT15SEP-30SEP`.
 *
 * Same-day cutoff (Sabre's real WV is constrained to "before midnight
 * GMT of the issue day") isn't enforced — the emulator doesn't model
 * wall-clock cutoffs, consistent with WTRX.
 */
export interface VoidEntry extends BaseEntry {
  kind: 'void';
  mode: 'by_item' | 'manual' | 'list_month' | 'list_day' | 'list_range';
  /** by_item: 1-indexed line on the on-screen PNR's *T field. */
  itemNumber?: number;
  /** manual: 13-digit ticket number from the WV‡ form. */
  ticketNumber?: string;
  /** manual: amount string as typed ("USD500.00") — kept raw, no FX parsing. */
  amount?: string;
  /** manual: form-of-payment / stub reference (e.g. "JMKQLM"). */
  fop?: string;
  /** manual: SabreDate string (DDMMM, e.g. "03JUN"). */
  date?: string;
  /** manual: validating carrier (e.g. "CA"). */
  carrier?: string;
  /** manual: coupon count. */
  count?: number;
  /** list_day / list_range: start of the window (DDMMM). */
  fromDate?: string;
  /** list_range: end of the window (DDMMM). */
  toDate?: string;
}
