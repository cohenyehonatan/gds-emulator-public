/**
 * AAA work area — a per-terminal scratch space holding up to six
 * independent areas (A-F per the Sabre Basic Reservation Course p.7).
 *
 * Each area is its own `WorkAreaSlot` carrying the FSM, PNR-in-progress,
 * last availability/pricing, queue cursor, and every pending two-step
 * flow state. Switching between areas via the cryptic switch entry
 * (Sabre `¤<letter>`, Galileo `SA`-`SE`) leaves the inactive areas
 * untouched, matching the source's "entries made in the active area
 * do not affect the work you do in another area".
 *
 * `WorkArea` itself is the container: it owns the slots, the active
 * letter, and the session-level fields that span all areas (`agent`,
 * captured at sign-on per the Sabre/Galileo conventions).
 *
 * For backward compatibility with the v1-v3 codebase, every per-area
 * field is exposed as a getter/setter that delegates to the active
 * slot — so handlers can read `wa.pnr` and write `wa.pnr = new Pnr()`
 * exactly as before. Only the new switch logic and full-state methods
 * (`switchTo`, `allAreaLetters`, `resetAll`) are net-new surface.
 */

import { SessionMachine } from './session-machine.js';
import { SessionState } from './session-state.js';
import { Pnr } from '../models/pnr.js';
import type { AvailabilityResult } from '../models/availability-result.js';
import type { FareQuote } from '../models/fare.js';
import type { FareDisplayResult } from '../models/fare-display.js';

/** Per-area state — one of these per slot in a WorkArea's areas map. */
export class WorkAreaSlot {
  readonly machine = new SessionMachine();
  pnr = new Pnr();
  lastAvailability?: AvailabilityResult;
  lastPricing?: FareQuote;
  dividedOriginal?: Pnr;
  currentQueue?: string;
  queueCursor?: number;
  /**
   * Locators captured at `Q/<n>` access time — the working set the
   * agent traverses with QP / QPI / I / QR / QX. Cursor (`queueCursor`)
   * indexes into this array. Cleared on QX-family exit or `reset()`.
   * Real Galileo loads the BF at the cursor onto screen; navigation
   * verbs move the cursor and re-load.
   */
  queueWorkingSet?: string[];
  /**
   * Per-BF "modified since cursor load" flag inside a queue working
   * set. Set by any modify op (X cancel, @<n>HK, @<n>XK, sell-onto-
   * retrieved-BF) when `currentQueue` is populated. Cleared whenever
   * we reload the BF at the cursor (Q/<n>, QP navigation, QR/I
   * advance). Used by QP to refuse a navigation that would lose
   * unsaved changes; QPI ignores the flag and navigates anyway.
   */
  queueCurrentDirty?: boolean;
  lastSimilarNameList?: Pnr[];
  pendingCancelRefundTicket?: string;
  lastRefundResponse?: string;
  lastTicketDocument?: string;
  pendingVoid?:
    | { kind: 'by_item'; itemNumber: number }
    | { kind: 'manual'; ticketNumber: string };
  /**
   * In-flight Travelport workbenchID for LiveTravelportBackend builds.
   * Populated on the first live sell (which creates the workbench);
   * reused for follow-on entries (name, ER) so the whole cryptic build
   * targets one workbench. Consumed on commit (E / ER) and cleared on
   * reset, matching the workbench's 30-minute server-side TTL.
   * Undefined for EmulatedBackend slots and for live slots that haven't
   * started a build yet. See references/galileo/Travelport-JSON-Air-v11-
   * API-Spec.md "Workbench → WorkArea mapping".
   */
  liveWorkbenchId?: string;
  /**
   * Cached result of the most recent `FD<...>` fare display. Holds
   * the server-assigned `Identifier.value` plus per-line `sequence`
   * → carrier/booking-class mapping so a follow-on `FN<...>` query
   * can call `GET /farerule/farerules/fromfaredisplay` with the
   * right `fareRuleIdentifier` + `FareID`. Cleared on `reset()`.
   */
  lastFareDisplay?: FareDisplayResult;

