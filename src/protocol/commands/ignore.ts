/**
 * Ignore entry.  I / IG  — discard the uncommitted work area. (workbook p.6)
 * TODO (later): IR (ignore and redisplay).
 */

import type { IgnoreEntry } from '../entry.js';

export function parseIgnore(raw: string): IgnoreEntry {
  return { kind: 'ignore', raw, timestamp: new Date() };
}
