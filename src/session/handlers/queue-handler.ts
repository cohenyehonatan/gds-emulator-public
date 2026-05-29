/**
 * Queue handler (Zenon "QUEUES").
 *
 * A queue is an ordered list of committed-PNR locators held at the PCC level
 * (ctx.backend.queues), so it survives end-transaction and is shared across work areas.
 *
 *   QP/<q>[/<pic>]  place the on-screen (committed) PNR on queue <q>
 *   Q/<q>           access queue <q> — pull the first PNR onto the screen
 *   QR              remove the on-screen PNR from the queue, advance to next
 *   QL / QU         re-queue to LMTC / UTR, advance to next
 *   QBI¥N / QBI-N   move the queue cursor forward/backward N — does NOT
 *                   remove anything (the source says "ignores", not "removes")
 *   QX/QXI/QXE      exit the queue without working the rest
 *   QXIR / QXER     exit-and-redisplay variants
 *
 * Cursor model. The queue's list is a fixed sequence; the per-WorkArea
 * `queueCursor` is the on-screen position (0-indexed). QR/QL/QU splice at
 * the cursor (the on-screen PNR leaves the queue; the cursor now points at
 * the PNR that took its place). QBI just moves the cursor — backward
 * navigation lands on previously-skipped PNRs that are still in the queue.
 * This matches the Zenon source's deliberate "removes" vs "ignores" split.
 *
 * Working a queue replaces the on-screen PNR with the next (RETRIEVE event),
 * so it is legal from EMPTY or DISPLAYED but not mid-build (BUILDING → OUT
 * OF SEQUENCE, like any other retrieve).
 *
 * NOTE: the queue prompt/confirmation strings below are reconstructed — the
 * reference course describes the *entries* but not their exact host responses.
 */

