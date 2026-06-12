/**
 * Back-office interface pipeline — the GDS→accounting flow described
 * in the Tres "Sabre GDS Integration — Setup and Interface" guide
 * (trestechnologieshelp.zendesk.com, article 13959576143763) and
 * common to every GDS:
 *
 *   ticket/invoice issued → interface record generated → held on a
 *   Point-of-Sale (POS) queue → transmitted as one file per record
 *   to a directory (Sabre's SJPM writes .txt files) → an upload
 *   utility ships them to the back office (Tres / TBO / etc.)
 *
 * The CONCEPT is dialect-agnostic; the record names aren't:
 *   Sabre IUR · Amadeus AIR · Galileo/Apollo MIR · Worldspan IR
 * The Sabre CONTROL verbs (DX/DW/DV families) are wired from the
 * article's verbatim entries; record FILE CONTENT is reconstructed —
 * the real IUR/AIR/MIR layouts are proprietary and unpublished.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export type InterfaceRecordKind = 'IUR' | 'AIR' | 'MIR' | 'IR';

export interface InterfaceRecord {
  seq: number;
  invoiceNumber: number;
  kind: InterfaceRecordKind;
  locator: string;
  passenger: string;
  documentNumber: string;
  total: number;
  currency: string;
  pcc: string;
  createdAt: Date;
  transmitted: boolean;
}

/**
 * Per-kind record body. Structure follows the now-in-tree specs
 * (references/interface/): the Sabre IUR Programmer Guide v40's
 * M0-M9 sub-records with their 2-char message IDs, the Travelport
 * MIR User Guide's T5 header (T50TRC system code, T50SPC accounting
 * code — Galileo 7733 / Apollo 5880), and the Trams Amadeus guide's
 * AIR interface level 206. Full fixed-column fidelity is NOT
 * claimed — the specs are in-tree for that — but the record/section
 * skeleton is real, not invented.
 */
export function recordBody(r: InterfaceRecord): string {
  const inv = String(r.invoiceNumber).padStart(7, '0');
  if (r.kind === 'IUR') {
    return [
      `M0${r.pcc} 40 ${inv} ${r.locator} ${r.createdAt.toISOString().slice(0, 10)}`, // Control+Constant (IU0MID/IU0VER)
      `M1${r.passenger}`,                                  // Passenger Invoice Data
      `M2${r.documentNumber} ${r.currency}${r.total.toFixed(2)}`, // Ticket Data
      `M5${r.currency}${r.total.toFixed(2)} TTL`,          // Accounting Data
    ].join('\n');
  }
  if (r.kind === 'MIR') {
    const trc = '1G'; // T50TRC — transmitting CRS (1G GCS / 1V APO)
    const spc = '7733'; // T50SPC — Galileo accounting code (Apollo 5880)
    return [
      `T5${trc}${spc}${inv}${r.locator}`,  // Header Section (T50BID begins T5)
      `A02 ${r.passenger}`,                 // Passenger Data Section
      `A07 ${r.documentNumber} ${r.currency}${r.total.toFixed(2)}`, // Fare Value Section
    ].join('\n');
  }
  if (r.kind === 'AIR') {
    return [
      'AIR-BLK206;1A;',                     // interface level 206 (Trams guide)
      `AMD ${r.pcc};${inv};${r.locator}`,
      `I-${r.passenger}`,
      `T-${r.documentNumber};${r.currency}${r.total.toFixed(2)}`,
    ].join('\n');
  }
  return [`IR ${r.pcc} ${inv} ${r.locator} ${r.passenger} ${r.documentNumber} ${r.currency}${r.total.toFixed(2)}`].join('\n');
}

export class InterfacePos {
  /** POS queue status (article: "On hold" / "Active"). */
  status: 'ON HOLD' | 'ACTIVE' = 'ON HOLD';
  /** Next invoice number (DV family; article: DV1 / DV1234). */
  nextInvoice = 1;
  records: InterfaceRecord[] = [];
  history: { at: Date; text: string }[] = [];
  /** TJR-style toggles (W/VOD¥ON etc.) — accepted + remembered. */
  readonly settings = new Map<string, string>();
  /** Where transmission writes the per-record files (SJPM emulation). */
  outputDir = process.env.GDS_INTERFACE_DIR ?? './interface-output';

  /** Generate a record at ticket/invoice time (Interface Option 6). */
  generate(rec: Omit<InterfaceRecord, 'seq' | 'invoiceNumber' | 'createdAt' | 'transmitted'>): InterfaceRecord {
    const full: InterfaceRecord = {
      ...rec,
      seq: this.records.length + 1,
      invoiceNumber: this.nextInvoice++,
      createdAt: new Date(),
      transmitted: false,
    };
    this.records.push(full);
    this.log(`RECORD ${full.seq} GENERATED INV ${full.invoiceNumber} ${full.kind} ${full.locator}`);
    return full;
  }

  pending(): InterfaceRecord[] {
    return this.records.filter((r) => !r.transmitted);
  }

  /**
   * Transmit pending records — one .txt file per record, like SJPM's
   * multiple-file mode. File body layout is RECONSTRUCTED (real IUR/
   * AIR/MIR layouts are proprietary); the header says so.
   */
  transmit(): { sent: number; error?: string } {
    const queue = this.pending();
    try {
      mkdirSync(this.outputDir, { recursive: true });
      for (const r of queue) {
        const body = recordBody(r);
        writeFileSync(join(this.outputDir, `${r.pcc}-${String(r.invoiceNumber).padStart(7, '0')}.txt`), body + '\n');
        r.transmitted = true;
      }
      this.log(`TRANSMITTED ${queue.length} RECORD(S) TO ${this.outputDir}`);
      return { sent: queue.length };
    } catch (err) {
      // The article's most common failure, verbatim reason code.
      this.log('TMO NO ACK RCVD');
      return { sent: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Today's transmitted records — the DWLIST ("daily work list"). */
  dwlist(): InterfaceRecord[] {
    const today = new Date().toDateString();
    return this.records.filter((r) => r.transmitted && r.createdAt.toDateString() === today);
  }

  log(text: string): void {
    this.history.push({ at: new Date(), text });
  }
}
