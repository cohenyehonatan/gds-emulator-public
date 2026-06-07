/**
 * Amadeus dialect — emulated-only, format-grounded v1.
 *
 * Amadeus is the third GDS the project ships behind the Dialect seam.
 * Unlike Galileo and Apollo (which share Travelport's TripServices
 * REST surface), Amadeus is a separate vendor with no Travelport-style
 * creds path. The Amadeus dialect ships fully emulated for now — the
 * project owns the behavior layer.
 *
 * Cryptic sourced verbatim from `references/amadeus/Amadeus-Cryptic-
 * Entries-Reference-Guide-Ed-9.2-2012.pdf` (Edition 9.2, July 2012,
 * Amadeus Global Learning Services). Format coverage is A-grade for
 * 11 of 12 fidelity categories.
 *
 * v1 implemented verbs (sign-on family):
 *
 *   | Verb                          | Cryptic              | Example          |
 *   |-------------------------------|----------------------|------------------|
 *   | Sign in (first work area)     | JI<duty><init>/<sys> | JI2345HA/GS      |
 *   | Sign in to specific area      | JIA<duty><init>/<sys>| JIA2345HA/GS     |
 *   | Sign out current area         | JO                   | JO               |
 *   | Sign out all areas            | JO*                  | JO*              |
 *   | Display work area status      | JD                   | JD               |
 *
 * Everything else returns `NOT IMPLEMENTED — amadeus dialect (v1)`.
 * Following the project's honest-boundary principle (per ROADMAP item
 * "Hybrid coverage, made explicit"): an explicit "not implemented"
 * stub is much better than a silent format error or, worse, a fake
 * success that doesn't reflect real Amadeus behavior.
 *
 * Behavior layer caveat: even when v2+ adds availability, sell,
 * pricing etc., Amadeus's NUC/ROE/HIP fare construction, alliance
 * logic, and MCT exceptions have no public source — they would be
 * format-faithful, behavior-synthesized. Flag that explicitly when
 * those handlers land. (See ROADMAP "Amadeus — emulated, format-
 * grounded" section.)
 *
 * Chain operator: Amadeus uses `;` to combine entries (per CLAUDE.md
 * Dialect docstring: "Sabre uses `§`; Amadeus uses `;`"). Single
 * entries with no `;` return as [self].
 */

import type { Dialect } from '../dialect.js';
import type { WorkArea } from '../../session/work-area.js';
import type { HandlerContext } from '../../session/handlers/index.js';
import { SessionEvent } from '../../session/session-state.js';

const NOT_IMPLEMENTED = 'NOT IMPLEMENTED — amadeus dialect (v1)';
const FORMAT_ERROR = 'FORMAT';
const NEED_AGENT_SIGN = 'NEEDS AGENT SIGN'; // reconstructed (Amadeus QRG p.7 lists no exact error wording for this)

/**
 * Errors that halt a chained entry. Same convention as the other
 * dialects — first error stops further verbs in the chain.
 */
const ERROR_RESPONSES = new Set<string>([NOT_IMPLEMENTED, FORMAT_ERROR, NEED_AGENT_SIGN]);

/**
 * Amadeus chain operator (`;`). The QRG doesn't document chain
 * semantics, but mainframe Amadeus terminals have always used `;`
 * to combine entries. Single entries with no `;` return as `[raw]`.
 */
function splitAmadeusChain(raw: string): string[] {
  return raw.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Parse the Amadeus sign-on argument `<duty><initials>/<system>`,
 * e.g. `2345HA/GS`. Returns the initials part (used as the agent id
 * on the WorkArea) or undefined when the format doesn't match.
 *
 * The duty code (1-4 digits) and initials (1-3 letters) parse loosely
 * since the QRG doesn't pin down their lengths absolutely. The trailing
 * `/<system>` qualifier is accepted but not validated against a known
 * system list — pre-prod Amadeus would reject unknown systems, but
 * since we ship no live backend, we accept any.
 */
function parseSignInArgument(arg: string): { agent: string } | undefined {
  const match = /^(\d{1,4})([A-Z]{1,3})\/([A-Z]{1,3})$/.exec(arg);
  if (!match) return undefined;
  return { agent: match[2] };
}

export class AmadeusDialect implements Dialect {
  readonly id = 'amadeus' as const;
  readonly displayName = 'Amadeus';
  readonly bannerText =
    'Amadeus terminal — type a cryptic entry. JI<duty><initials>/<system> to sign on, .q to quit.';
  readonly screenName = 'AMADEUS';

  normalizeKeyboard(raw: string): string {
    return raw;
  }

  splitChain(raw: string): string[] {
    return splitAmadeusChain(raw);
  }

  processEntry(raw: string, wa: WorkArea, _ctx: HandlerContext): string {
    const entry = raw.trim();
    if (entry.length === 0) return FORMAT_ERROR;

    // Sign-on family. JI prefix → sign-in; JO[*] → sign-out; JD → status.
    if (entry.startsWith('JI')) {
      // Strip JI prefix, then optionally a single uppercase work-area
      // letter (A-Z). Anything else (e.g. multi-area `A/B/C/`) goes
      // through the basic parser; multi-area sign-in is deferred.
      const rest = entry.slice(2);
      const matchArea = /^([A-Z])([0-9].*)$/.exec(rest);
      const arg = matchArea ? matchArea[2] : rest;
      const parsed = parseSignInArgument(arg);
      if (!parsed) return FORMAT_ERROR;
      try {
        wa.machine.transition(SessionEvent.SIGN_IN);
      } catch {
        return FORMAT_ERROR;
      }
      wa.agent = parsed.agent;
      // Amadeus QRG p.7 doesn't show the literal sign-in response;
      // reconstructed as a simple confirmation echo. The dialect's
      // honest-boundary principle accepts this since the cryptic is
      // verified — only the response wording is reconstructed.
      return `${parsed.agent} SIGNED IN`;
    }
    if (entry === 'JO' || entry === 'JO*') {
      if (!wa.agent) return NEED_AGENT_SIGN;
      const agent = wa.agent;
      try {
        wa.machine.transition(SessionEvent.SIGN_OFF);
      } catch {
        return FORMAT_ERROR;
      }
      wa.reset();
      return `${agent} SIGNED OUT`;
    }
    if (entry === 'JD') {
      if (!wa.agent) return NEED_AGENT_SIGN;
      // Amadeus JD displays "status of work areas". For v1 we just
      // echo the agent + the single area we model. Multi-area work
      // (JIA/B/C/D...) is deferred.
      return `WORK AREA STATUS\n  A  ${wa.agent}  [${wa.state()}]`;
    }
    // Everything else: honest "not implemented" stub.
    return NOT_IMPLEMENTED;
  }

  isErrorResponse(response: string): boolean {
    return ERROR_RESPONSES.has(response);
  }
}
