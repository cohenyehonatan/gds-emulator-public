/**
 * Persisted PNRs keyed by record locator — the analog of pectab's
 * pectab-store. In-memory for v1; a JSON-file backend is a trivial later add.
 */

import { Pnr } from '../models/pnr.js';
import { generateRecordLocator } from '../models/record-locator.js';

export class PnrStore {
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
