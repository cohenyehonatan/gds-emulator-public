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

import type { QueueEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { SessionEvent } from '../session-state.js';
import { renderPnr } from '../../protocol/serializer.js';
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
      const q = entry.queue!;
      const list = ctx.queues.get(q) ?? [];
      if (!list.includes(loc)) list.push(loc); // idempotent: no duplicate placement
      ctx.queues.set(q, list);
      return `QUEUED ${q}`;
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
  }
}
