/**
 * Queue ops (sigil Q). (Zenon "QUEUES")
 *   QP/100              place the on-screen PNR on queue 100
 *   QP/44/9             place on queue 44 with placement-instruction code 9
 *   QP/G                place on the General Queue within the current PCC
 *   QP/2EA0G            place on the General Queue of branch PCC 2EA0
 *   QP/G¥S¥T            multi-target placement (current PCC G, S, T)
 *   QP/2EA0G¥5OT0S¥A    multi-target with branch PCCs (max 9 addresses)
 *   Q/10                access queue 10 (Q/S supervisory, Q/L left-message)
 *   QR                  remove the on-screen PNR, advance to the next
 *   QX / QXI / QXE      exit the queue without working the rest
 *   QXIR                ignore work-area changes, exit queue, redisplay PNR
 *   QXER                end-transact (commit), exit queue, redisplay PNR
 *
 * `*Q` (queue status) is a display entry, parsed by commands/retrieve.ts.
 *
 * TODO (ROADMAP): jump (QJ), skip (QBI¥n/QBI-n), QL/QU re-queue.
 */

import type { QueueEntry } from '../entry.js';
import { ParseError } from '../errors.js';

const MAX_PLACEMENT_TARGETS = 9; // Zenon: "These entries can only be used … maximum 9 addresses".

export function parseQueue(raw: string): QueueEntry {
  const u = raw.toUpperCase();
  const base = { kind: 'queue' as const, raw, timestamp: new Date() };

  if (u === 'QR') return { ...base, op: 'remove' };
  if (u === 'QX' || u === 'QXI' || u === 'QXE') return { ...base, op: 'exit' };
  if (u === 'QXIR') return { ...base, op: 'exit_ignore_redisplay' };
  if (u === 'QXER') return { ...base, op: 'exit_end_redisplay' };

  const place = /^QP\/(.+)$/.exec(u);
  if (place) {
    const targets = place[1].split('¥');
    if (targets.length > MAX_PLACEMENT_TARGETS) {
      throw new ParseError(`Queue placement: max ${MAX_PLACEMENT_TARGETS} addresses in "${raw}"`);
    }
    const parsed = targets.map((t) => parsePlacementTarget(t, raw));
    const [first, ...rest] = parsed;
    return {
      ...base,
      op: 'place',
      queue: first.queue,
      pic: first.pic,
      additionalTargets: rest.length > 0 ? rest : undefined,
    };
  }

  const access = /^Q\/([A-Z0-9]+)$/.exec(u);
  if (access) return { ...base, op: 'access', queue: access[1] };

  throw new ParseError(`Queue: unrecognized entry "${raw}"`);
}

/** A single placement target — `<queue>` or `<queue>/<pic>`. */
function parsePlacementTarget(t: string, raw: string): { queue: string; pic?: string } {
  const m = /^([A-Z0-9]+)(?:\/([A-Z0-9]+))?$/.exec(t);
  if (!m) throw new ParseError(`Queue placement: bad target "${t}" in "${raw}"`);
  return { queue: m[1], pic: m[2] };
}
