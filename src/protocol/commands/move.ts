/**
 * Move / insert segments (sigil '/').  (workbook "Insert After Segment")
 *   /0/2     move segment 2 to after segment 0 (the front)
 *   /3/1     move segment 1 to after segment 3
 *   /0/2-4   move the range of segments 2-4 to the front
 */

import type { MoveEntry } from '../entry.js';
import { ParseError } from '../errors.js';

const RE = /^\/(\d+)\/(\d+)(?:-(\d+))?$/;

export function parseMove(raw: string): MoveEntry {
  const m = RE.exec(raw);
  if (!m) throw new ParseError(`Move: expected /<after>/<from>[-<to>] in "${raw}"`);
  const to = m[3] ? parseInt(m[3], 10) : undefined;
  const from = parseInt(m[2], 10);
  if (to != null && to < from) throw new ParseError(`Move: bad range "${raw}"`);
  return { kind: 'move', raw, timestamp: new Date(), after: parseInt(m[1], 10), from, to };
}
