/**
 * Dialect interface — the per-vendor cryptic surface.
 *
 * A Dialect owns the *cryptic* contract: keyboard glyph mapping (Sabre's
 * `¤/§/¥`, Amadeus's plain `;` separators, …), chain splitting on the
 * dialect's end-item separator, the single-entry parse + dispatch pipeline,
 * the chain-halting error set, and the banner/screen-name strings the
 * terminal renders.
 *
 * Backend (where answers come from — local store vs. live REST) is a
 * separate axis. `processEntry` returns `string` (sync) for now — the
 * eventual async upgrade (`string | Promise<string>`) is mechanically
 * trivial in the interface but adds `await` to ~400 test call sites, so
 * it's deferred to when a live backend actually lands (see `ROADMAP.md`
 * v5 Foundations).
 *
 * Sabre is currently the only implementation (`dialects/sabre/`). The
 * `DialectId` literal union widens as new dialects land — it forces every
 * new tenant to be declared explicitly and catches typos at compile time.
 */

import type { WorkArea } from '../session/work-area.js';
import type { HandlerContext } from '../session/handlers/index.js';

/** Discriminator for `Dialect.id`. Widens as new dialects land. */
export type DialectId = 'sabre' | 'galileo';

export interface Dialect {
  /** Stable machine id — see `DialectId`. */
  readonly id: DialectId;
  /** Human display name, e.g. `'Sabre'`, `'Galileo (1G)'`. */
  readonly displayName: string;
  /** Banner shown at REPL start (and in the line-mode fallback). */
  readonly bannerText: string;
  /** Short header label for the CRT screen status bar. */
  readonly screenName: string;

  /**
   * Map physical-key aliases (ASCII) to this dialect's glyphs. Sabre maps
   * `[`→`¤`, `\`→`§`, `'`→`¥`; future dialects may pass through unchanged.
   */
  normalizeKeyboard(raw: string): string;

  /**
   * Split a transmission into its component entries on the dialect's
   * chain/end-item separator. Sabre uses `§`; Amadeus uses `;`.
   * A single entry returns `[itself]`.
   */
  splitChain(raw: string): string[];

  /**
   * Parse → dispatch a single (already keyboard-normalized) entry against
   * the given work area + handler context. Return type is `string |
   * Promise<string>` — EmulatedBackend dialects can stay sync (return a
   * string directly), live-REST dialects return a promise. `GdsHost.process`
   * awaits the result uniformly.
   */
  processEntry(raw: string, wa: WorkArea, ctx: HandlerContext): string | Promise<string>;

  /**
   * True iff `response` is a chain-halting error string in this dialect.
   * Used by the host's end-item chain loop to stop on the first error,
   * matching real-host behavior.
   */
  isErrorResponse(response: string): boolean;
}
