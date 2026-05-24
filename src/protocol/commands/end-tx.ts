/**
 * End-transaction entry.
 *   E   end transaction (workbook p.6)
 *   ER  end and redisplay the PNR
 *   ET  end transaction (explicit)
 *
 * Mandatory-field validation lives in the end-tx handler, not here — this
 * only classifies the entry. Matched longest-first (ER/ET before E).
 */

import type { EndTransactionEntry } from '../entry.js';

export function parseEndTransaction(raw: string): EndTransactionEntry {
  const redisplay = raw.toUpperCase() === 'ER';
  return { kind: 'end_transaction', raw, timestamp: new Date(), redisplay };
}
