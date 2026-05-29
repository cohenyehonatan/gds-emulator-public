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

/** Per-area state — one of these per slot in a WorkArea's areas map. */
export class WorkAreaSlot {
  readonly machine = new SessionMachine();
  pnr = new Pnr();
  lastAvailability?: AvailabilityResult;
  lastPricing?: FareQuote;
  dividedOriginal?: Pnr;
  currentQueue?: string;
  queueCursor?: number;
  lastSimilarNameList?: Pnr[];
  pendingCancelRefundTicket?: string;
  lastRefundResponse?: string;
  lastTicketDocument?: string;
  pendingVoid?:
    | { kind: 'by_item'; itemNumber: number }
    | { kind: 'manual'; ticketNumber: string };

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
    this.lastSimilarNameList = undefined;
    this.pendingCancelRefundTicket = undefined;
    this.lastRefundResponse = undefined;
    this.lastTicketDocument = undefined;
    this.pendingVoid = undefined;
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
}
