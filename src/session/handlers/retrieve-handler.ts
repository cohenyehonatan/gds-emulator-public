/**
 * Handle '*' display / retrieve.
 *
 *   *ABCDEF   → retrieve PNR by record locator (EMPTY → DISPLAYED)
 *   *-SMITH   → retrieve by surname; a numbered list when >1 matches
 *   *<n>      → pick line N from the cached similar-name list (Sabre Basic
 *               Reservation Course, "Display specific PNR from similar name
 *               list" — format `*(PNR list number)`, e.g. `*3`)
 *   *A        → redisplay the whole work-area PNR
 *   *N *I/*IA *P *T → redisplay one section (no state change)
 *
 * TODO (ROADMAP): *H history.
 */

import type { DisplayEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { SessionEvent } from '../session-state.js';
import { Response } from '../../dialects/sabre/responses.js';
import { isRecordLocator } from '../../models/record-locator.js';
import {
  renderPnr,
  renderNames,
  renderItinerary,
  renderPhones,
  renderTicketing,
  renderSimilarNameList,
  renderPriceQuotes,
  renderRemarks,
  renderFrequentFlyers,
  renderAccountingLines,
} from '../../protocol/serializer.js';
import type { Pnr } from '../../models/pnr.js';
import type { HandlerContext } from './context.js';

/** Section codes that redisplay part of the current work-area PNR (T variants
 *  handled separately below for the QR's 6-way active/inactive × order split). */
const SECTIONS: Record<string, (pnr: Pnr) => string> = {
  A: renderPnr,
  N: renderNames,
  I: renderItinerary,
  IA: renderItinerary,
  P: renderPhones,
};

/** Ticket-display variants (Sabre Ticket Display Tools QR p.1). */
const T_VARIANTS = new Set(['T', 'T/N', 'TA', 'TA/O', 'TI', 'TI/O']);

export function handleRetrieve(entry: DisplayEntry, wa: WorkArea, ctx: HandlerContext): string {
  const arg = entry.argument;
  const sig = { pcc: ctx.pcc, agent: wa.agent };

  // Queue status: *Q shows the queue currently being accessed and its depth.
  if (arg === 'Q') {
    if (!wa.currentQueue) return 'NO QUEUE ACCESSED';
    const n = (ctx.queues.get(wa.currentQueue) ?? []).length;
    return `QUEUE ${wa.currentQueue} - ${n} PNR${n === 1 ? '' : 'S'}`;
  }

  // Stored price quotes: *PQ (all) or *PQ<n> (one).
  if (arg === 'PQ') return renderPriceQuotes(wa.pnr);
  if (/^PQ\d+$/.test(arg)) return renderPriceQuotes(wa.pnr, parseInt(arg.slice(2), 10));

  // Remarks field: *P5.
  if (arg === 'P5') return wa.pnr.hasContent() ? renderRemarks(wa.pnr) : Response.NO_PNR;
  // Frequent flyer: *FF.
  if (arg === 'FF') return wa.pnr.hasContent() ? renderFrequentFlyers(wa.pnr) : Response.NO_PNR;
  // Accounting field: *PAC (Sabre Accounting Lines QR p.1).
  if (arg === 'PAC') return wa.pnr.hasContent() ? renderAccountingLines(wa.pnr) : Response.NO_PNR;

  // *T family — six variants per the Ticket Display Tools QR p.1:
  //   *T      all (active+inactive), oldest-first    (the natural array order)
  //   *T/N    all, newest-first
  //   *TA     active only, newest-first
  //   *TA/O   active only, oldest-first
  //   *TI     inactive only, newest-first
  //   *TI/O   inactive only, oldest-first
  // "Active" = status OPEN or ACTL; everything else (voided, refunded,
  // exchanged) is inactive — matches the QR's definition exactly.
  if (T_VARIANTS.has(arg)) {
    if (!wa.pnr.hasContent()) return Response.NO_PNR;
    const filter: 'all' | 'active' | 'inactive' = arg.startsWith('TA')
      ? 'active'
      : arg.startsWith('TI')
        ? 'inactive'
        : 'all';
    // Newest-first when: it's the *T's `/N` override, or it's a TA/TI without
    // the `/O` override (since TA/TI default to newest-first per the QR).
    const reverse = (filter === 'all' && arg.endsWith('/N'))
      || (filter !== 'all' && !arg.endsWith('/O'));
    return renderTicketing(wa.pnr, { filter, reverse });
  }

  // Redisplay current work area: '*A' (all), '*N/*I/*P' (sections), or bare '*'.
  const sectionKey = arg === '' ? 'A' : arg;
  if (sectionKey in SECTIONS) {
    if (!wa.pnr.hasContent()) return Response.NO_PNR;
    return sectionKey === 'A' ? renderPnr(wa.pnr, sig) : SECTIONS[sectionKey](wa.pnr);
  }

  // Pick from cached similar-name list: '*<n>' after a '*-SMITH' that
  // matched >1 PNR. The list is consumed on selection so a stale '*1'
  // doesn't grab from a no-longer-on-screen list.
  if (/^\d+$/.test(arg) && wa.lastSimilarNameList) {
    const matches = wa.lastSimilarNameList;
    const idx = parseInt(arg, 10) - 1;
    if (idx < 0 || idx >= matches.length) return Response.RECORD_LOCATOR_NOT_FOUND;
    wa.lastSimilarNameList = undefined;
    wa.pnr = matches[idx];
    wa.machine.transition(SessionEvent.RETRIEVE);
    return renderPnr(wa.pnr, sig);
  }

  // Retrieve by surname: '*-SMITH'
  if (arg.startsWith('-')) {
    const matches = ctx.pnrStore.findBySurname(arg.slice(1));
    if (matches.length === 0) {
      wa.lastSimilarNameList = undefined;
      return Response.RECORD_LOCATOR_NOT_FOUND;
    }
    if (matches.length > 1) {
      wa.lastSimilarNameList = matches; // cache for '*<n>' selection
      return renderSimilarNameList(matches);
    }
    wa.lastSimilarNameList = undefined;
    wa.pnr = matches[0];
    wa.machine.transition(SessionEvent.RETRIEVE);
    return renderPnr(wa.pnr, sig);
  }

  // Retrieve by record locator: '*ABCDEF'
  if (isRecordLocator(arg)) {
    const pnr = ctx.pnrStore.get(arg);
    if (!pnr) return Response.RECORD_LOCATOR_NOT_FOUND;
    wa.pnr = pnr;
    wa.machine.transition(SessionEvent.RETRIEVE);
    return renderPnr(pnr, sig);
  }

  return Response.FORMAT;
}
