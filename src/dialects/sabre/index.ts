/**
 * Sabre dialect — the reference tenant of the gds-emulator.
 *
 * Wraps today's Sabre cryptic surface behind the `Dialect` interface:
 *   - keyboard map + end-item splitter from `protocol/keyboard.ts`
 *   - sigil-dispatch parser from `protocol/parser.ts`
 *   - the Sabre handler dispatch table from `session/handlers/`
 *   - the Sabre canned responses from `./responses.ts`
 *
 * Everything Sabre-specific now lives behind this seam; `GdsHost` will
 * stop importing the parser/keyboard/Response directly in step 2 and only
 * talk to a `Dialect`.
 *
 * Source-grounded in `references/Sabre-Basic-Reservation-Course.pdf`
 * (Working in the Sabre System, Ed. 2.7) and the four sibling Sabre PDFs.
 */

import type { Dialect } from '../dialect.js';
import type { WorkArea } from '../../session/work-area.js';
import type { HandlerContext } from '../../session/handlers/index.js';
import { dispatch } from '../../session/handlers/index.js';
import { parseEntry } from '../../protocol/parser.js';
import { ParseError } from '../../protocol/errors.js';
import { normalizeKeyboard, splitEndItems } from '../../protocol/keyboard.js';
import { Response } from './responses.js';

/**
 * Strings that halt an end-item chain (`§`-separated transmission). Matches
 * a real Sabre host: the chain runs to the first error, which is what the
 * agent sees on the screen. Includes Sabre's canned `Response.*` strings
 * plus the literal availability/sell error strings emitted directly by
 * the availability + sell handlers.
 */
const ERROR_RESPONSES = new Set<string>([
  Response.FORMAT,
  Response.NEED_PHONE,
  Response.NEED_TICKETING,
  Response.NEED_RECEIVED_FROM,
  Response.NEED_ITINERARY,
  Response.NEED_NAME,
  Response.NAMES_NOT_EQUAL,
  Response.NO_PNR,
  Response.NO_ITINERARY,
  Response.SEGMENT_NOT_FOUND,
  Response.INVALID_STATUS,
  Response.RECORD_LOCATOR_NOT_FOUND,
  'NO AVAILABILITY DISPLAYED',
  'CLASS NOT AVAILABLE',
  'NOT A CONNECTION',
  'OUT OF SEQUENCE',
  'NO FLIGHTS',
  'BACKWARD SKIP NOT SUPPORTED', // reconstructed; emitted by QBI-N
]);

export class SabreDialect implements Dialect {
  readonly id = 'sabre' as const;
  readonly displayName = 'Sabre';
  readonly bannerText =
    'SABRE GDS terminal — type a cryptic entry. SI to sign in, .q to quit.';
  readonly screenName = 'SABRE GDS';

  normalizeKeyboard(raw: string): string {
    return normalizeKeyboard(raw);
  }

  splitChain(raw: string): string[] {
    return splitEndItems(raw);
  }

  processEntry(raw: string, wa: WorkArea, ctx: HandlerContext): string {
    let entry;
    try {
      entry = parseEntry(raw);
    } catch (err) {
      if (err instanceof ParseError) return Response.FORMAT;
      throw err;
    }
    return dispatch(entry, wa, ctx);
  }

  isErrorResponse(response: string): boolean {
    return ERROR_RESPONSES.has(response);
  }
}
