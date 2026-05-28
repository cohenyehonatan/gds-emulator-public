/**
 * AAA work area — the per-terminal scratch space.
 *
 * Holds the PNR currently being assembled or displayed, plus the last
 * availability result (so a '0' sell can resolve a line number). Wraps the
 * session FSM. One WorkArea per connected terminal.
 */

import { SessionMachine } from './session-machine.js';
import { SessionState } from './session-state.js';
import { Pnr } from '../models/pnr.js';
import type { AvailabilityResult } from '../models/availability-result.js';
import type { FareQuote } from '../models/fare.js';

export class WorkArea {
  readonly machine = new SessionMachine();
  pnr = new Pnr();
  lastAvailability?: AvailabilityResult;
  lastPricing?: FareQuote;
  /** Original PNR stashed during a divide, awaiting File (F). */
  dividedOriginal?: Pnr;
  /** Queue currently being accessed in this area (Q/<n>); only one at a time. */
  currentQueue?: string;
  /**
   * Cursor (0-indexed) into the current queue's list. Mutated by QR/QL/QU
   * (which splice at the cursor and leave it pointing at the next PNR) and by
   * QBI¥N / QBI-N (which move the cursor without mutating the list — matching
   * the source's "ignores" vs "removes" distinction). Undefined when no
   * queue is accessed.
   */
  queueCursor?: number;
  /**
   * Most recent similar-name list (from `*-SMITH` when surname matched >1
   * PNR), cached so a subsequent `*<n>` selects line N. Cleared on the
   * selection, on a new similar-name search, on a no-match search, or on
   * any work-area reset (End Transaction / Ignore / sign-out).
   */
  lastSimilarNameList?: Pnr[];
  /**
   * Pending WTRX (cancel refund) — the ticket number the agent typed once,
   * awaiting their second WTRX to confirm. Per QREX p.21's two-step flow.
   * Cleared on confirmation, on a different ticket WTRX, or on reset.
   */
  pendingCancelRefundTicket?: string;
  /** Last refund-response string; redisplayed by `WFR*`. */
  lastRefundResponse?: string;
  agent?: string;
  /** Work-area letter (A–F); single area per session in v1. */
  area = 'A';

  state(): SessionState {
    return this.machine.getState();
  }

  /** Clear the work area after End Transaction or Ignore. */
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
  }
}
