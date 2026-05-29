/** Shared dependencies passed to every handler. */

import type { Inventory } from '../../store/inventory.js';
import type { PnrStore } from '../../store/pnr-store.js';
import type { Backend } from '../../backends/backend.js';
import { MONTHS, parseSabreDate } from '../../utils/validation.js';

export interface HandlerContext {
  /**
   * v5 backend (the where-answers-come-from axis). For now both `backend`
   * and the duplicated `inventory`/`pnrStore`/`queues`/`ticketSerial`
   * fields below point at the same data — handlers can read either
   * during the in-progress step-1 migration. Step 2 removes the
   * duplicated fields and routes every consumer through `backend`.
   */
  backend: Backend;
  inventory: Inventory;
  pnrStore: PnrStore;
  /** Pseudo City Code used in signature lines (e.g. "A0UC"). */
  pcc: string;
  /** Work queues for this PCC: queue id → ordered list of PNR locators. */
  queues: Map<string, string[]>;
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

/** A Sabre date token shifted by N days (year roll-forward like the GDS). */
export function shiftDate(dateToken: string, days: number): { raw: string; month: number; day: number } | null {
  const p = parseSabreDate(dateToken);
  if (!p) return null;
  const now = new Date();
  let d = new Date(now.getFullYear(), p.date.month, p.date.day);
  if (d < now) d = new Date(now.getFullYear() + 1, p.date.month, p.date.day);
  d.setDate(d.getDate() + days);
  return { raw: `${d.getDate()}${MONTHS[d.getMonth()]}`, month: d.getMonth(), day: d.getDate() };
}

/**
 * The day after a Sabre date token — used to render a next-day arrival on an
 * overnight segment (workbook "800A 24NOV M/E"). Returns the new token plus its
 * letter and numeric day-of-week.
 */
export function nextDay(dateToken: string): { raw: string; letter: string; num: number } | null {
  const parsed = parseSabreDate(dateToken);
  if (!parsed) return null;
  const now = new Date();
  let d = new Date(now.getFullYear(), parsed.date.month, parsed.date.day);
  if (d < now) d = new Date(now.getFullYear() + 1, parsed.date.month, parsed.date.day);
  d.setDate(d.getDate() + 1);
  const js = d.getDay();
  return {
    raw: `${d.getDate()}${MONTHS[d.getMonth()]}`,
    letter: DOW_LETTERS[js],
    num: js === 0 ? 7 : js,
  };
}
