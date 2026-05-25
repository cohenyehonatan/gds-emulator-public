/**
 * Time-limit / option entry (sigil 8).  (workbook ICK key 8 "Time Limit")
 *   86P/17JUN   option time limit — auto-cancels if no ticket is issued
 *
 * Note: the workbooks document this key only by the `86P/17JUN` example, so we
 * model it minimally as a single option field (text after the 8). Like the
 * ticketing/received-from fields, re-entering overwrites it. We do not simulate
 * the auto-cancel (no wall clock in the emulator).
 */

import type { TimeLimitEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parseTimeLimit(raw: string): TimeLimitEntry {
  const text = raw.slice(1).trim();
  if (text.length === 0) throw new ParseError(`Time limit: empty entry "${raw}"`);
  return { kind: 'time_limit', raw, timestamp: new Date(), text };
}