import type { QueueEntry, EndTransactionEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { SessionEvent, SessionState } from '../session-state.js';
import { renderPnr } from '../../protocol/serializer.js';
import { handleEndTransaction } from './end-tx-handler.js';
import type { HandlerContext } from './context.js';

const NO_QUEUE = 'NO QUEUE ACCESSED'; // reconstructed
const pnrCount = (n: number): string => `${n} PNR${n === 1 ? '' : 'S'}`;

/**
 * Pull the PNR at `wa.queueCursor` onto the screen, advancing past stale
 * locators (PNRs that no longer resolve in the store). If the cursor runs
 * past the end of the queue, exit the queue and return "QUEUE X EMPTY".
 */
function loadAtCursor(wa: WorkArea, ctx: HandlerContext, q: string): string {
  const list = ctx.backend.queues.get(q) ?? [];
  while ((wa.queueCursor ?? 0) < list.length) {
    const cursor = wa.queueCursor!;
    const pnr = ctx.backend.pnrs.get(list[cursor]);
    if (!pnr) {
      list.splice(cursor, 1); // stale locator — housekeeping, cursor stays
      ctx.backend.queues.set(q, list);
      continue;
    }
    wa.pnr = pnr;
    wa.machine.transition(SessionEvent.RETRIEVE);
    const header = `QUEUE ${q} - ${pnrCount(list.length)}`;
    return `${header}\n${renderPnr(pnr, { pcc: ctx.pcc, agent: wa.agent })}`;
  }
  wa.currentQueue = undefined;
  wa.queueCursor = undefined;
  return `QUEUE ${q} EMPTY`;
}

export function handleQueue(entry: QueueEntry, wa: WorkArea, ctx: HandlerContext): string {
  switch (entry.op) {
    case 'place': {
      const loc = wa.pnr.locator;
      if (!loc || !ctx.backend.pnrs.has(loc)) return 'FINISH OR IGNORE'; // must be committed first
      const targets = [
        { queue: entry.queue!, pic: entry.pic },
        ...(entry.additionalTargets ?? []),
      ];
      for (const t of targets) {
        const list = ctx.backend.queues.get(t.queue) ?? [];
        if (!list.includes(loc)) list.push(loc); // idempotent: no duplicate placement
        ctx.backend.queues.set(t.queue, list);
      }
      return `QUEUED ${targets.map((t) => t.queue).join(' ')}`;
    }

    case 'access': {
      const q = entry.queue!;
      wa.currentQueue = q;
      wa.queueCursor = 0;
      const list = ctx.backend.queues.get(q) ?? [];
      if (list.length === 0) {
        wa.currentQueue = undefined;
        wa.queueCursor = undefined;
        return `QUEUE ${q} EMPTY`;
      }
      return loadAtCursor(wa, ctx, q);
    }

    case 'remove': {
      const q = wa.currentQueue;
      if (q == null || wa.queueCursor == null) return NO_QUEUE;
      const list = ctx.backend.queues.get(q) ?? [];
      list.splice(wa.queueCursor, 1); // remove the on-screen PNR at the cursor
      ctx.backend.queues.set(q, list);
      // Cursor stays — now points at whoever moved into the vacated slot.
      return loadAtCursor(wa, ctx, q);
    }

    case 'exit': {
      if (!wa.currentQueue) return NO_QUEUE;
      const q = wa.currentQueue;
      wa.currentQueue = undefined;
      wa.queueCursor = undefined;
      return `QUEUE ${q} EXITED`;
    }

    case 'exit_ignore_redisplay': {
      // QXIR — ignore work-area changes, exit queue, redisplay the PNR
      // (Zenon course p.54). Requires a PNR on screen and a queue context.
      if (!wa.currentQueue) return NO_QUEUE;
      const loc = wa.pnr.locator;
      if (!loc) return 'NO PNR IN AAA'; // no on-screen PNR to redisplay
      wa.machine.transition(SessionEvent.IGNORE);
      wa.reset();
      const pnr = ctx.backend.pnrs.get(loc);
      if (!pnr) return 'IGNORED'; // committed locator vanished — degenerate but possible
      wa.pnr = pnr;
      wa.machine.transition(SessionEvent.RETRIEVE);
      return renderPnr(pnr, { pcc: ctx.pcc, agent: wa.agent });
    }

    case 'requeue': {
      // QL → LMTC (Left Message to Contact), QU → UTR (Under Reservation).
      // Splices the on-screen PNR out of the current queue at the cursor and
      // places it on the follow-up queue. Optional message gets logged as a
      // general remark on the PNR (Zenon note 1: "Entry logged in Remarks
      // Field of PNR if message added"). The source's auto-requeue-after-24h
      // (LMTC) / 15min-4h (UTR) timer behavior isn't modeled — no wall clock.
      const q = wa.currentQueue;
      if (q == null || wa.queueCursor == null) return NO_QUEUE;
      const list = ctx.backend.queues.get(q) ?? [];
      if (list.length === 0 || wa.queueCursor >= list.length) return `QUEUE ${q} EMPTY`;
      const loc = list[wa.queueCursor];
      if (entry.requeueMessage) {
        const pnr = ctx.backend.pnrs.get(loc);
        if (pnr) {
          pnr.remarks.push({
            type: 'general',
            text: `Q${entry.requeueTarget === 'LMTC' ? 'L' : 'U'}-${entry.requeueMessage}`,
          });
        }
      }
      list.splice(wa.queueCursor, 1);
      ctx.backend.queues.set(q, list);
      const followUp = ctx.backend.queues.get(entry.requeueTarget!) ?? [];
      if (!followUp.includes(loc)) followUp.push(loc);
      ctx.backend.queues.set(entry.requeueTarget!, followUp);
      return loadAtCursor(wa, ctx, q);
    }

    case 'skip': {
      // QBI¥N (positive) moves the cursor forward; QBI-N (negative) backward.
      // The queue list is NOT mutated — the source says "ignores", not
      // "removes". Past the end → exit queue (worked past). Past the start →
      // clamp at 0.
      const q = wa.currentQueue;
      if (q == null || wa.queueCursor == null) return NO_QUEUE;
      const list = ctx.backend.queues.get(q) ?? [];
      const n = entry.skipCount ?? 0;
      const next = wa.queueCursor + n;
      if (next >= list.length) {
        wa.currentQueue = undefined;
        wa.queueCursor = undefined;
        return `QUEUE ${q} EMPTY`;
      }
      wa.queueCursor = Math.max(0, next);
      return loadAtCursor(wa, ctx, q);
    }

    case 'exit_end_redisplay': {
      // QXER — end-transact (commits PNR), exit queue, redisplay PNR
      // (Zenon course p.54). If end-tx rejects (missing field, names mismatch),
      // the agent stays in the queue context to correct.
      if (!wa.currentQueue) return NO_QUEUE;
      const fakeEr: EndTransactionEntry = {
        kind: 'end_transaction',
        raw: '',
        timestamp: new Date(),
        redisplay: true,
      };
      const result = handleEndTransaction(fakeEr, wa, ctx);
      // handleEndTransaction resets the work area on success (→ EMPTY) and
      // leaves it intact on failure (so the agent can fix the missing field).
      if (wa.state() !== SessionState.EMPTY) return result; // ET failed, stay
      wa.currentQueue = undefined;
      wa.queueCursor = undefined;
      return result;
    }

    case 'exit_ignore':
    case 'exit_end_tx':
    case 'remove_all_in_pcc':
      // Galileo-only verbs (QXI / QXE / QRQ/ALL) — the Galileo
      // dispatcher routes these through its own handlers. Sabre's
      // parser never emits them; if we ever see one here it's a
      // programming error.
      return 'FORMAT';
  }
}
