/**
 * Backend — the second axis of the v5 Dialect ⊥ Backend matrix.
 *
 * A **dialect** owns the cryptic-content surface (parser, serializer,
 * keyboard, screen profile, FSM rules — see src/dialects/dialect.ts).
 * A **backend** owns where the answers come from:
 *
 *   - EmulatedBackend reads/writes the local in-memory inventory,
 *     tariff, PNR store, and queues. Used by every test today.
 *   - LiveTravelportBackend (later) translates cryptic ⟷ Travelport
 *     TripServices REST against the 7K9S pre-prod tenant (OAuth
 *     password grant validated 2026-05-27).
 *
 * Same dialect runs against either backend; same backend can serve
 * either dialect. The two axes don't intersect except at this
 * interface, which is why the matrix in ROADMAP.md works.
 *
 * Step 1 of v5 (this commit) introduces the Backend interface and
 * EmulatedBackend with no behaviour change — handlers still read the
 * duplicated HandlerContext fields. Step 2 migrates the handlers to
 * `ctx.backend.X` and removes the duplication.
 */

import { Inventory } from '../store/inventory.js';
import { PnrStore, type PnrStoreLike } from '../store/pnr-store.js';
import { InterfacePos } from '../session/interface-records.js';

export interface Backend {
  /** Stable identifier, e.g. "emulated" or "travelport-1g". */
  readonly id: string;
  /** Human-readable name for logs and the /health endpoint. */
  readonly displayName: string;
  /** Flight schedule + per-class seat-count store. */
  readonly inventory: Inventory;
  /** PNR persistence keyed by locator. v1 = in-memory PnrStore; can be
   *  swapped for JsonFilePnrStore (persistent across sessions) via the
   *  backend constructor's `pnrStore` option. */
  readonly pnrs: PnrStoreLike;
  /**
   * Queue routing: queue id → ordered list of PNR locators. Shared
   * across work areas, survives end-transaction. Owned by the backend
   * because in the live path each tenant's queues live on the vendor
   * side and need their own adapter.
   */
  readonly queues: Map<string, string[]>;
  /** Back-office interface pipeline (POS queue, DX/DW/DV verbs). */
  readonly interfacePos: InterfacePos;
  /**
   * Allocate the next monotonic ticket serial. The Sabre Issue-Tickets
   * QR's example numbers run to 10 digits; the emulated seed starts at
   * the QR's order of magnitude (4692507094). A live backend will
   * delegate this to vendor-issued numbers and ignore the local seed.
   */
  nextTicketSerial(): number;
}

export interface EmulatedBackendOptions {
  /** Override the starting ticket serial. Default matches the Sabre QR seed. */
  initialTicketSerial?: number;
  /** Swap in a different PNR store (e.g. JsonFilePnrStore for cross-
   *  session persistence). Default = a fresh in-memory PnrStore. */
  pnrStore?: PnrStoreLike;
  /** Queue map override — pass a JsonFileQueues for persistence. */
  queues?: Map<string, string[]>;
}

/**
 * The default Backend implementation — everything we shipped in v1-v3.
 * Owns its own Inventory, PnrStore, queues map, and serial counter so
 * two EmulatedBackend instances don't share state (lets the test suite
 * spin up isolated hosts).
 */
export class EmulatedBackend implements Backend {
  readonly id = 'emulated';
  readonly displayName = 'Emulated (local inventory + PNR store)';
  readonly inventory = new Inventory();
  readonly pnrs: PnrStoreLike;
  readonly queues: Map<string, string[]>;
  private serial: number;

  readonly interfacePos: InterfacePos;
  constructor(opts: EmulatedBackendOptions = {}) {
    this.serial = opts.initialTicketSerial ?? 4_692_507_094;
    this.pnrs = opts.pnrStore ?? new PnrStore();
    this.queues = opts.queues ?? new Map<string, string[]>();
    this.interfacePos = new InterfacePos();
  }

  nextTicketSerial(): number {
    return this.serial++;
  }
}
