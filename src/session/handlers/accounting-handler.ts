/**
 * Accounting-line delete handler (AC¤…). Source: Sabre Accounting Lines
 * QR p.1. Soft-deletes lines from the work-area PNR's *PAC view — the
 * underlying TicketRecord stays (so *T still surfaces it) and only its
 * accounting-line projection is hidden.
 */

import type { AccountingDeleteEntry, AccountingAddEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { Response } from '../../dialects/sabre/responses.js';

export function handleAccountingDelete(entry: AccountingDeleteEntry, wa: WorkArea): string {
  const pnr = wa.pnr;
  if (!pnr.hasContent()) return Response.NO_PNR;
  const totalLines = pnr.tickets.length + pnr.manualAccountingLines.length;
  if (totalLines === 0) return 'NO ACCOUNTING DATA'; // nothing to delete

  if (entry.mode === 'all') {
    for (let n = 1; n <= totalLines; n++) pnr.accountingLinesHidden.add(n);
    return 'OK'; // reconstructed; QR doesn't quote a success string
  }

  // Validate every targeted line exists before mutating.
  for (const n of entry.lines) {
    if (n < 1 || n > totalLines) return 'ACCOUNTING LINE NOT FOUND'; // reconstructed
  }
  for (const n of entry.lines) pnr.accountingLinesHidden.add(n);
  return 'OK';
}

export function handleAccountingAdd(entry: AccountingAddEntry, wa: WorkArea): string {
  if (!wa.pnr.hasContent()) return Response.NO_PNR;
  wa.pnr.manualAccountingLines.push(entry.line);
  return 'OK'; // reconstructed; QR documents entry but not response
}
