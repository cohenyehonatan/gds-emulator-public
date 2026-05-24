/**
 * Field change / delete via the change key '¤' (workbook "DELETE AND CHANGE
 * PASSENGER DATA", p.36-37).
 *
 *   delete: <sigil><lineSpec>¤        -¤  -1¤  91¤  91-3¤  91,3¤
 *   change: <sigil><line>¤<new data>  -1¤JENSEN/KURT MR  91¤214-555-2121-H
 *                                     7¤TAW17FEB/  6¤JENS HANSON
 *
 * lineSpec is empty, a single number, a range (N-M), or a list (N,M).
 *
 * TODO (ROADMAP): passenger-level refs (-1.1¤), name-reference data (¤*),
 * remarks/SSR/agency-address fields.
 */

import type { ModifyEntry } from '../entry.js';
import { ParseError } from '../errors.js';
import { CHANGE } from '../keyboard.js';

const SIGIL_FIELD: Record<string, ModifyEntry['field']> = {
  '-': 'name',
  '9': 'phone',
  '7': 'ticketing',
  '6': 'received_from',
};

/** Does this entry look like a '¤' modify on a supported field? */
export function isModifyEntry(raw: string): boolean {
  return raw.includes(CHANGE) && raw[0] in SIGIL_FIELD;
}

function parseLineSpec(spec: string): number[] {
  if (spec === '') return [];
  const range = /^(\d+)-(\d+)$/.exec(spec);
  if (range) {
    const from = parseInt(range[1], 10);
    const to = parseInt(range[2], 10);
    if (to < from) throw new ParseError(`modify: bad range "${spec}"`);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  if (/^\d+(,\d+)*$/.test(spec)) return spec.split(',').map((n) => parseInt(n, 10));
  throw new ParseError(`modify: bad line spec "${spec}"`);
}

export function parseModify(raw: string): ModifyEntry {
  const idx = raw.indexOf(CHANGE);
  const left = raw.slice(0, idx);
  const newData = raw.slice(idx + 1).trim();

  const field = SIGIL_FIELD[left[0]];
  if (!field) throw new ParseError(`modify: unsupported field "${left[0]}"`);

  const spec = left.slice(1);
  // Name-reference data (¤*) is still deferred.
  if (spec.includes('*') || newData.startsWith('*')) {
    throw new ParseError('modify: name-reference data not supported yet');
  }

  const base = {
    kind: 'modify' as const,
    raw,
    timestamp: new Date(),
    field,
    operation: newData.length > 0 ? ('change' as const) : ('delete' as const),
    newData: newData.length > 0 ? newData : undefined,
  };

  // Passenger-within-item reference, e.g. -1.1¤  (names only).
  const sub = /^(\d+)\.(\d+)$/.exec(spec);
  if (sub) {
    if (field !== 'name') throw new ParseError('modify: sub-reference only valid for names');
    return { ...base, lines: [parseInt(sub[1], 10)], passenger: parseInt(sub[2], 10) };
  }
  if (spec.includes('.')) throw new ParseError(`modify: bad reference "${spec}"`);

  return { ...base, lines: parseLineSpec(spec) };
}
