/**
 * Persisted PNRs keyed by record locator — the analog of pectab's
 * pectab-store. In-memory for v1; a JSON-file backend is a trivial later add.
 */

import { Pnr } from '../models/pnr.js';
import { generateRecordLocator } from '../models/record-locator.js';

/**
 * Read/write surface shared by the in-memory `PnrStore` and any
 * persistent variant (`JsonFilePnrStore`). Backends type
 * `pnrs: PnrStoreLike` so either can drop in via the constructor.
 */
export interface PnrStoreLike {
  commit(pnr: Pnr): string;
  get(locator: string): Pnr | undefined;
  findBySurname(surname: string): Pnr[];
  /** Find PNRs that contain at least one segment matching the
   *  carrier+flight+date triple. Used by Amadeus LP / Sabre flight-list
   *  cryptics. Carrier is the 2-char IATA code; flight is the numeric
   *  flight number as a string (no padding). Date is the DDMON form
   *  the segment carries (e.g. "15JUL"). */
  findByFlight(carrier: string, flightNumber: string, date: string): Pnr[];
  has(locator: string): boolean;
  values(): Pnr[];
  readonly size: number;
}

export class PnrStore implements PnrStoreLike {
  private byLocator = new Map<string, Pnr>();

  /** Commit a PNR: assign a unique locator (if absent), stamp, store. */
  commit(pnr: Pnr): string {
    if (!pnr.locator) {
      pnr.locator = generateRecordLocator((loc) => this.byLocator.has(loc));
    }
    pnr.createdAt ??= new Date();
    this.byLocator.set(pnr.locator, pnr);
    return pnr.locator;
  }

  get(locator: string): Pnr | undefined {
    return this.byLocator.get(locator.toUpperCase());
  }

  /** Find PNRs whose any name surname matches (case-insensitive). */
  findBySurname(surname: string): Pnr[] {
    const target = surname.toUpperCase();
    return [...this.byLocator.values()].filter((p) =>
      p.names.some((n) => n.surname.toUpperCase() === target)
    );
  }

  findByFlight(carrier: string, flightNumber: string, date: string): Pnr[] {
    const c = carrier.toUpperCase();
    const f = String(flightNumber);
    const d = date.toUpperCase();
    return [...this.byLocator.values()].filter((p) =>
      p.segments.some(
        (s) => s.carrier.toUpperCase() === c && s.flightNumber === f && s.date.toUpperCase() === d
      )
    );
  }

  has(locator: string): boolean {
    return this.byLocator.has(locator.toUpperCase());
  }

  /** All stored PNRs (e.g. for system-wide reports like the DQB* audit trail). */
  values(): Pnr[] {
    return [...this.byLocator.values()];
  }

  get size(): number {
    return this.byLocator.size;
  }
}
