/**
 * Pricing entries (sigil "WP" — Sabre Air Pricing).  (Basic Pricing QR)
 *   WP / WP*           price as booked / redisplay
 *   WPNC / WPNCS / WPNCB   bargain finder (advise / ignore-avail / rebook)
 *   WPRQ               price and store a PQ record   (RQ also works as a ¥ qualifier)
 *   WPDF / WPDF* / WPDF<n>  fare-calculation display
 *   PQ                 store the last pricing response
 *
 * Qualifiers follow the verb, the first inline and the rest separated by the
 * cross of Lorraine ¥ (workbook "WPPC03¥S2/4¥N1.2"):
 *   P<types>   passenger types (WPPADT/C05/INF)
 *   S<segs>    segment selection (WPS1-3/5)
 *   N<ref>     price one passenger (¥N1.1)
 *   A<carrier> validating carrier (WPALH)
 *   M<cur>     display currency (WPMEUR — label only, no conversion)
 *   TN / TE    exempt all taxes+fees / exempt taxes keep fees
 *   RQ         store a PQ record
 *
 * Negotiated/account/exclude qualifiers (WPI/WPAC/WPXP/WPXR/WPXA) are
 * parsed per the Pricing QR verbatim forms; the emulated tariff files
 * no negotiated/penalty/restricted fares so they price as public.
 * (Formerly a TODO citing missing sources — the QR documents them.
 * WPXA/WPPL/WPPV/WPB/WP¥TC) — they need fare-rule modeling we don't have.
 */

import type { PricingEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parsePricing(raw: string): PricingEntry {
  const u = raw.toUpperCase();
  const base = { kind: 'pricing' as const, raw, timestamp: new Date() };

  // Exact display / store forms (no qualifiers).
  if (u === 'WP*') return { ...base, mode: 'redisplay' };
  if (u === 'PQ') return { ...base, mode: 'store' };
  if (u === 'WPDF' || u === 'WPDF*') return { ...base, mode: 'farecalc' };
  const df = /^WPDF(\d+)$/.exec(u);
  if (df) return { ...base, mode: 'farecalc', fareCalcLine: parseInt(df[1], 10) };

  // Base verb (longest first) + qualifier remainder.
  let mode: PricingEntry['mode'] = 'price';
  let rebook: boolean | undefined;
  let ignoreAvailability: boolean | undefined;
  let store: boolean | undefined;
  let rest: string;
  if (u.startsWith('WPNCB')) {
    mode = 'bargain';
    rebook = true;
    ignoreAvailability = false;
    rest = raw.slice(5);
  } else if (u.startsWith('WPNCS')) {
    mode = 'bargain';
    ignoreAvailability = true;
    rest = raw.slice(5);
  } else if (u.startsWith('WPNC')) {
    mode = 'bargain';
    ignoreAvailability = false;
    rest = raw.slice(4);
  } else if (u.startsWith('WPRQ')) {
    store = true;
    rest = raw.slice(4);
  } else if (u.startsWith('WP')) {
    rest = raw.slice(2);
  } else {
    throw new ParseError(`Pricing: unsupported format "${raw}"`);
  }

  const quals = parseQualifiers(rest, raw);
  return { ...base, mode, rebook, ignoreAvailability, ...quals, store: store || quals.store };
}

type Qualifiers = Pick<
  PricingEntry,
  | 'passengerTypes' | 'segments' | 'nameRef' | 'validatingCarrier'
  | 'currency' | 'taxMode' | 'store'
  | 'corporateId' | 'accountCode' | 'exclude'
>;

/** Parse qualifiers from the verb remainder: first inline, rest ¥-separated. */
function parseQualifiers(rest: string, raw: string): Qualifiers {
  const q: Qualifiers = {};
  if (rest.length === 0) return q;
  const body = rest.startsWith('¥') ? rest.slice(1) : rest;
  for (const token of body.split('¥').filter(Boolean)) {
    const upper = token.toUpperCase();
    // Multi-char qualifiers first — `AC*<code>` must win over the
    // single-char `A` validating-carrier case, `X<P|R|A>` over an
    // unsupported-key throw. Pricing QR p.2 verbatim forms:
    //   WPI<corporate ID>   WPAC*<account code>   WPXP / WPXR / WPXA
    if (upper.startsWith('AC*')) {
      if (upper.length <= 3) throw new ParseError(`Pricing: no account code in "${raw}"`);
      q.accountCode = upper.slice(3);
      continue;
    }
    if (upper === 'XP' || upper === 'XR' || upper === 'XA') {
      q.exclude = q.exclude ?? [];
      q.exclude.push(upper === 'XP' ? 'penalty' : upper === 'XR' ? 'restrictions' : 'advance');
      continue;
    }
    if (upper.startsWith('I') && upper.length > 1) {
      q.corporateId = upper.slice(1);
      continue;
    }
    const key = token[0].toUpperCase();
    const val = token.slice(1);
    switch (key) {
      case 'P': {
        const types = val.toUpperCase().split('/').filter(Boolean);
        if (types.length === 0) throw new ParseError(`Pricing: no passenger types in "${raw}"`);
        q.passengerTypes = types;
        break;
      }
      case 'S':
        q.segments = parseSegmentSpec(val, raw);
        break;
      case 'N':
        q.nameRef = parseNameRef(val, raw);
        break;
      case 'A':
        if (!/^[A-Z0-9]{2}$/.test(val.toUpperCase())) throw new ParseError(`Pricing: bad carrier "${raw}"`);
        q.validatingCarrier = val.toUpperCase();
        break;
      case 'M':
        if (!/^[A-Z]{3}$/.test(val.toUpperCase())) throw new ParseError(`Pricing: bad currency "${raw}"`);
        q.currency = val.toUpperCase();
        break;
      case 'T':
        if (val.toUpperCase() === 'N') q.taxMode = 'none';
        else if (val.toUpperCase() === 'E') q.taxMode = 'fees';
        else throw new ParseError(`Pricing: unsupported tax qualifier "${raw}"`);
        break;
      case 'R':
        if (token.toUpperCase() === 'RQ') q.store = true;
        else throw new ParseError(`Pricing: unsupported qualifier "${token}"`);
        break;
      default:
        throw new ParseError(`Pricing: unsupported qualifier "${token}"`);
    }
  }
  return q;
}

function parseNameRef(val: string, raw: string): { item: number; passenger?: number } {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(val);
  if (!m) throw new ParseError(`Pricing: bad name reference "${raw}"`);
  return { item: parseInt(m[1], 10), passenger: m[2] ? parseInt(m[2], 10) : undefined };
}

/** Parse a segment selection like "1-3/5" into [1,2,3,5]. */
function parseSegmentSpec(spec: string, raw: string): number[] {
  const out: number[] = [];
  for (const part of spec.split('/')) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const from = parseInt(range[1], 10);
      const to = parseInt(range[2], 10);
      if (to < from) throw new ParseError(`Pricing: bad segment range "${raw}"`);
      for (let n = from; n <= to; n++) out.push(n);
    } else if (/^\d+$/.test(part)) {
      out.push(parseInt(part, 10));
    } else {
      throw new ParseError(`Pricing: bad segment spec "${raw}"`);
    }
  }
  if (out.length === 0) throw new ParseError(`Pricing: empty segment spec "${raw}"`);
  return out;
}
