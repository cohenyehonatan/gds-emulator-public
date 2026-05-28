/**
 * Cancel entry (sigil 'X').  (workbook "CANCEL AND REBOOK")
 *   X1     cancel itinerary segment 1
 *   X1/3   cancel segments 1 and 3
 *   X1-3   cancel the range 1..3
 *   XI     cancel the entire itinerary
 *   XIA    cancel all air segments
 *
 * Cancel and rebook in one entry (Sabre Basic Reservation Course):
 *   X<sel>¥0<seats><class><line>   cancel + sell from CPA (e.g. X3¥01F1)
 *   X<sel>¥00<date>                cancel + resell same flight on new date
 *                                  (e.g. X1¥0025APR)
 *
 * Passive cancel `.(sel)XK` lives under sigil `.` (commands/segment-status.ts).
 * TODO (later, see ROADMAP): multi-segment date rebook (X1-3¥0024JUN) and
 * XIA delta forms (XIA,¥7 / XIA,-4) from the Zenon course.
 */

import type { CancelEntry } from '../entry.js';
import { ParseError } from '../errors.js';

const SABRE_DATE = /^\d{1,2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)$/;

export function parseCancel(raw: string): CancelEntry {
  const body = raw.slice(1); // drop 'X'
  const base = { raw, timestamp: new Date() } as const;

  // Cancel-and-rebook splits on '¥' (keyboard alias: ').
  const yi = body.indexOf('¥');
  if (yi !== -1) {
    const selBody = body.slice(0, yi);
    const rebookBody = body.slice(yi + 1);
    if (selBody === 'I' || selBody === 'IA' || selBody === '') {
      throw new ParseError(`Cancel-rebook: needs a segment selection in "${raw}"`);
    }
    const spec = parseSelection(selBody, raw);
    const rebook = parseRebook(rebookBody, raw);
    return { ...spec, ...base, rebook };
  }

  if (body === 'I') return { kind: 'cancel', mode: 'itinerary', segments: [], ...base };
  if (body === 'IA') return { kind: 'cancel', mode: 'all_air', segments: [], ...base };
  return { ...parseSelection(body, raw), ...base };
}

/** Cancel-segment selection grammar: `1`, `1/3` (list), `1-3` (range). */
function parseSelection(body: string, raw: string): Pick<CancelEntry, 'kind' | 'mode' | 'segments'> {
  const range = /^(\d+)-(\d+)$/.exec(body);
  if (range) {
    const from = parseInt(range[1], 10);
    const to = parseInt(range[2], 10);
    if (to < from) throw new ParseError(`Cancel: bad range "${raw}"`);
    const segments = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    return { kind: 'cancel', mode: 'range', segments };
  }
  if (/^\d+(\/\d+)+$/.test(body)) {
    return { kind: 'cancel', mode: 'multiple', segments: body.split('/').map((n) => parseInt(n, 10)) };
  }
  if (/^\d+$/.test(body)) {
    return { kind: 'cancel', mode: 'segment', segments: [parseInt(body, 10)] };
  }
  throw new ParseError(`Cancel: unsupported format "${raw}"`);
}

/** Rebook side of `X<sel>¥0…`: either `0<date>` (date) or `<seats><class><line>` (CPA). */
function parseRebook(body: string, raw: string): NonNullable<CancelEntry['rebook']> {
  if (!body.startsWith('0')) throw new ParseError(`Cancel-rebook: expected ¥0… in "${raw}"`);
  const rest = body.slice(1);
  if (rest.startsWith('0')) {
    const date = rest.slice(1);
    if (!SABRE_DATE.test(date)) throw new ParseError(`Cancel-rebook: bad date "${date}" in "${raw}"`);
    return { kind: 'same_flight_new_date', newDate: date };
  }
  const m = /^(\d)([A-Z])(\d+)$/.exec(rest);
  if (!m) throw new ParseError(`Cancel-rebook: expected ¥0<seats><class><line> in "${raw}"`);
  return {
    kind: 'cpa_line',
    seats: parseInt(m[1], 10),
    bookingClass: m[2],
    line: parseInt(m[3], 10),
  };
}
