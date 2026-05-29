/**
 * Galileo (1G) dialect — in-progress build-out.
 *
 * Wraps Galileo's cryptic surface behind the `Dialect` interface,
 * mirroring `dialects/sabre/`:
 *   - keyboard normalization (identity — Galileo's separators are ASCII)
 *   - chain splitter on `+` (Mini Format Guide v2 "Symbols": `+` combine)
 *   - parser dispatching to `./parser.ts`
 *   - handler dispatch in `./dispatch.ts`, sharing the SessionMachine +
 *     WorkArea + PNR lifecycle with Sabre but emitting Galileo-flavored
 *     response strings from `./serializer.ts`
 *
 * Implemented verbs:
 *   - SON/Z<usercode>       sign on (Mini Guide p.5)
 *   - SOF, SOF/Z<override>  sign off (Mini Guide p.6 + Pocket Guide p.2)
 *
 * Everything else returns `FORMAT` for parse failure or `NOT IMPLEMENTED —
 * galileo dialect` for kinds the dispatch doesn't recognize yet. Both
 * are in the error-response set so a chained entry halts at the first
 * one rather than burning through 10 stubs in a row.
 *
 * Pending verbs (source-grounded in `references/galileo/`):
 *   - SB/SA/SC/... work-area switching, SAI sign-back-in
 *   - A<date><origin><destination> availability, N1Y1 sell, T.... ticketing
 *   - mandatory-field rule (Galileo's equivalent of Sabre's PRINT)
 *   - LiveTravelportBackend wrapping the 7K9S TripServices REST flow
 *     (gated on the async Dialect.processEntry upgrade — ROADMAP v5)
 */

import type { Dialect } from '../dialect.js';
import type { WorkArea } from '../../session/work-area.js';
import type { HandlerContext } from '../../session/handlers/index.js';
import { ParseError } from '../../protocol/errors.js';
import { parseGalileoEntry } from './parser.js';
import { dispatchGalileo, GALILEO_NOT_IMPLEMENTED } from './dispatch.js';
import { GalileoResponse } from './responses.js';

/** Galileo's "combine entries" operator (Mini Format Guide v2, Symbols page). */
const COMBINE = '+';

/**
 * Strings that halt an end-item chain. The Mini Guide doesn't document
 * Galileo's chain semantics explicitly, so we mirror Sabre's: stop at
 * the first error so the agent isn't surprised by silent skips.
 */
const ERROR_RESPONSES = new Set<string>([
  GalileoResponse.FORMAT,
  GALILEO_NOT_IMPLEMENTED,
  'OUT OF SEQUENCE',
]);

export class GalileoDialect implements Dialect {
  readonly id = 'galileo' as const;
  readonly displayName = 'Galileo (1G)';
  readonly bannerText =
    'Galileo (1G) terminal — type a cryptic entry. SON/Z<usercode> to sign on, .q to quit.';
  readonly screenName = 'GALILEO 1G';

  normalizeKeyboard(raw: string): string {
    return raw;
  }

  splitChain(raw: string): string[] {
    return raw
      .split(COMBINE)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  processEntry(raw: string, wa: WorkArea, ctx: HandlerContext): string | Promise<string> {
    let entry;
    try {
      entry = parseGalileoEntry(raw);
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
