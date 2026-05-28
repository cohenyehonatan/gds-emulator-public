/**
 * Accounting-line delete parser (`AC¤…`). Source: Sabre Accounting Lines
 * QR p.1 verbatim:
 *   AC¤1                delete one accounting line
 *   AC¤ALL              delete all accounting lines
 *   AC¤3-5              delete a range
 *   AC¤1,3,6            delete a list
 *
 * Separator is `¤` (change key, not `¥`). The keyboard layer normalizes
 * ASCII `[` → `¤` upstream, so `AC[1` reaches here as `AC¤1`.
 *
 * Manual `AC/<carrier>/<ticket>/…` create + `AC<n>/<carrier>` modify (also
 * documented on the QR) are deferred to a follow-up.
 */

import type { AccountingDeleteEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parseAccounting(raw: string): AccountingDeleteEntry {
  const m = /^AC¤(.+)$/.exec(raw);
  if (!m) throw new ParseError(`Accounting: expected AC¤<selection> in "${raw}"`);
  const body = m[1].toUpperCase();
  const base = { kind: 'accounting_delete' as const, raw, timestamp: new Date() };

  if (body === 'ALL') return { ...base, mode: 'all', lines: [] };

  const range = /^(\d+)-(\d+)$/.exec(body);
  if (range) {
    const from = parseInt(range[1], 10);
    const to = parseInt(range[2], 10);
    if (to < from) throw new ParseError(`Accounting: bad range "${raw}"`);
    const lines = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    return { ...base, mode: 'lines', lines };
  }

  if (/^\d+(,\d+)*$/.test(body)) {
    return { ...base, mode: 'lines', lines: body.split(',').map((n) => parseInt(n, 10)) };
  }

  throw new ParseError(`Accounting: unsupported AC¤ selection "${m[1]}" in "${raw}"`);
}
