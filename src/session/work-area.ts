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

export class WorkArea {
  readonly machine = new SessionMachine();
  pnr = new Pnr();
  lastAvailability?: AvailabilityResult;
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
  }
}
