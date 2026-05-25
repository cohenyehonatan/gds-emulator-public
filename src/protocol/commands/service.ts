/**
 * SSR / OSI entries (sigils 3 = other airlines, 4 = American Airlines).
 *
 *   SSR:  3<CODE>[/text][-nameref]      3WCHR   3VGML-1.1   3INFT/ANDY/MARY/09JAN11-1.1
 *   OSI:  3OSI [carrier] <text>         3OSI DL HAS BROKEN LEG   4OSI NEEDS ASSISTANCE
 *
 * Carrier defaults to YY (all) for sigil 3, AA for sigil 4. Name reference is
 * `-N` (name item) or `-N.P` (passenger within an item).
 *
 * TODO (ROADMAP): segment-specific SSR (the entry format isn't cleanly pinned
 * in the workbooks); explicit carrier on an SSR.
 */

import type { SsrEntry, OsiEntry } from '../entry.js';
import { ParseError } from '../errors.js';

const NAMEREF_RE = /-(\d+)(?:\.(\d+))?$/;

export function parseService(raw: string): SsrEntry | OsiEntry {
  const aaSpecific = raw[0] === '4';
  const body = raw.slice(1);
  const now = new Date();

  if (body.toUpperCase().startsWith('OSI')) {
    let rest = body.slice(3).trim();
    let carrier = aaSpecific ? 'AA' : 'YY';
    const m = /^([A-Z0-9]{2})\s+(.+)$/.exec(rest);
    if (!aaSpecific && m) {
      carrier = m[1];
      rest = m[2];
    }
    if (rest.length === 0) throw new ParseError(`OSI: empty text "${raw}"`);
    return { kind: 'osi', raw, timestamp: now, carrier, text: rest };
  }

  // SSR: pull a trailing name reference, then the 4-letter code, then text.
  let s = body;
  let nameRef: SsrEntry['nameRef'];
  const nm = NAMEREF_RE.exec(s);
  if (nm) {
    nameRef = { item: parseInt(nm[1], 10), passenger: nm[2] ? parseInt(nm[2], 10) : undefined };
    s = s.slice(0, nm.index);
  }
  const codeMatch = /^([A-Z]{4})/.exec(s);
  if (!codeMatch) throw new ParseError(`SSR: expected 4-letter code in "${raw}"`);
  const text = s.slice(4).replace(/^\//, '').trim() || undefined;

  return {
    kind: 'ssr',
    raw,
    timestamp: now,
    code: codeMatch[1],
    carrier: aaSpecific ? 'AA' : 'YY',
    text,
    nameRef,
  };
}
