/**
 * Accounting-line delete handler (AC¤…). Source: Sabre Accounting Lines
 * QR p.1. Soft-deletes lines from the work-area PNR's *PAC view — the
 * underlying TicketRecord stays (so *T still surfaces it) and only its
 * accounting-line projection is hidden.
 */

import type {
  AccountingDeleteEntry,
  AccountingAddEntry,
  AccountingModifyEntry,
} from '../../protocol/entry.js';
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

/**
 * Modify the carrier (and optionally commission) on accounting line N.
 * Line numbering is the same as renderAccountingLines uses: auto-from-
 * tickets first (1..T), then manual lines (T+1..T+M). The handler updates
 * either the underlying TicketRecord (auto range) or the manual line.
 */
export function handleAccountingModify(entry: AccountingModifyEntry, wa: WorkArea): string {
  const pnr = wa.pnr;
  if (!pnr.hasContent()) return Response.NO_PNR;
  const n = entry.lineNumber;
  const ticketCount = pnr.tickets.length;
  const total = ticketCount + pnr.manualAccountingLines.length;
  if (n < 1 || n > total) return 'ACCOUNTING LINE NOT FOUND'; // reconstructed

  if (n <= ticketCount) {
    const t = pnr.tickets[n - 1];
    t.validatingCarrier = entry.newCarrier;
    if (entry.newCommission != null) {
      // Auto-line commission is a flat amount; if the agent typed P<n>%
      // we resolve it against the base fare at modify time.
      t.commission = entry.newCommissionPercent
        ? (t.base * entry.newCommission) / 100
        : entry.newCommission;
    }
    return 'OK';
  }
  const m = pnr.manualAccountingLines[n - ticketCount - 1];
  m.validatingCarrier = entry.newCarrier;
  if (entry.newCommission != null) {
    m.commission = entry.newCommission;
    m.commissionPercent = entry.newCommissionPercent ?? false;
  }
  return 'OK';
}
