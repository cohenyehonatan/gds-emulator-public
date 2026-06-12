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
import { handlePrintQueueVerb } from '../../session/print-spool.js';
import { GalileoResponse } from './responses.js';
import { renderEncodeDecode } from './encode-decode.js';
import { renderAreaStatus } from '../../session/area-status.js';

/** Galileo's "combine entries" operator (Mini Format Guide v2, Symbols page). */
const COMBINE = '+';

/**
 * Split a chained entry on `+`. Disambiguate from the multi-queue `+`
 * separator (`QEB/35+40+45`, `QR/23+77`, Pocket Guide p.31 / Mini
 * Guide p.45): only split where the character after `+` (after any
 * intermediate whitespace) looks like the start of a new verb — a
 * letter, `@`, or `*`. A pure-digit continuation stays attached as
 * part of the prior verb's syntax.
 *
 * `+` followed by nothing is treated as a trailing chain separator
 * and dropped.
 */
function splitGalileoChain(raw: string): string[] {
  // Combination DISPLAY entries stay whole: the Formats Guide's
  // "Combination of Active and Historical Displays" documents
  // `*N.I+*HIA.SI` as ONE display producing the combined screen
  // ("…followed by a display of…"), not a chain that shows only the
  // final state. When the entry starts with `*` and every +-part
  // also starts with `*`, hand the whole thing to the display
  // handler. Mixed chains (`*R+ER`) still split.
  const t = raw.trim();
  if (t.startsWith('*') && t.includes(COMBINE)) {
    const parts = t.split(COMBINE).map((x) => x.trim());
    if (parts.length > 1 && parts.every((x) => x.startsWith('*') && x.length > 1)) {
      return [t];
    }
  }
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== COMBINE) continue;
    let j = i + 1;
    while (j < raw.length && raw[j] === ' ') j++;
    const head = raw[j];
    if (head != null && /[A-Za-z@*]/.test(head)) {
      out.push(raw.slice(start, i).trim());
      start = j;
      i = j - 1;
    }
    // else: digit (or end) — leave the `+` attached to the current segment.
  }
  out.push(raw.slice(start).trim());
  return out.filter((s) => s.length > 0);
}

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
    return splitGalileoChain(raw);
  }

  processEntry(raw: string, wa: WorkArea, ctx: HandlerContext): string | Promise<string> {
    // MIR interface control (Trams Apollo/Galileo Interface Guide,
    // entry forms verbatim; responses reconstructed):
    //   HMLM<lniata>DA   establish the link to the MIR device
    //   HMLD             link status (MIR DEV + U up / D down)
    //   HQC              queue message count (Pending/Sent table)
    //   HMOM<lniata>-U/-D  bring the link up / down
    const rawU = raw.trim().toUpperCase();

    // P- print router (GPM.net appendix, references/print/, entry
    // forms verbatim): strip the prefix, run the remainder through
    // the normal pipeline, route the rendered screen to the print
    // spool. Appendix rule: "You can print any field in the
    // retrieved BF by preceding the display option with P-."
    // Error responses display on screen and print nothing. On-screen
    // confirmation reconstructed. Documented divergence: the
    // unretrieved forms (P-*<locator>, P-*-<name>) retrieve the BF
    // into the work area as a side effect of the shared display
    // pipeline; the real host prints without disturbing the screen.
    if (rawU.startsWith('P-') && rawU.length > 2 && !rawU.startsWith('P-P-')) {
      const inner = raw.trim().slice(2);
      return Promise.resolve(this.processEntry(inner, wa, ctx)).then((resp) => {
        if (this.isErrorResponse(resp)) return resp;
        const job = ctx.backend.printSpool.print(rawU, resp);
        return `PRINTED - ${job.gtid}`; // reconstructed
      });
    }

    // HQ<op><gtid> — printer host queue (GPM.net appendix; responses
    // verbatim where documented). Checked before bare HQC, which
    // stays the Trams MIR Pending/Sent counts verb.
    const hq = handlePrintQueueVerb(rawU, ctx.backend.printSpool);
    if (hq !== undefined) return hq;

    const hmlm = /^HMLM([A-Z0-9]{6})DA$/.exec(rawU);
    if (hmlm) {
      ctx.backend.interfacePos.log(`LINK ESTABLISHED ${hmlm[1]}`);
      return `LINKAGE ESTABLISHED - MIR DEV ${hmlm[1]}`;
    }
    if (rawU === 'HMLD') {
      const up = ctx.backend.interfacePos.status === 'ACTIVE';
      return `MIR DEV  STATUS\nC0FFEE   ${up ? 'U' : 'D'}`;
    }
    if (rawU === 'HQC') {
      const pos = ctx.backend.interfacePos;
      const sent = pos.records.filter((r) => r.transmitted).length;
      return [
        'TYPE   PORT   PENDING   SENT',
        `ACC    02     ${String(pos.pending().length).padEnd(9)} ${sent}`,
      ].join('\n');
    }
    const hmom = /^HMOM([A-Z0-9]{6})-([UD])$/.exec(rawU);
    if (hmom) {
      const pos = ctx.backend.interfacePos;
      if (hmom[2] === 'U') {
        const { sent, error } = pos.transmit();
        if (error) return 'LINK ERROR - DEVICE NOT READY'; // reconstructed
        pos.status = 'ACTIVE';
        return `MIR DEV ${hmom[1]} UP - ${sent} RECORD(S) SENT`;
      }
      pos.status = 'ON HOLD';
      return `MIR DEV ${hmom[1]} DOWN`;
    }

    // OP/W* — work-area status display (the all-areas view; the
    // Worldspan B$ translation lands here). Layout reconstructed.
    if (raw.trim().toUpperCase() === 'OP/W*') {
      return renderAreaStatus(wa);
    }

    // Encode/decode family — .CD/.CE (city) and .AD/.AE (airline),
    // the forms the help table has always listed (previously
    // unimplemented — the Worldspan calibration arc surfaced the
    // gap). Response wording reconstructed.
    const ed = /^\.(C|A)(D|E) (.+)$/.exec(raw.trim().toUpperCase());
    if (ed) {
      return renderEncodeDecode(ed[1] as 'C' | 'A', ed[2] as 'D' | 'E', ed[3]);
    }

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
