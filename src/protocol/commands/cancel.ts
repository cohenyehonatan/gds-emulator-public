/**
 * Cancel entry (sigil 'X').  (workbook "CANCEL AND REBOOK")
 *   X1     cancel itinerary segment 1
 *   X1/3   cancel segments 1 and 3
 *   X1-3   cancel the range 1..3
 *   XI     cancel the entire itinerary
 *   XIA    cancel all air segments
 *
 * Passive cancel `.(sel)XK` lives under sigil `.` (commands/segment-status.ts).
 * TODO (later, see ROADMAP): cancel+rebook `X1¥0…`.
 */

import type { CancelEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parseCancel(raw: string): CancelEntry {
  const body = raw.slice(1); // drop 'X'
  const base = { raw, timestamp: new Date() } as const;

  if (body === 'I') return { kind: 'cancel', mode: 'itinerary', segments: [], ...base };
  if (body === 'IA') return { kind: 'cancel', mode: 'all_air', segments: [], ...base };

  const range = /^(\d+)-(\d+)$/.exec(body);
  if (range) {
    const from = parseInt(range[1], 10);
    const to = parseInt(range[2], 10);
    if (to < from) throw new ParseError(`Cancel: bad range "${raw}"`);
    const segments = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    return { kind: 'cancel', mode: 'range', segments, ...base };
  }

  if (/^\d+(\/\d+)+$/.test(body)) {
    const segments = body.split('/').map((n) => parseInt(n, 10));
    return { kind: 'cancel', mode: 'multiple', segments, ...base };
  }

  if (/^\d+$/.test(body)) {
    return { kind: 'cancel', mode: 'segment', segments: [parseInt(body, 10)], ...base };
  }

  throw new ParseError(`Cancel: unsupported format "${raw}"`);
}
