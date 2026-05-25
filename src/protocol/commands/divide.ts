/**
 * Divide a PNR (sigil D) and file (F).  (Zenon "Divide a PNR")
 *   D1          divide the passenger(s) in name field 1
 *   D2.1        divide passenger 2.1
 *   D3.1*4.1    divide passengers 3.1 and 4.1
 *   F           file the divided (new) PNR
 *
 * TODO (ROADMAP): range form D1.2-3.2.
 */

import type { DivideEntry, FileEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parseDivide(raw: string): DivideEntry {
  const refs = raw
    .slice(1)
    .split('*')
    .map((tok) => {
      const m = /^(\d+)(?:\.(\d+))?$/.exec(tok);
      if (!m) throw new ParseError(`Divide: bad passenger reference "${tok}" in "${raw}"`);
      return { item: parseInt(m[1], 10), passenger: m[2] ? parseInt(m[2], 10) : undefined };
    });
  return { kind: 'divide', raw, timestamp: new Date(), refs };
}

export function parseFile(raw: string): FileEntry {
  return { kind: 'file', raw, timestamp: new Date() };
}
