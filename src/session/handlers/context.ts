/** Shared dependencies passed to every handler. */

import type { Inventory } from '../../store/inventory.js';
import type { PnrStore } from '../../store/pnr-store.js';

export interface HandlerContext {
  inventory: Inventory;
  pnrStore: PnrStore;
}

/** Single-letter day-of-week for a Sabre date in the current (or next) year. */
export function dayOfWeekLetter(month: number, day: number): string {
  const now = new Date();
  let d = new Date(now.getFullYear(), month, day);
  if (d < now) d = new Date(now.getFullYear() + 1, month, day); // roll forward like a GDS
  return ['S', 'M', 'T', 'W', 'Q', 'F', 'J'][d.getDay()]; // Sabre: Thu=Q, Sat=J (TODO confirm)
}
