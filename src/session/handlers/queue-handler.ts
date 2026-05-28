/**
 * Queue handler (Zenon "QUEUES").
 *
 * A queue is an ordered list of committed-PNR locators held at the PCC level
 * (ctx.queues), so it survives end-transaction and is shared across work areas.
 *
 *   QP/<q>[/<pic>]  place the on-screen (committed) PNR on queue <q>
 *   Q/<q>           access queue <q> — pull its first PNR onto the screen
 *   QR              remove the on-screen PNR from the queue, advance to the next
 *   QX/QXI/QXE      exit the queue without working the rest
 *
 * Working a queue replaces the on-screen PNR with the next (RETRIEVE event), so
 * it is legal from EMPTY or DISPLAYED but not mid-build (BUILDING → OUT OF
 * SEQUENCE, like any other retrieve).
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

/** Pull the front PNR of queue <q> onto the screen, skipping stale locators. */
function loadFront(wa: WorkArea, ctx: HandlerContext, q: string): string {
  const list = ctx.queues.get(q) ?? [];
  while (list.length > 0) {
    const pnr = ctx.pnrStore.get(list[0]);
    if (!pnr) {
      list.shift(); // locator no longer resolves — drop it and try the next
      continue;
    }
    wa.pnr = pnr;
    wa.machine.transition(SessionEvent.RETRIEVE);
    const header = `QUEUE ${q} - ${pnrCount(list.length)}`;
    return `${header}\n${renderPnr(pnr, { pcc: ctx.pcc, agent: wa.agent })}`;
  }
  wa.currentQueue = undefined;
  return `QUEUE ${q} EMPTY`;
}

export function handleQueue(entry: QueueEntry, wa: WorkArea, ctx: HandlerContext): string {
  switch (entry.op) {
    case 'place': {
      const loc = wa.pnr.locator;
      if (!loc || !ctx.pnrStore.has(loc)) return 'FINISH OR IGNORE'; // must be committed first
      const targets = [
        { queue: entry.queue!, pic: entry.pic },
        ...(entry.additionalTargets ?? []),
      ];
      for (const t of targets) {
        const list = ctx.queues.get(t.queue) ?? [];
        if (!list.includes(loc)) list.push(loc); // idempotent: no duplicate placement
        ctx.queues.set(t.queue, list);
      }
      return `QUEUED ${targets.map((t) => t.queue).join(' ')}`;
    }

    case 'access': {
      const q = entry.queue!;
      wa.currentQueue = q;
      const list = ctx.queues.get(q) ?? [];
      if (list.length === 0) return `QUEUE ${q} EMPTY`;
      return loadFront(wa, ctx, q);
    }

    case 'remove': {
      const q = wa.currentQueue;
      if (!q) return NO_QUEUE;
      const list = ctx.queues.get(q) ?? [];
      list.shift(); // remove the on-screen PNR, unaltered
      ctx.queues.set(q, list);
      return loadFront(wa, ctx, q);
    }

    case 'exit': {
      if (!wa.currentQueue) return NO_QUEUE;
      const q = wa.currentQueue;
      wa.currentQueue = undefined;
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
      wa.currentQueue = undefined;
      const pnr = ctx.pnrStore.get(loc);
      if (!pnr) return 'IGNORED'; // committed locator vanished — degenerate but possible
      wa.pnr = pnr;
      wa.machine.transition(SessionEvent.RETRIEVE);
      return renderPnr(pnr, { pcc: ctx.pcc, agent: wa.agent });
    }

    case 'requeue': {
      // QL → LMTC (Left Message to Contact), QU → UTR (Under Reservation).
      // Removes the on-screen PNR from the current queue (like QR) and places
      // it on the follow-up queue. Optional message gets logged as a general
      // remark on the PNR (Zenon note 1: "Entry logged in Remarks Field of
      // PNR if message added"). The source's auto-requeue-after-24h (LMTC) /
      // 15min-4h (UTR) timer behavior isn't modeled — no wall clock.
      if (!wa.currentQueue) return NO_QUEUE;
      const list = ctx.queues.get(wa.currentQueue) ?? [];
      if (list.length === 0) return `QUEUE ${wa.currentQueue} EMPTY`;
      const loc = list[0];
      // Append message to PNR's remarks if provided.
      if (entry.requeueMessage) {
        const pnr = ctx.pnrStore.get(loc);
        if (pnr) {
          pnr.remarks.push({
            type: 'general',
            text: `Q${entry.requeueTarget === 'LMTC' ? 'L' : 'U'}-${entry.requeueMessage}`,
          });
        }
      }
      list.shift();
      ctx.queues.set(wa.currentQueue, list);
      const followUp = ctx.queues.get(entry.requeueTarget!) ?? [];
      if (!followUp.includes(loc)) followUp.push(loc);
      ctx.queues.set(entry.requeueTarget!, followUp);
      return loadFront(wa, ctx, wa.currentQueue);
    }

    case 'skip': {
      // QBI¥N — drop N PNRs from the front of the current queue (including the
      // on-screen one) and load the new front. QBI-N (backward) needs a queue-
      // cursor history we don't keep; rejected with a reconstructed string.
      if (!wa.currentQueue) return NO_QUEUE;
      const n = entry.skipCount ?? 0;
      if (n <= 0) return 'BACKWARD SKIP NOT SUPPORTED'; // reconstructed; not in any public source
      const q = wa.currentQueue;
      const list = ctx.queues.get(q) ?? [];
      list.splice(0, n); // drop up to N (no-op past the end is fine)
      ctx.queues.set(q, list);
      return loadFront(wa, ctx, q);
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
      return result;
    }
  }
}