  /**
   * Cached result of the most recent `SM <segment>` seat-map query.
   * Holds the displayed SeatMap plus the segment number it was queried
   * against; chunk 7's scrolling verbs (MD/MU/MB/MT) operate on this.
   * Cleared on `reset()` and on `SM <m>` for a different segment.
   * Per `docs/seatmap-design.md` chunk 0: SeatMap lives on WorkArea
   * (query state) not Pnr (booking state).
   */
  lastSeatMap?: { segment: number; map: import('../models/seat-map.js').SeatMap };

  /**
   * Server-assigned traveler UUIDs returned by `addTraveler`,
   * order-aligned with `pnr.names` flattened by `passengers[]`. Used
   * by SSR / remarks live wiring to reference passengers via
   * `TravelerIdentifier.id` / `.Identifier.value`. Empty for
   * EmulatedBackend; populated only when live `addTraveler` succeeds
   * and surfaces a parseable Identifier in the response.
   */
  liveTravelerIds?: string[];

  /**
   * Workbench-side offer UUIDs assigned by `addOffer` (one per leg).
   * Downstream live operations whose body needs `AppliesTo.OfferIdentifier`
   * (SSR, segment-scoped remarks) must reference these UUIDs, NOT the
   * search-side short refs in `AvailabilityLine.vendorRef.offerId` —
   * pre-prod returns `OFFER ID/IDENTIFIER VALUES MUST MATCH WITH THE
   * RESERVATION WORKBENCH OFFER ID/IDENTIFIER VALUES` when the wrong
   * one is sent. Index-aligned with `pnr.segments` (each leg's sell
   * adds one entry). EmulatedBackend leaves this undefined.
   */
  liveWorkbenchOfferIds?: string[];

  /**
   * Clear the per-PNR scratch state — invoked by IG / E / a sign-out
   * that targets this slot. Crucially does NOT replace `machine`: the
   * session FSM is intentionally durable across IG/E (a signed-in agent
   * stays signed in after an IG, just with an empty work area). The
   * pre-refactor `WorkArea.reset()` had the same semantics; this method
   * is the slot-level port.
   */
  reset(): void {
    this.pnr = new Pnr();
    this.lastAvailability = undefined;
    this.lastPricing = undefined;
    this.dividedOriginal = undefined;
    this.currentQueue = undefined;
    this.queueCursor = undefined;
    this.queueWorkingSet = undefined;
    this.queueCurrentDirty = undefined;
    this.lastSimilarNameList = undefined;
    this.pendingCancelRefundTicket = undefined;
    this.lastRefundResponse = undefined;
    this.lastTicketDocument = undefined;
    this.pendingVoid = undefined;
    this.liveWorkbenchId = undefined;
    this.liveTravelerIds = undefined;
    this.liveWorkbenchOfferIds = undefined;
    this.lastFareDisplay = undefined;
    this.lastSeatMap = undefined;
  }
}

const DEFAULT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

export class WorkArea {
  private readonly slots = new Map<string, WorkAreaSlot>();
  private active = 'A';
  /** Agent code from sign-on. Session-level: spans all areas (Sabre QR p.7). */
  agent?: string;

  constructor(letters: readonly string[] = DEFAULT_LETTERS) {
    if (letters.length === 0) throw new Error('WorkArea: need at least one area letter');
    for (const l of letters) this.slots.set(l, new WorkAreaSlot());
    this.active = letters[0];
  }

  /** Currently-active area letter (e.g. "A", "D"). */
  get area(): string {
    return this.active;
  }

  /** All area letters this work-area was constructed with, in order. */
  allAreaLetters(): string[] {
    return [...this.slots.keys()];
  }

  /**
   * Switch the active slot. Returns false if `letter` isn't one of the
   * configured areas (e.g. attempting `¤Z` on a 6-area Sabre work area).
   */
  switchTo(letter: string): boolean {
    if (!this.slots.has(letter)) return false;
    this.active = letter;
    return true;
  }

  /** Direct access to a specific slot (e.g. for area-status displays). */
  slot(letter: string): WorkAreaSlot | undefined {
    return this.slots.get(letter);
  }

  state(): SessionState {
    return this.machine.getState();
  }

  /**
   * Clear the *active* area's per-PNR state after End Transaction or
   * Ignore. Preserves the slot's SessionMachine — a signed-in agent
   * stays signed in after IG/E, just with an empty work area (matching
   * the pre-multi-area v1-v3 semantics).
   */
  reset(): void {
    this.s.reset();
  }

