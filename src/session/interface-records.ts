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
        const body = [
          `* EMULATED ${r.kind} INTERFACE RECORD - layout reconstructed (real ${r.kind} spec is proprietary)`,
          `INVOICE ${String(r.invoiceNumber).padStart(7, '0')}`,
          `PCC ${r.pcc}`,
          `LOCATOR ${r.locator}`,
          `PASSENGER ${r.passenger}`,
          `DOCUMENT ${r.documentNumber}`,
          `TOTAL ${r.currency}${r.total.toFixed(2)}`,
          `CREATED ${r.createdAt.toISOString()}`,
        ].join('\n');
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
