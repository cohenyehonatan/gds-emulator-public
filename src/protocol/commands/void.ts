/**
 * Void-ticket parser (`WV` family). Source: Sabre Travel Network Middle
 * East QR (Sept 2007) p.13 — verbatim third-party. Five entry modes:
 *
 *   WV<n>                                    by_item        (e.g. WV2)
 *   WV‡<13>/<amt>/<fop>/<DDMMM>/<cc>/<n>    manual         (¥ alias of ‡)
 *   WV<sp>*                                  list_month     (`WV` + `*`)
 *   WV<sp>*DT<DDMMM>                         list_day
 *   WV<sp>*DT<DDMMM>-<DDMMM>                 list_range
 *
 * `‡` and `¥` are both written as the cross-of-Lorraine (`¥`) on the wire;
 * the keyboard layer already maps `'` and `¥` to that glyph. We accept both
 * here so transcript replay survives either encoding.
 *
 * Same-day cutoff isn't enforced (consistent with WTRX) — the emulator
 * doesn't model wall-clock cutoffs.
 */

import type { VoidEntry } from '../entry.js';
import { ParseError } from '../errors.js';

const DDMMM = /^\d{1,2}[A-Z]{3}$/;

export function parseVoid(raw: string): VoidEntry {
  const base = { kind: 'void' as const, raw, timestamp: new Date() };
  const u = raw.toUpperCase();

  if (!u.startsWith('WV')) throw new ParseError(`Void: missing WV prefix in "${raw}"`);
  const args = u.slice(2);

  // List modes: WV*, WV*DT<date>, WV*DT<from>-<to>
  if (args.startsWith('*')) {
    const body = args.slice(1);
    if (body === '') return { ...base, mode: 'list_month' };
    if (!body.startsWith('DT')) {
      throw new ParseError(`Void: bad list selector "${body}" in "${raw}"`);
    }
    const dates = body.slice(2);
    const range = dates.split('-');
    if (range.length === 1) {
      const d = range[0];
      if (!DDMMM.test(d)) throw new ParseError(`Void: bad date "${d}" in "${raw}"`);
      return { ...base, mode: 'list_day', fromDate: d };
    }
    if (range.length === 2) {
      const [from, to] = range;
      if (!DDMMM.test(from) || !DDMMM.test(to)) {
        throw new ParseError(`Void: bad date range "${dates}" in "${raw}"`);
      }
      return { ...base, mode: 'list_range', fromDate: from, toDate: to };
    }
    throw new ParseError(`Void: malformed list "${body}" in "${raw}"`);
  }

  // Manual mode: WV‡<13>/<amt>/<fop>/<DDMMM>/<cc>/<n>  — accept ¥ as the cross-of-Lorraine
  if (args.startsWith('¥') || args.startsWith('‡')) {
    const fields = args.slice(1).split('/');
    if (fields.length !== 6) {
      throw new ParseError(`Void: manual form needs 6 slash-fields in "${raw}"`);
    }
    const [tkt, amount, fop, date, carrier, countStr] = fields;
    if (!/^\d{13}$/.test(tkt)) throw new ParseError(`Void: bad ticket "${tkt}" in "${raw}"`);
    if (!DDMMM.test(date)) throw new ParseError(`Void: bad date "${date}" in "${raw}"`);
    const count = parseInt(countStr, 10);
    if (!Number.isFinite(count) || count <= 0) {
      throw new ParseError(`Void: bad count "${countStr}" in "${raw}"`);
    }
    return {
      ...base,
      mode: 'manual',
      ticketNumber: tkt,
      amount,
      fop,
      date,
      carrier,
      count,
    };
  }

  // by_item: WV<n>
  if (/^\d+$/.test(args)) {
    return { ...base, mode: 'by_item', itemNumber: parseInt(args, 10) };
  }

  throw new ParseError(`Void: bad selector "${args}" in "${raw}"`);
}
