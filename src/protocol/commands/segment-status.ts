/**
 * Change-segment-status entry (sigil '.').  (workbook "CHANGE SEGMENT STATUS")
 *   .1HK   set segment 1 to status HK
 *
 * Allowed status codes (workbook): BK BL DS GK GL HK HL YK. Validation of the
 * code lives in the handler so the parser stays purely structural.
 */

import type { SegmentStatusEntry } from '../entry.js';
import { ParseError } from '../errors.js';

const RE = /^\.(\d+)([A-Z]{2})$/;

export function parseSegmentStatus(raw: string): SegmentStatusEntry {
  const m = RE.exec(raw);
  if (!m) throw new ParseError(`Segment status: expected .<seg><CODE> in "${raw}"`);
  return {
    kind: 'segment_status',
    raw,
    timestamp: new Date(),
    segment: parseInt(m[1], 10),
    status: m[2],
  };
}
