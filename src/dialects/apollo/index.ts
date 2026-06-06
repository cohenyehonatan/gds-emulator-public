/**
 * Apollo (1V) dialect — co-build with Galileo per ROADMAP.md v5.
 *
 * Apollo is Travelport's other GDS tenant (legacy United Airlines host,
 * still serving major US travel-management agencies). Its cryptic
 * surface overlaps Galileo's significantly — the Travelport+ GDS
 * Format Comparison Guide (`references/galileo/Travelport-GDS-Format-
 * Comparison-Guide.pdf`, October 2025) maps every common verb in a
 * side-by-side Rosetta. For SON/SOF, work-area switching, scrolling,
 * encode/decode, queue place/access, retrieve, name (`N.`), phone
 * (`P.`), ticketing (`T.`), received-from (`R.`), cancel (`XI`/`X<n>`/
 * `XA`), and most pricing/ticketing forms, Apollo and Galileo cryptic
 * are IDENTICAL.
 *
 * The known syntactic differences from Galileo (verified 2026-06-06
 * against pp.5-18, 27-30 of the Comparison Guide):
 *
 *   | Verb                  | Apollo (1V)              | Galileo (1G)            |
 *   |-----------------------|--------------------------|-------------------------|
 *   | Reference sell        | `01Y1`                   | `N1Y1`                  |
 *   | Reference all flights | `03C2Y3`                 | `N3C2Y3`                |
 *   | Segment status change | `.1HK`                   | `@1HK`                  |
 *   | Status all air        | (n/a)                    | `@ALL`                  |
 *   | Carrier qualifier     | `A23JULFRAROM+LH`        | `A23JULFRAROM/LH`       |
 *   | Direct sell           | `0AY631C11JULHELARNN1`   | `0AY631C11JULHELARNN1`  |
 *
 * Note the direct sell (`0<carrier><flight>...`) is the SAME shape in
 * both — Galileo accepts it as an alternate (Mini Format Guide v2 p.10),
 * so no translation needed.
 *
 * Strategy: pre-translate the three Apollo-specific forms to their
 * Galileo equivalents before handing off to Galileo's parser. Apollo
 * and Galileo then share parser + dispatch + serializer + responses
 * entirely. This is a deliberate v1 cut — when Apollo grows verbs that
 * have NO Galileo equivalent (or pre-prod 1V reveals divergence on a
 * verb we thought matched), we'll add Apollo-specific parsing here.
 *
 * Live backend: same `LiveTravelportBackend` (OAuth + TripServices REST)
 * with a 1V access group. The cryptic-to-REST mapping table is shared
 * with Galileo since the REST surface is vendor-agnostic. Future work
 * gates a `livetravelport.access1V` env var or a `dialect: 'apollo'`
 * marker on the backend so the same client can hold credentials for
 * both PCC types.
 *
 * Implemented verbs (delegated to Galileo dispatch — covering everything
 * the Galileo dialect supports):
 *   - SON/Z<usercode>, SOF
 *   - SA-SE work-area switch
 *   - A<date><orig><dest>[<time>][+<carrier>] availability (with `+`→`/`)
 *   - 0<line><class>[<n>] reference sell (translated to N<n><class><line>)
 *   - N. / P. / T. / R. mandatory + optional fields
 *   - SI. / OS. SSR / OSI
 *   - .<n><status> segment status (translated to @<n><status>)
 *   - X<n> / XI / XA cancel
 *   - *<locator> / *-<surname> / *R retrieve
 *   - FQ / TKP fare quote and ticketing
 *   - QEB/<n> queue place, Q/<n> queue access, QR/<n> remove
 *   - ER / E / I end-transaction, ignore
 */

import type { Dialect } from '../dialect.js';
import type { WorkArea } from '../../session/work-area.js';
import type { HandlerContext } from '../../session/handlers/index.js';
import { ParseError } from '../../protocol/errors.js';
import { parseGalileoEntry } from '../galileo/parser.js';
import { dispatchGalileo, GALILEO_NOT_IMPLEMENTED } from '../galileo/dispatch.js';
import { GalileoResponse } from '../galileo/responses.js';

/** Same `+` chain operator as Galileo (per Mini Format Guide v2). */
const COMBINE = '+';

/**
 * Reuse Galileo's chain-split logic. Apollo's Comparison Guide doesn't
 * document a separate end-item separator; both dialects use `+` for
 * verb chaining and have the same multi-queue ambiguity (`QEB/35+40+45`).
 */
