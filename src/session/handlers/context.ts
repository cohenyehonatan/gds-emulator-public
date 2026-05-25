/** Shared dependencies passed to every handler. */

import type { Inventory } from '../../store/inventory.js';
import type { PnrStore } from '../../store/pnr-store.js';

export interface HandlerContext {
  inventory: Inventory;
  pnrStore: PnrStore;
  /** Pseudo City Code used in signature lines (e.g. "A0UC"). */
  pcc: string;
}

/**
 * Single-letter day-of-week for a Sabre date in the current (or next) year.
 *
 * Sabre's single-letter convention (used in the workbook's sold-segment line,
 * e.g. "23NOV S"): S=Sun M=Mon T=Tue W=Wed Q=Thu F=Fri J=Sat — Q and J stand
 * in for Thursday and Saturday because T and S are already taken. Indexed by
 * Date.getDay() (0=Sunday).
 */
const DOW_LETTERS = ['S', 'M', 'T', 'W', 'Q', 'F', 'J'] as const;

export function dayOfWeekLetter(month: number, day: number): string {
  const now = new Date();
  let d = new Date(now.getFullYear(), month, day);
  if (d < now) d = new Date(now.getFullYear() + 1, month, day); // roll forward like a GDS
  return DOW_LETTERS[d.getDay()];
}

/**
 * Numeric day-of-week (ISO: Mon=1 … Sun=7), used in the stored-PNR itinerary
 * and availability displays (workbook "24JUN 1", Zenon "20OCT 3").
 */
export function dayOfWeekNumber(month: number, day: number): number {
  const now = new Date();
  let d = new Date(now.getFullYear(), month, day);
  if (d < now) d = new Date(now.getFullYear() + 1, month, day);
  const js = d.getDay(); // 0=Sun … 6=Sat
  return js === 0 ? 7 : js;
}
