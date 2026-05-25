/**
 * Queue ops (sigil Q). (Zenon "QUEUES")
 *   QP/100         place the on-screen PNR on queue 100
 *   QP/44/9        place on queue 44 with placement-instruction code 9
 *   Q/10           access queue 10 (Q/S supervisory, Q/L left-message)
 *   QR             remove the on-screen PNR, advance to the next
 *   QX / QXI / QXE exit the queue without working the rest
 *
 * `*Q` (queue status) is a display entry, parsed by commands/retrieve.ts.
 *
 * TODO (ROADMAP): branch-PCC general queues (QP/2EA0G), jump (QJ), skip
 * (QBI‡n/QBI-n), QL/QU re-queue, QXIR/QXER exit-and-redisplay.
 */

import type { QueueEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parseQueue(raw: string): QueueEntry {
  const u = raw.toUpperCase();
  const base = { kind: 'queue' as const, raw, timestamp: new Date() };

  if (u === 'QR') return { ...base, op: 'remove' };
  if (u === 'QX' || u === 'QXI' || u === 'QXE') return { ...base, op: 'exit' };

  const place = /^QP\/([A-Z0-9]+)(?:\/([A-Z0-9]+))?$/.exec(u);
  if (place) return { ...base, op: 'place', queue: place[1], pic: place[2] };

  const access = /^Q\/([A-Z0-9]+)$/.exec(u);
  if (access) return { ...base, op: 'access', queue: access[1] };

  throw new ParseError(`Queue: unrecognized entry "${raw}"`);
}
