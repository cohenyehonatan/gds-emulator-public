/**
 * Print spool — the GPM.net (Galileo Print Manager) side of the
 * house, emulated the way InterfacePos emulates SJPM: jobs land as
 * one file per print in a directory the "print daemon" would watch.
 *
 * Sources (extracted verbatim 2026-06-12, references/print/):
 *  - Galileo_and_Apollo_Print_Functions.htm — the P- command tables
 *    and the rule "you can print any field in the retrieved BF by
 *    preceding the display option with P-"
 *  - Restarting_the_Host_Queue.htm — printers are GTID-addressed
 *    (6-hex, e.g. C5F062); the printer buffer holds AT MOST ONE
 *    ticket image (count 0 or 1, per BF/PNR not per document);
 *    HQC/HQD/HQS/HQX<gtid> verbs with verbatim responses
 *    `SET ADDRESS <gtid> <nn>` and `RESTART IN PROGRESS - PLEASE
 *    WAIT`; restart requires the printer in up (U) status.
 *
 * What's reconstructed: the spool-file convention (GDS_PRINT_DIR,
 * one .txt per job — GPM.net's own output is driver-bound), the
 * on-screen P- confirmation wording, and the HQD/HQX/down-printer
 * response strings (the appendix documents the entries, not those
 * screens).
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface PrintJob {
  seq: number;
  gtid: string;
  /** The entry that produced the job (e.g. "P-*R"). */
  entry: string;
  /** Rendered screen content routed to the printer. */
  body: string;
  createdAt: Date;
}

interface PrinterDevice {
  gtid: string;
  /** Link status — U up / D down (HMOM semantics). */
  status: 'U' | 'D';
  /** The ≤1-deep ticket-image buffer (count is 0 or 1 per the
   *  appendix; it refers to BFs/PNRs, not passengers/documents). */
  ticketImage?: { locator: string; body: string };
}

/** Default printer GTID — the appendix's own example address. */
export const DEFAULT_PRINTER_GTID = 'C5F062';

export class PrintSpool {
  private seq = 0;
  private devices = new Map<string, PrinterDevice>();
  readonly jobs: PrintJob[] = [];
  outputDir = process.env.GDS_PRINT_DIR ?? './print-output';

  device(gtid: string): PrinterDevice {
    let d = this.devices.get(gtid);
    if (!d) {
      d = { gtid, status: 'U' };
      this.devices.set(gtid, d);
    }
    return d;
  }

  /** Route a rendered screen to the printer — one file per job. */
  print(entry: string, body: string, gtid: string = DEFAULT_PRINTER_GTID): PrintJob {
    const job: PrintJob = { seq: ++this.seq, gtid, entry, body, createdAt: new Date() };
    this.jobs.push(job);
    mkdirSync(this.outputDir, { recursive: true });
    writeFileSync(join(this.outputDir, `${gtid}-${String(job.seq).padStart(4, '0')}.txt`), body + '\n');
    return job;
  }

  /** TKP holds the ticket image in the printer buffer (≤1 deep). */
  holdTicketImage(locator: string, body: string, gtid: string = DEFAULT_PRINTER_GTID): void {
    this.device(gtid).ticketImage = { locator, body };
  }

  /** HQC<gtid> — verbatim response shape: `SET ADDRESS C5F062 01`. */
  queueCount(gtid: string): string {
    const count = this.device(gtid).ticketImage ? 1 : 0;
    return `SET ADDRESS ${gtid} ${String(count).padStart(2, '0')}`;
  }

  /** HQD<gtid> — queue contents (screen wording reconstructed). */
  queueDisplay(gtid: string): string {
    const img = this.device(gtid).ticketImage;
    if (!img) return `QUEUE ${gtid} EMPTY`; // reconstructed
    return [`QUEUE ${gtid}`, `  1  TICKET IMAGE  ${img.locator}`].join('\n'); // reconstructed
  }

  /**
   * HQS<gtid> — restart: forces any held ticket image out of the
   * buffer (to the spool). Verbatim response; the appendix requires
   * U status ("The printer must be in up (U) status").
   */
  restart(gtid: string): string {
    const d = this.device(gtid);
    if (d.status !== 'U') return `PRINTER ${gtid} DOWN - USE HMOM`; // reconstructed
    if (d.ticketImage) {
      this.print(`HQS${gtid}`, d.ticketImage.body, gtid);
      d.ticketImage = undefined;
    }
    return 'RESTART IN PROGRESS - PLEASE WAIT';
  }

  /** HQX<gtid> — delete queue contents (response reconstructed). */
  queueDelete(gtid: string): string {
    this.device(gtid).ticketImage = undefined;
    return `QUEUE ${gtid} DELETED`; // reconstructed
  }

  /** HMOM-style up/down toggle for a printer device. */
  setStatus(gtid: string, status: 'U' | 'D'): void {
    this.device(gtid).status = status;
  }
}
