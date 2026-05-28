/**
 * Change-segment-status / passive-cancel entry (sigil '.').
 *
 *   .1HK         set segment 1 to status HK (workbook "CHANGE SEGMENT STATUS")
 *   .1XK         passively cancel segment 1 (Sabre Basic Reservation Course:
 *   .1-3XK       "Passively cancel segments, no message sent to the airline" —
 *   .1/3XK       format `.(segment selection)XK`, example `.1-3XK`)
 *
 * The XK code is dispatched as a separate entry kind (`passive_cancel`), not
 * as a "status" code, because it removes segments rather than setting one's
 * status. Allowed plain-status codes (workbook): BK BL DS GK GL HK HL YK —
 * validation lives in the handler so the parser stays purely structural.
 */

import type { SegmentStatusEntry, PassiveCancelEntry } from '../entry.js';
import { ParseError } from '../errors.js';

const STATUS_RE = /^\.(\d+)([A-Z]{2})$/;
/** `.<seg>XK` / `.<from>-<to>XK` / `.<a>/<b>XK` — same segment-selection grammar as X cancel. */
const PASSIVE_CANCEL_RE = /^\.(\d+(?:[-/]\d+)*)XK$/;

export function parseSegmentStatus(raw: string): SegmentStatusEntry | PassiveCancelEntry {
  const base = { raw, timestamp: new Date() } as const;

  const xk = PASSIVE_CANCEL_RE.exec(raw);
  if (xk) {
    const sel = xk[1];
    const range = /^(\d+)-(\d+)$/.exec(sel);
    if (range) {
      const from = parseInt(range[1], 10);
      const to = parseInt(range[2], 10);
      if (to < from) throw new ParseError(`Passive cancel: bad range "${raw}"`);
      const segments = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      return { kind: 'passive_cancel', segments, ...base };
    }
    const segments = sel.split('/').map((n) => parseInt(n, 10));
    return { kind: 'passive_cancel', segments, ...base };
  }

  const m = STATUS_RE.exec(raw);
  if (!m) throw new ParseError(`Segment status: expected .<seg><CODE> in "${raw}"`);
  return {
    kind: 'segment_status',
    ...base,
    segment: parseInt(m[1], 10),
    status: m[2],
  };
}
