/**
 * Worldspan (1P) dialect — co-build with Galileo per the v6 arc plan,
 * the same strategy that built Apollo (1V): pre-translate Worldspan's
 * cryptic deltas to their Galileo equivalents, then reuse Galileo's
 * parser + dispatch + serializer + responses entirely.
 *
 * Source: the in-tree `references/galileo/Travelport-GDS-Format-
 * Comparison-Guide.pdf` "Worldspan to Travelport+" chapter (pp.19-33)
 * — a side-by-side Rosetta of every common verb. Worldspan's surface
 * diverges from Galileo far more than Apollo's did (different sigils
 * for name/phone/received/ticketing/remarks/SSR/seats), so the
 * translator carries ~15 rules instead of Apollo's 4.
 *
 * The translation table (Comparison Guide, verbatim columns):
 *
 *   | Verb                | Worldspan              | Galileo            |
 *   |---------------------|------------------------|--------------------|
 *   | Sign on             | BSI$5467AB/GS          | SON/ZAB            |
 *   | Sign off            | BSO$                   | SOF                |
 *   | Switch to area B    | BB                     | SB                 |
 *   | Reference sell      | 01C2                   | N1C2               |
 *   | Open segment        | 0YYOPENYCPHFRAPS1      | 0YYOPENYCPHFRANO1  |
 *   | Segment status      | .1HK                   | @1HK               |
 *   | Rebook class        | X3-5#0/F               | @3-5/F             |
 *   | Avail by airline    | A23JULFRAROM-LH        | A23JULFRAROM/LH    |
 *   | Flight details      | V$2                    | TTL2               |
 *   | Name add            | -WATKINS/OSCAR MR      | N.WATKINS/OSCAR MR |
 *   | Name change         | -3@REED/CMRS           | N.P3@REED/CMRS     |
 *   | Phone add           | 9*DEN3035551234-A      | P.DEN3035551234-A  |
 *   | Phone change/delete | 92@…                   | P.2@…              |
 *   | Received            | 6JACKIE                | R.JACKIE           |
 *   | Ticketing           | 7TAW/00/21DEC          | T.TAU/21DEC        |
 *   | Ticketing (now)     | 7T/                    | T.T*               |
 *   | Remarks             | 5 TEXT                 | NP.TEXT            |
 *   | SSR                 | 3SAVGML / 3S5N1WCHR    | SI.VGML / SI.P1S5/WCHR |
 *   | OSI                 | 3OSI YY TEXT           | SI.YY*TEXT         |
 *   | Retrieve by name    | **-HARRIS              | *-HARRIS           |
 *   | Seat map from avail | 41*Y                   | SM*A1Y             |
 *   | Cancel all seats    | 4RX                    | S.@                |
 *   | E/ER/I/IR/X<n>/XI/*R/*H/*<locator>/0<direct> | identical | identical |
 *
 * Same v1 cut as Apollo: when Worldspan grows verbs with no Galileo
 * equivalent (or live 1P reveals divergence), Worldspan-specific
 * parsing gets added here. There is no live 1P backend — Worldspan
 * is Travelport-owned but not served by the TripServices JSON tenant
 * we hold; the dialect ships emulated-only.
 */

import type { Dialect, DialectId } from '../dialect.js';
import type { WorkArea } from '../../session/work-area.js';
import type { HandlerContext } from '../../session/handlers/index.js';
import { ParseError } from '../../protocol/errors.js';
import { parseGalileoEntry } from '../galileo/parser.js';
import { dispatchGalileo, GALILEO_NOT_IMPLEMENTED } from '../galileo/dispatch.js';
import { GalileoResponse } from '../galileo/responses.js';

/**
 * Worldspan→Galileo entry translation. Order matters where prefixes
 * overlap (e.g. `**-` before `*`-retrieve passthrough; `92@` phone-
 * change before `9*` phone-add).
 */
