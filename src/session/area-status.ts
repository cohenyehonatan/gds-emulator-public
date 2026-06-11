/**
 * Work-area status display — Sabre `*S` / `*S*`, Amadeus `JD`,
 * Galileo `OP/W*` (and Worldspan `B$` via translation). The ENTRIES
 * are source-documented (Sabre Basic Course p.7, Amadeus QRG p.9,
 * the Comparison Guide's Worldspan column); none of the sources show
 * the response screens, so the layout is reconstructed: one row per
 * area with an active marker, the per-slot session state, and the
 * session-level agent sign.
 */

import type { WorkArea } from './work-area.js';

export function renderAreaStatus(wa: WorkArea, onlyActive = false): string {
  const rows = wa
    .allAreaLetters()
    .filter((l) => !onlyActive || l === wa.area)
    .map((l) => {
      const slot = wa.slot(l)!;
      const marker = l === wa.area ? '*' : ' ';
      const state = slot.machine.getState();
      const pnr = slot.pnr.hasContent() ? ' PNR IN PROGRESS' : '';
      return `${marker}${l}  ${state}${state === 'SIGNED_OFF' ? '' : `  ${wa.agent ?? ''}`}${pnr}`.trimEnd();
    });
  return ['WORK AREAS', ...rows].join('\n');
}
