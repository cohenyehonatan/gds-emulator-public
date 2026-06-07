/**
 * JSON-file persistence backend for PnrStore.
 *
 * Behaves identically to the in-memory PnrStore at the API level
 * (commit / get / findBySurname / has / values / size), but the
 * Map is mirrored to a JSON file on every commit so PNRs persist
 * across process restarts.
 *
 * Usage:
 *   const store = new JsonFilePnrStore('./data/pnrs.json');
 *   // ... commit, query, etc.
 *
 * The file is read once at construction (or treated as empty if
 * missing). Writes are atomic: serialize → write to `${path}.tmp` →
 * rename. A crash mid-write leaves the original file intact.
 *
 * Date fields are serialized as ISO strings (via JSON.stringify's
 * default) and re-hydrated to Date instances on load. Set fields
 * (currently just `accountingLinesHidden`) are serialized as arrays
 * and re-hydrated as Set.
 *
 * v1 limitations:
 *   - Synchronous writes on commit. Fine for the expected workload
 *     (single-operator REPL session); a batched/debounced write
 *     would help if dozens of PNRs land in a tight loop.
 *   - No schema versioning. If Pnr's shape changes the loader
 *     tolerates missing fields (they default to empty arrays /
 *     undefined), so backwards compat is implicit, not enforced.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { Pnr } from '../models/pnr.js';
import { generateRecordLocator } from '../models/record-locator.js';

export class JsonFilePnrStore {
  private byLocator = new Map<string, Pnr>();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf8');
        if (raw.trim().length > 0) {
          const data = JSON.parse(raw) as unknown[];
          for (const plain of data) {
            const pnr = pnrFromPlain(plain as Record<string, unknown>);
            if (pnr.locator) this.byLocator.set(pnr.locator, pnr);
          }
        }
      } catch (err) {
        // Malformed file — log and start fresh rather than crash. Operator
        // can investigate the file; the in-memory store keeps working.
        console.warn(
          `JsonFilePnrStore: failed to load ${path}: ${err instanceof Error ? err.message : String(err)} — starting with empty store`
        );
      }
    }
  }

  commit(pnr: Pnr): string {
    if (!pnr.locator) {
      pnr.locator = generateRecordLocator((loc) => this.byLocator.has(loc));
    }
    pnr.createdAt ??= new Date();
    this.byLocator.set(pnr.locator, pnr);
    this.flush();
    return pnr.locator;
  }

  get(locator: string): Pnr | undefined {
    return this.byLocator.get(locator.toUpperCase());
  }

  findBySurname(surname: string): Pnr[] {
    const target = surname.toUpperCase();
    return [...this.byLocator.values()].filter((p) =>
      p.names.some((n) => n.surname.toUpperCase() === target)
    );
  }

  has(locator: string): boolean {
    return this.byLocator.has(locator.toUpperCase());
  }

  values(): Pnr[] {
    return [...this.byLocator.values()];
  }

  get size(): number {
    return this.byLocator.size;
  }

  /** Atomic write: serialize → tmp file → rename. */
  private flush(): void {
    const data = [...this.byLocator.values()].map(pnrToPlain);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}

/**
 * Plain-object snapshot of a Pnr. Sets become arrays so JSON round-trip
 * works; everything else relies on JSON.stringify's defaults (Date →
 * ISO string).
 */
function pnrToPlain(pnr: Pnr): Record<string, unknown> {
  return {
    locator: pnr.locator,
    names: pnr.names,
    segments: pnr.segments,
    phones: pnr.phones,
    ssrs: pnr.ssrs,
    osis: pnr.osis,
    remarks: pnr.remarks,
    frequentFlyers: pnr.frequentFlyers,
    priceQuotes: pnr.priceQuotes,
    tickets: pnr.tickets,
    manualAccountingLines: pnr.manualAccountingLines,
    accountingHistory: pnr.accountingHistory,
    history: pnr.history,
    accountingLinesHidden: [...pnr.accountingLinesHidden],
    ticketing: pnr.ticketing,
    optionField: pnr.optionField,
    receivedFrom: pnr.receivedFrom,
    createdAt: pnr.createdAt?.toISOString(),
  };
}

/**
 * Inverse of pnrToPlain: hydrates a Pnr instance from the plain object.
 * Tolerates missing fields (defaults to empty arrays / undefined) so
 * schema evolution stays forward-compat.
 */
function pnrFromPlain(plain: Record<string, unknown>): Pnr {
  const p = new Pnr();
  p.locator = plain.locator as string | undefined;
  p.names = (plain.names as Pnr['names']) ?? [];
  p.segments = (plain.segments as Pnr['segments']) ?? [];
  p.phones = (plain.phones as Pnr['phones']) ?? [];
  p.ssrs = (plain.ssrs as Pnr['ssrs']) ?? [];
  p.osis = (plain.osis as Pnr['osis']) ?? [];
  p.remarks = (plain.remarks as Pnr['remarks']) ?? [];
  p.frequentFlyers = (plain.frequentFlyers as Pnr['frequentFlyers']) ?? [];
  p.priceQuotes = (plain.priceQuotes as Pnr['priceQuotes']) ?? [];
  p.tickets = (plain.tickets as Pnr['tickets']) ?? [];
  p.manualAccountingLines = (plain.manualAccountingLines as Pnr['manualAccountingLines']) ?? [];
  p.accountingHistory = (plain.accountingHistory as Pnr['accountingHistory']) ?? [];
  p.history = (plain.history as Pnr['history']) ?? [];
  p.accountingLinesHidden = new Set((plain.accountingLinesHidden as number[]) ?? []);
  p.ticketing = plain.ticketing as string | undefined;
  p.optionField = plain.optionField as string | undefined;
  p.receivedFrom = plain.receivedFrom as string | undefined;
  if (typeof plain.createdAt === 'string') p.createdAt = new Date(plain.createdAt);
  return p;
}