function splitApolloChain(raw: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== COMBINE) continue;
    let j = i + 1;
    while (j < raw.length && raw[j] === ' ') j++;
    const head = raw[j];
    if (head != null && /[A-Za-z@*.]/.test(head)) {
      out.push(raw.slice(start, i).trim());
      start = j;
      i = j - 1;
    }
  }
  out.push(raw.slice(start).trim());
  return out.filter((s) => s.length > 0);
}

/**
 * Pre-translate Apollo-specific syntactic forms to their Galileo
 * equivalents. Three known patterns from the Comparison Guide:
 *
 *  1. Reference sell `0<n><class>[<n2><class2>...]` → `N<seats><class>...`
 *     Apollo `01Y1` (one seat, Y, line 1) → Galileo `N1Y1`.
 *     Apollo `03C2Y3` (three seats: C class line 2, Y class line 3) →
 *     Galileo `N3C2Y3`.
 *     ONLY rewrite when the `0` is the FIRST character of the entry,
 *     followed by a digit (1-9) — direct sells `0AY631...` start with
 *     `0<carrier>` which is the SAME shape in both dialects.
 *
 *  2. Segment status `.<n><status>` → `@<n><status>`.
 *     Apollo `.1HK` → Galileo `@1HK`. The leading dot is unambiguous —
 *     no other Galileo verb starts with `.<digit>`.
 *
 *  3. Availability carrier qualifier `A<...date+route+...>+<carrier>` →
 *     `.../<carrier>`. Apollo `A23JULFRAROM+LH` → Galileo
 *     `A23JULFRAROM/LH`. ONLY rewrite when the `+` follows the route
 *     letters and is followed by 2-3 letter carrier code — avoids
 *     mangling chain separators.
 *
 * Everything else passes through unchanged. The handful of pre-prod
 * 1V responses we expect to diverge from 1G (date layouts, currency
 * formatting trailers) gets handled at the serializer level later
 * when we wire the live 1V backend.
 */
export function translateApolloToGalileo(raw: string): string {
  let s = raw;
  // (1) Reference sell: `0<digit>...` → `N<digit>...`. Guard against
  // direct sells (`0<carrier-letter>...`) which are identical in both.
  if (/^0[1-9]/.test(s)) {
    s = 'N' + s.slice(1);
  }
  // (2) Segment status: `.<digit><status>` → `@<digit><status>`.
  // The Galileo modify cryptic is `@<n><status>`; same body shape.
  if (/^\.[1-9]/.test(s)) {
    s = '@' + s.slice(1);
  }
  // (3) Availability `+<carrier>` → `/<carrier>`. Match an availability
  // entry whose route portion is followed by `+<2-3 letters>` at end of
  // string, before any other modifier. Galileo's `+` is reserved for
  // chain joins, so we only translate this in availability context.
  if (/^A/.test(s)) {
    s = s.replace(/\+([A-Z]{2,3})(?=$|[\s.])/, '/$1');
  }
  return s;
}

/**
 * Errors that halt an end-item chain. Mirrors Galileo's set since the
 * dispatch + responses are shared.
 */
const ERROR_RESPONSES = new Set<string>([
  GalileoResponse.FORMAT,
  GALILEO_NOT_IMPLEMENTED,
  'OUT OF SEQUENCE',
]);

export class ApolloDialect implements Dialect {
  readonly id = 'apollo' as const;
  readonly displayName = 'Apollo (1V)';
  readonly bannerText =
    'Apollo (1V) terminal — type a cryptic entry. SON/Z<usercode> to sign on, .q to quit.';
  readonly screenName = 'APOLLO 1V';

  normalizeKeyboard(raw: string): string {
    return raw;
  }

  splitChain(raw: string): string[] {
    return splitApolloChain(raw);
  }

  processEntry(raw: string, wa: WorkArea, ctx: HandlerContext): string | Promise<string> {
    const translated = translateApolloToGalileo(raw);
    let entry;
    try {
      entry = parseGalileoEntry(translated);
    } catch (err) {
      if (err instanceof ParseError) return GalileoResponse.FORMAT;
      throw err;
    }
    return dispatchGalileo(entry, wa, ctx);
  }

  isErrorResponse(response: string): boolean {
    return ERROR_RESPONSES.has(response);
  }
}
