/**
 * Galileo (1G) dialect — **SKELETON ONLY**.
 *
 * Proves the Dialect seam pays out: a second dialect plugs in by adding
 * one file (this one) + one literal-union widening in `dialects/dialect.ts`,
 * no host or REPL changes required. The CLI and npm scripts pick it up
 * automatically.
 *
 * What's implemented (just enough to start the REPL and not crash):
 *   - banner + screen-name strings (visible to the user)
 *   - keyboard normalization — identity (Galileo's separators are all ASCII;
 *     no aliasing layer needed like Sabre's `[`→`¤`, `\`→`§`, `'`→`¥`)
 *   - chain splitting — on `+`, Galileo's "combine entries" operator per the
 *     Travelport+ Mini Format Guide v2 ("Symbols": `+` combine, `;` parallel
 *     search, `@` change/delete, `*` display, `>` SOM, `)>` more-info)
 *   - processEntry — returns NOT_IMPLEMENTED for every input
 *   - isErrorResponse — true for NOT_IMPLEMENTED so chains halt at the first
 *     entry rather than running 10 stubs in a row
 *
 * What's deliberately NOT implemented (the real Galileo dialect work):
 *   - parser for `A`/`SS`/`N.`/`P.`/`T.`/`R.`/`E`/`ER`/`I`/`IR`/`@`/`*`/…
 *   - serializer for Galileo screen layouts (availability columns, sold-
 *     segment line, BF display) — Smartpoint Module 2 in `references/galileo/`
 *     has the column annotations
 *   - mandatory-field rule (Galileo's equivalent of Sabre's PRINT — different
 *     field set; see Mini Format Guide v2)
 *   - live REST backend (cryptic → CatalogProductOfferings → render) — gated
 *     on the async `Dialect.processEntry` upgrade, see ROADMAP v5 Foundations
 *
 * References live in `references/galileo/`. Source the work from there.
 */

import type { Dialect } from '../dialect.js';
import type { WorkArea } from '../../session/work-area.js';
import type { HandlerContext } from '../../session/handlers/index.js';

const NOT_IMPLEMENTED = 'NOT IMPLEMENTED — galileo dialect is a skeleton';

/** Galileo's "combine entries" operator (Mini Format Guide v2, Symbols page). */
const COMBINE = '+';

export class GalileoDialect implements Dialect {
  readonly id = 'galileo' as const;
  readonly displayName = 'Galileo (1G)';
  readonly bannerText =
    'Galileo (1G) terminal — SKELETON ONLY. Every entry returns NOT IMPLEMENTED. .q to quit.';
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

  processEntry(_raw: string, _wa: WorkArea, _ctx: HandlerContext): string {
    return NOT_IMPLEMENTED;
  }

  isErrorResponse(response: string): boolean {
    return response === NOT_IMPLEMENTED;
  }
}