  /** Clear *every* area — used by `SO*` (sign out all). */
  resetAll(): void {
    for (const slot of this.slots.values()) slot.reset();
  }

  // --- Per-area accessors: every field below delegates to the active slot
  // so handlers written before v5 (which only ever touched area A) keep
  // working unchanged. Each pair is a one-line read/write forwarder.

  private get s(): WorkAreaSlot {
    return this.slots.get(this.active)!;
  }

  get machine(): SessionMachine {
    return this.s.machine;
  }
  get pnr(): Pnr {
    return this.s.pnr;
  }
  set pnr(v: Pnr) {
    this.s.pnr = v;
  }
  get lastAvailability(): AvailabilityResult | undefined {
    return this.s.lastAvailability;
  }
  set lastAvailability(v: AvailabilityResult | undefined) {
    this.s.lastAvailability = v;
  }
  get lastPricing(): FareQuote | undefined {
    return this.s.lastPricing;
  }
  set lastPricing(v: FareQuote | undefined) {
    this.s.lastPricing = v;
  }
  get dividedOriginal(): Pnr | undefined {
    return this.s.dividedOriginal;
  }
  set dividedOriginal(v: Pnr | undefined) {
    this.s.dividedOriginal = v;
  }
  get currentQueue(): string | undefined {
    return this.s.currentQueue;
  }
  set currentQueue(v: string | undefined) {
    this.s.currentQueue = v;
  }
  get queueCursor(): number | undefined {
    return this.s.queueCursor;
  }
  set queueCursor(v: number | undefined) {
    this.s.queueCursor = v;
  }
  get queueWorkingSet(): string[] | undefined {
    return this.s.queueWorkingSet;
  }
  set queueWorkingSet(v: string[] | undefined) {
    this.s.queueWorkingSet = v;
  }
  get queueCurrentDirty(): boolean | undefined {
    return this.s.queueCurrentDirty;
  }
  set queueCurrentDirty(v: boolean | undefined) {
    this.s.queueCurrentDirty = v;
  }
  get lastSimilarNameList(): Pnr[] | undefined {
    return this.s.lastSimilarNameList;
  }
  set lastSimilarNameList(v: Pnr[] | undefined) {
    this.s.lastSimilarNameList = v;
  }
  get pendingCancelRefundTicket(): string | undefined {
    return this.s.pendingCancelRefundTicket;
  }
  set pendingCancelRefundTicket(v: string | undefined) {
    this.s.pendingCancelRefundTicket = v;
  }
  get lastRefundResponse(): string | undefined {
    return this.s.lastRefundResponse;
  }
  set lastRefundResponse(v: string | undefined) {
    this.s.lastRefundResponse = v;
  }
  get lastTicketDocument(): string | undefined {
    return this.s.lastTicketDocument;
  }
  set lastTicketDocument(v: string | undefined) {
    this.s.lastTicketDocument = v;
  }
  get pendingVoid(): WorkAreaSlot['pendingVoid'] {
    return this.s.pendingVoid;
  }
  set pendingVoid(v: WorkAreaSlot['pendingVoid']) {
    this.s.pendingVoid = v;
  }
  get liveWorkbenchId(): string | undefined {
    return this.s.liveWorkbenchId;
  }
  set liveWorkbenchId(v: string | undefined) {
    this.s.liveWorkbenchId = v;
  }
  get liveTravelerIds(): string[] | undefined {
    return this.s.liveTravelerIds;
  }
  set liveTravelerIds(v: string[] | undefined) {
    this.s.liveTravelerIds = v;
  }
  get liveWorkbenchOfferIds(): string[] | undefined {
    return this.s.liveWorkbenchOfferIds;
  }
  set liveWorkbenchOfferIds(v: string[] | undefined) {
    this.s.liveWorkbenchOfferIds = v;
  }
  get lastFareDisplay(): FareDisplayResult | undefined {
    return this.s.lastFareDisplay;
  }
  set lastFareDisplay(v: FareDisplayResult | undefined) {
    this.s.lastFareDisplay = v;
  }
  get lastSeatMap(): WorkAreaSlot['lastSeatMap'] {
    return this.s.lastSeatMap;
  }
  set lastSeatMap(v: WorkAreaSlot['lastSeatMap']) {
    this.s.lastSeatMap = v;
  }
}