export function translateWorldspanToGalileo(raw: string): string {
  const s = raw;

  // Sign on: BSI$<numeric><agent-letters>/<duty> → SON/Z<agent-letters>.
  const bsi = /^BSI\$\d*([A-Z]{2,3})(?:\/[A-Z]{2})?$/.exec(s);
  if (bsi) return `SON/Z${bsi[1]}`;
  // Sign off.
  if (s === 'BSO$') return 'SOF';
  // Work-area switch: B<letter> → S<letter> (BB→SB … BF→SF). Bare
  // `B$` (display all areas) → OP/W* has no Galileo handler yet;
  // translate the documented switch forms only.
  const area = /^B([A-E])$/.exec(s);
  if (area) return `S${area[1]}`;

  // Reference sell: 0<digit>… → N<digit>… (same rule as Apollo —
  // direct sells `0<carrier-letter>…` pass through, both identical).
  if (/^0[1-9]/.test(s)) return 'N' + s.slice(1);
  // Open segment trailer: …PS<n> → …NO<n> (Worldspan uses PS status
  // for open segments where Galileo uses NO).
  if (/^0[A-Z]{2}OPEN/.test(s)) return s.replace(/PS(\d)$/, 'NO$1');

  // Segment status: .<digit><status> → @<digit><status>.
  if (/^\.[1-9]/.test(s)) return '@' + s.slice(1);
  // Rebook to class: X<sel>#0/<class> → @<sel>/<class>.
  const rebook = /^X([\d,\-.]+)#0\/([A-Z])$/.exec(s);
  if (rebook) return `@${rebook[1]}/${rebook[2]}`;

  // Availability carrier qualifier: trailing -<carrier> → /<carrier>.
  if (/^A\d/.test(s)) return s.replace(/-([A-Z]{2})$/, '/$1');

  // Flight details from availability: V$<n> → TTL<n>.
  const vd = /^V\$(\d{1,2})$/.exec(s);
  if (vd) return `TTL${vd[1]}`;

  // Retrieve by name: **-<surname> → *-<surname>.
  if (s.startsWith('**-')) return s.slice(1);

  // Name field (sigil '-'): -3@… name change → N.P3@…; -3@ delete →
  // N.P3@; -<name> add → N.<name>. Guard: a bare `-` only.
  const nameChange = /^-(\d)@(.*)$/.exec(s);
  if (nameChange) return `N.P${nameChange[1]}@${nameChange[2]}`;
  if (/^-[A-Z]/.test(s)) return 'N.' + s.slice(1);

  // Phone (sigil '9'): 9<n>@… change/delete → P.<n>@…; 9*<phone> →
  // P.<phone>.
  const phoneChange = /^9(\d)@(.*)$/.exec(s);
  if (phoneChange) return `P.${phoneChange[1]}@${phoneChange[2]}`;
  if (s.startsWith('9*')) return 'P.' + s.slice(2);

  // Received (sigil '6'): 6@ delete → R.@; 6<text> → R.<text>.
  if (s === '6@') return 'R.@';
  if (/^6[A-Z]/.test(s)) return 'R.' + s.slice(1);

  // Ticketing (sigil '7'): 7TAW/<office>/<date> → T.TAU/<date>;
  // 7T/ → T.T*; 7@ delete → T.@.
  const taw = /^7TAW\/[^/]*\/(\d{1,2}[A-Z]{3})$/.exec(s);
  if (taw) return `T.TAU/${taw[1]}`;
  if (s === '7T/') return 'T.T*';
  if (s === '7@') return 'T.@';

  // Remarks (sigil '5'): 5<sp><text> or 5<text> → NP.<text>; 5<n>@ →
  // NP.<n>@ delete. Keep AFTER the 7/6/9 rules (distinct sigils).
  const rmDelete = /^5(\d)@$/.exec(s);
  if (rmDelete) return `NP.${rmDelete[1]}@`;
  if (/^5[ A-Z]/.test(s)) return 'NP.' + s.slice(1).trimStart();

  // SSR/OSI (sigil '3'):
  //   3OSI <carrier> <text> → SI.<carrier>*<text>
  //   3S<seg>N<pax><code>   → SI.P<pax>S<seg>/<code>
  //   3SA<code>             → SI.<code>      (all pax/segments)
  const osi = /^3OSI ([A-Z0-9]{2}) (.+)$/.exec(s);
  if (osi) return `SI.${osi[1]}*${osi[2]}`;
  const ssrSeg = /^3S(\d)N(\d)([A-Z]{4})$/.exec(s);
  if (ssrSeg) return `SI.P${ssrSeg[2]}S${ssrSeg[1]}/${ssrSeg[3]}`;
  const ssrAll = /^3SA([A-Z]{4})$/.exec(s);
  if (ssrAll) return `SI.${ssrAll[1]}`;

  // Seats (sigil '4'): 4<line>*<class> seat map from availability →
  // SM*A<line><class>.
  const seatMap = /^4(\d{1,2})\*([A-Z])$/.exec(s);
  if (seatMap) return `SM*A${seatMap[1]}${seatMap[2]}`;

  // 4R seat-request family → Galileo S. (wired in W.2). The three
  // verbatim Comparison Guide rows plus the structural cancel forms:
  //   4RA$W       → S.NW    non-smoking window
  //   4RA$5A      → S.SA    smoking aisle
  //   4RS6$9A     → S.S6P1/9A   seat by segment + passenger
  //   4RX-6       → S.S6@   cancel seats for segment 6
  //   4RX         → S.@     cancel all seats
  if (s === '4RA$W') return 'S.NW';
  if (s === '4RA$5A') return 'S.SA';
  const seatReq = /^4RS(\d{1,2})\$(\d{1,3}[A-Z])$/.exec(s);
  if (seatReq) return `S.S${seatReq[1]}P1/${seatReq[2]}`;
  const seatCancelSeg = /^4RX-(\d{1,2})$/.exec(s);
  if (seatCancelSeg) return `S.S${seatCancelSeg[1]}@`;
  if (s === '4RX') return 'S.@';

  return s;
}

/** Chain split — Worldspan end-item is documented as `$` in some
 *  materials, but the Comparison Guide shows single entries only;
 *  v1 mirrors Apollo's `+` chain treatment for QEB-style ambiguity. */
function splitWorldspanChain(raw: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '+' && !/^\d+$/.test(raw.slice(i + 1).split('+')[0] ?? '')) {
      out.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  out.push(raw.slice(start));
  return out.filter((e) => e.length > 0);
}

const ERROR_RESPONSES = new Set<string>([
  GalileoResponse.FORMAT,
  GALILEO_NOT_IMPLEMENTED,
  'OUT OF SEQUENCE',
]);

export class WorldspanDialect implements Dialect {
  readonly id: DialectId = 'worldspan';
  readonly displayName = 'Worldspan (1P)';
  readonly bannerText =
    'Worldspan (1P) terminal — type a cryptic entry. BSI$<num><agent>/GS to sign on, .q to quit.';
  readonly screenName = 'WORLDSPAN 1P';

  normalizeKeyboard(raw: string): string {
    return raw;
  }

  splitChain(raw: string): string[] {
    return splitWorldspanChain(raw);
  }

  processEntry(raw: string, wa: WorkArea, ctx: HandlerContext): string | Promise<string> {
    const translated = translateWorldspanToGalileo(raw);
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
