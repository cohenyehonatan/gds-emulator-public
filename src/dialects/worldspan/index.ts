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
import { renderEncodeDecode } from '../galileo/encode-decode.js';

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

  // Encode/decode (Go! Res manual p.25, forms verbatim):
  //   KC/LONDON → .CE LONDON     KD/CDG → .CD CDG
  //   KAC/DELTA → .AE DELTA      KAD/EI → .AD EI
  const kcd = /^K(A?)(C|D)\/(.+)$/.exec(s);
  if (kcd) return `.${kcd[1] ? 'A' : 'C'}${kcd[2] === 'C' ? 'E' : 'D'} ${kcd[3]}`;

  // Hotel family (Comparison Guide "Hotels" 5-way table, Worldspan
  // column):
  //   HLMUC9APR16APR2[/quals] → HOA9APR-16APRMUC2   availability
  //   HLNRT                   → HOINRT              hotel index
  //   HLNRT/CEM               → HOINRT/EM           index by chain
  //   HA3                     → HOC3                complete avail
  const hlAvail = /^HL([A-Z]{3})(\d{1,2}[A-Z]{3})(\d{1,2}[A-Z]{3})(\d{1,2})?(?:\/.*)?$/.exec(s);
  if (hlAvail) {
    return `HOA${hlAvail[2]}-${hlAvail[3]}${hlAvail[1]}${hlAvail[4] ?? ''}`;
  }
  const hlIndex = /^HL([A-Z]{3})(?:\/C([A-Z]{2}))?$/.exec(s);
  if (hlIndex) {
    return hlIndex[2] ? `HOI${hlIndex[1]}/${hlIndex[2]}` : `HOI${hlIndex[1]}`;
  }
  const haComplete = /^HA(\d{1,2})$/.exec(s);
  if (haComplete) return `HOC${haComplete[1]}`;

  // Car family (Comparison Guide "Cars" table, Worldspan column):
  //   CRA23AUG-25AUGDEN/… → CAL23AUG-25AUGDEN/…   availability
  //   CR04                → N1A4                   reference sell
  //                         (one car from avail line 4)
  // The H0/R- hotel-sell and CRD description forms are not cleanly
  // decomposable from the guide's single examples — deferred.
  if (/^CRA\d/.test(s)) return 'CAL' + s.slice(3);
  const cr0 = /^CR0(\d{1,2})$/.exec(s);
  if (cr0) return `N1A${cr0[1]}`;

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

/**
 * Alliance indicator per the Go! Res manual's verbatim legend
 * (*A Star Alliance, *O OneWorld, *S SkyTeam; blank = none).
 * Membership for our seeded carriers reconstructed from public
 * alliance rosters.
 */
const WS_ALLIANCE: Record<string, string> = {
  UA: '*A', LH: '*A', AA: '*O', BA: '*O', DL: '*S', AF: '*S', AZ: '*S',
};

/**
 * Participation-level indicator (verbatim legend: blank = Full
 * Service, $ = Venta Directa/direct sell, # = Airline Source/Host,
 * * = Acceso Directo/direct access). Per-carrier values
 * reconstructed — majors as Airline Source.
 */
const WS_PARTICIPATION: Record<string, string> = {
  UA: '#', LH: '#', AA: '#', BA: '#', DL: '#', AF: '#', AZ: '#',
  B6: '$', FI: '$', '6X': '#',
};

/**
 * Native Worldspan neutral-availability display — layout VERBATIM
 * from the Go! Res manual (references/worldspan/, p.25):
 *
 *   29OCT-SA-0700 BUEROM ** ** WL-PLUS
 *   1*S#AZ 681 J7 D7 I7 Y7 B7 M7 H7 K7 EZEFCO 1445 0735 #1   772 0E
 *              V7 T7 N7 L1 W.
 *
 * Header: <date>-<DOW>-<time> <citypair> ** ** WL-PLUS (** ** = the
 * timezone indicator outside the US; MT/ET/PT/CT inside — we render
 * the non-US form). Lines: number + alliance + participation marks,
 * carrier+flight, EIGHT class pairs per row (counts cap at 7 — the
 * manual's "J7 = max bookable in one transaction"), citypair, 24h
 * times, #1 next-day, equipment, stops digit + E e-ticket flag.
 * Waitlist-state glyphs (B0 open / W. closed / H- carrier-controlled)
 * aren't modeled — our classes carry plain counts.
 */
function renderWorldspanAvailability(avail: import('../../models/availability-result.js').AvailabilityResult): string {
  const dow = wsDow(avail.date);
  const lines: string[] = [`${avail.date}-${dow}-0700 ${avail.origin}${avail.destination} ** ** WL-PLUS`];
  let lineNo = 0;
  for (const l of avail.lines) {
    lineNo += 1;
    const alliance = WS_ALLIANCE[l.carrier] ?? ' ';
    const part = WS_PARTICIPATION[l.carrier] ?? ' ';
    const pairs = Object.entries(l.classes).map(([c, n]) => `${c}${Math.min(n, 7)}`);
    const first = pairs.slice(0, 8).join(' ');
    const rest = pairs.slice(8).join(' ');
    const dep = ws24(l.departTime);
    const arr = ws24(l.arriveTime);
    const nextDay = wsClockMin(l.arriveTime) <= wsClockMin(l.departTime) ? ' #1' : '';
    // Connection continuation legs show only the destination
    // (manual line 4: `4*A#LH3840 … FCO 0735 0920 #1`).
    const isContinuation = l.connectionGroup != null && (l.legIndex ?? 0) > 0;
    const cityBlock = isContinuation ? `   ${l.destination}` : `${l.origin}${l.destination}`;
    const head = `${lineNo}${alliance.padEnd(2)}${part}${l.carrier}${l.flightNumber.padStart(4)}`;
    lines.push(`${head} ${first} ${cityBlock} ${dep} ${arr}${nextDay}   ${l.equipment} 0E`);
    if (rest) lines.push(`${' '.repeat(head.length + 1)}${rest}`);
  }
  return lines.join('\n');
}

/** DDMON ± n days, month-aware (real calendar, next-occurrence year). */
function wsAddDays(date: string, n: number): string {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const m = /^(\d{1,2})([A-Z]{3})$/.exec(date);
  if (!m) return date;
  const now = new Date();
  const t = new Date(Date.UTC(now.getUTCFullYear(), months.indexOf(m[2]), parseInt(m[1], 10) + n));
  return `${t.getUTCDate()}${months[t.getUTCMonth()]}`;
}

/**
 * Native PNR display (Go! Res manual p.45, verbatim layout). Fields
 * not present on our model (TKG FAX advisories, DI items) are
 * omitted; the ITEMS SUPPRESSED trailer renders verbatim.
 */
function renderWorldspanPnr(pnr: import('../../models/pnr.js').Pnr): string {
  const lines: string[] = [`1P- ${pnr.locator ?? ''}`.trimEnd()];
  let paxNo = 0;
  for (const nm of pnr.names) {
    for (const pax of nm.passengers) {
      paxNo += 1;
      lines.push(` ${paxNo}.1${nm.surname}/${pax.firstName}${pax.title ? ' ' + pax.title : ''}*ADT`);
    }
  }
  for (const seg of pnr.segments) {
    lines.push(` ${renderWorldspanSoldSegment(seg)}`);
  }
  pnr.phones.forEach((ph, i) => {
    lines.push(`P- ${i + 1}.${ph.city ? ph.city + ' ' : ''}${ph.number}${ph.type ? '-' + ph.type[0].toUpperCase() : ''}`);
  });
  if (pnr.ticketing) {
    // Stored Galileo-side as TAU/<date>; Worldspan shows TAW/00/<date>.
    const date = /(\d{1,2}[A-Z]{3})/.exec(pnr.ticketing)?.[1];
    lines.push(`T- 1.${date ? `TAW/00/${date}` : pnr.ticketing}`);
  }
  let gNo = 0;
  for (const osi of pnr.osis) {
    gNo += 1;
    lines.push(`G- ${gNo}.OSI ${osi.carrier} ${osi.text}`);
  }
  for (const ssr of pnr.ssrs) {
    gNo += 1;
    lines.push(`G- ${gNo}.SSR ${ssr.code} ${ssr.carrier} ${ssr.status}1${ssr.text ? ' ' + ssr.text : ''}`);
  }
  lines.push('**** ITEMS SUPPRESSED ****/ML');
  return lines.join('\n');
}

/**
 * Verbatim sold-segment line (Go! Res manual p.31). The /O marker
 * appears on every published sample (undocumented in the legend —
 * rendered literally); $ /# is the participation mark; E flags
 * e-ticket acceptance.
 */
function renderWorldspanSoldSegment(seg: import('../../models/segment.js').AirSegment): string {
  const part = WS_PARTICIPATION[seg.carrier] ?? ' ';
  const dep = ws24(seg.departTime);
  const arr = ws24(seg.arriveTime);
  const nextDay = seg.departTime && seg.arriveTime && wsClockMin(seg.arriveTime) <= wsClockMin(seg.departTime) ? ' #1' : '';
  const dow = wsDow(seg.date);
  return `${seg.segmentNumber} ${seg.carrier}${seg.flightNumber.padStart(4)}${seg.bookingClass} ${seg.date} ${dow} ${seg.origin}${seg.destination} ${seg.status}${seg.seats}    ${dep}   ${arr}${nextDay}/O ${part}   E`;
}

function wsDow(date: string): string {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const m = /^(\d{1,2})([A-Z]{3})$/.exec(date);
  if (!m) return '--';
  const mon = months.indexOf(m[2]);
  const now = new Date();
  let t = new Date(Date.UTC(now.getUTCFullYear(), mon, parseInt(m[1], 10)));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (t < today) t = new Date(Date.UTC(now.getUTCFullYear() + 1, mon, parseInt(m[1], 10)));
  return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][t.getUTCDay()];
}

function ws24(t: string): string {
  const m = /^(\d{1,2})(\d{2})([APN])$/.exec(t);
  if (!m) return t;
  let h = parseInt(m[1], 10) % 12;
  if (m[3] === 'P') h += 12;
  if (m[3] === 'N') h = 12;
  return `${String(h).padStart(2, '0')}${m[2]}`;
}

function wsClockMin(t: string): number {
  const m = /^(\d{1,2})(\d{2})([APN])$/.exec(t);
  if (!m) return 0;
  let h = parseInt(m[1], 10) % 12;
  if (m[3] === 'P') h += 12;
  if (m[3] === 'N') h = 12;
  return h * 60 + parseInt(m[2], 10);
}

const WS_HELP_BANNER =
  'EMULATOR HELP — Worldspan forms this terminal accepts (host help screens are not public)';

const WS_TOPICS: { keys: string[]; title: string; lines: string[] }[] = [
  { keys: ['SON', 'SIGNON'], title: 'SIGN ON / OFF', lines: [
    'BSI$<num><agent>/GS   sign on', 'BSO$                  sign off', 'B<letter>             switch work area'] },
  { keys: ['AVAIL', 'A'], title: 'AVAILABILITY', lines: [
    'A<date><org><dst>[-<cxr>]   availability', 'V$<n>                       flight details'] },
  { keys: ['SELL', '0'], title: 'SELL', lines: [
    '0<seats><cls><line>         reference sell', '0<cxr><flt>… NN<n>          direct sell',
    '.<n><status>                change status', 'X<sel>#0/<class>            rebook to class'] },
  { keys: ['NAME', 'N'], title: 'NAME', lines: [
    '-<surname>/<given> <title>  add', '-<n>@<new>                  change', '-<n>@                       delete'] },
  { keys: ['FIELDS', '9', '6', '7', '5'], title: 'PNR FIELDS', lines: [
    '9*<phone>      phone        92@…   change/delete',
    '6<name>        received     7TAW/00/<date>  ticketing TAW',
    '5 <text>       remark       5<n>@  delete remark'] },
  { keys: ['SSR', '3'], title: 'SSR / OSI', lines: [
    '3SA<code>            SSR all pax', '3S<seg>N<pax><code>  SSR per seg/pax', '3OSI <cxr> <text>    OSI'] },
  { keys: ['SEATS', '4R'], title: 'SEATS', lines: [
    '4<line>*<class>   seat map from availability', '4RS<seg>$<seat>   request seat',
    '4RA$W / 4RA$5A    non-smoking window / smoking aisle', '4RX-<seg> / 4RX   cancel segment / all'] },
  { keys: ['HOTELS', 'HL'], title: 'HOTELS', lines: [
    'HL<city><d1><d2><adults>   availability', 'HL<city>[/C<chain>]        index', 'HA<line>                   complete availability'] },
  { keys: ['CARS', 'CRA'], title: 'CARS', lines: [
    'CRA<d1>-<d2><city>[/…]     availability', 'CR0<line>                  reference sell'] },
  { keys: ['FARES', 'FQ', 'PRICE'], title: 'FARES / PRICING', lines: [
    'FQ                 fare quote itinerary', 'TKP                ticket'] },
  { keys: ['END', 'E'], title: 'END / RETRIEVE', lines: [
    'E / ER             end / end + retrieve', 'I / IR             ignore',
    '*<locator>         retrieve', '**-<surname>       retrieve by name'] },
];

function renderWorldspanHelp(topic?: string): string {
  if (!topic) {
    return [WS_HELP_BANNER, '', 'TOPICS — HELP <topic>:',
      ...WS_TOPICS.map((t) => `  ${t.keys[0].padEnd(8)} ${t.title}`)].join('\n');
  }
  const t = WS_TOPICS.find((x) => x.keys.includes(topic));
  if (!t) {
    const matches = WS_TOPICS.filter((x) => x.keys.some((k) => k.startsWith(topic)));
    if (matches.length > 0) {
      return [WS_HELP_BANNER, '', `TOPICS MATCHING ${topic}:`,
        ...matches.map((m) => `  ${m.keys[0].padEnd(8)} ${m.title}`)].join('\n');
    }
    return `NO HELP FOR ${topic} — HELP FOR THE TOPIC INDEX`;
  }
  return [WS_HELP_BANNER, '', t.title, ...t.lines.map((l) => `  ${l}`)].join('\n');
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
    // Help is Worldspan-native (the translator table IS the help
    // content — these are the forms this dialect accepts). Entry
    // forms per the Comparison Guide's Worldspan column: HELP,
    // HELP <chapter>, HELP <topic>, INFO <topic>.
    const u = raw.trim().toUpperCase();
    const helpMatch = /^(?:HELP|INFO)(?:\s+([A-Z0-9.@*]{1,12}))?$/.exec(u);
    if (helpMatch) {
      return renderWorldspanHelp(helpMatch[1]);
    }
    // Availability continuation entries (calibration arc commit 2)
    // — forms VERBATIM from the Go! Res manual's HELP AVAILCONT
    // table (p.26). Each re-runs the cached request with a delta and
    // re-renders natively:
    //   AD / A*      more flights / recall   (one-screen seed: both
    //                redisplay the full list)
    //   AT / AY      next / previous day
    //   A<n>D        n days later            A28JUN  same pair, new date
    //   A1400        same pair, new time (accepted; our inventory
    //                isn't time-paginated — flagged)
    //   A-DL / A-YY  carrier filter / back to all airlines
    //   A/R[<date>]  return availability (city pair swapped)
    //   A@A<city> / A@D<city>   change destination / origin
    // AU (previous display) and AC<n> (more classes) aren't modeled —
    // no display paging. AE/AO (elapsed times) deferred.
    const cont = wa.lastAvailability;
    if (cont) {
      const rerun = (date: string, org: string, dst: string, cxr?: string) =>
        this.processEntry(`A${date}${org}${dst}${cxr ? '-' + cxr : ''}`, wa, ctx);
      if (u === 'AD' || u === 'A*') return rerun(cont.date, cont.origin, cont.destination);
      if (u === 'AT') return rerun(wsAddDays(cont.date, 1), cont.origin, cont.destination);
      if (u === 'AY') return rerun(wsAddDays(cont.date, -1), cont.origin, cont.destination);
      const nDays = /^A(\d{1,2})D$/.exec(u);
      if (nDays) return rerun(wsAddDays(cont.date, parseInt(nDays[1], 10)), cont.origin, cont.destination);
      const newDate = /^A(\d{1,2}[A-Z]{3})$/.exec(u);
      if (newDate) return rerun(newDate[1], cont.origin, cont.destination);
      const newTime = /^A(\d{3,4})$/.exec(u);
      if (newTime) return rerun(cont.date, cont.origin, cont.destination);
      const cxrFilter = /^A-([A-Z0-9]{2})$/.exec(u);
      if (cxrFilter) {
        if (cxrFilter[1] === 'YY') return rerun(cont.date, cont.origin, cont.destination);
        return rerun(cont.date, cont.origin, cont.destination, cxrFilter[1]);
      }
      const ret = /^A\/R(\d{1,2}[A-Z]{3})?$/.exec(u);
      if (ret) return rerun(ret[1] ?? cont.date, cont.destination, cont.origin);
      const chgDst = /^A@A([A-Z]{3})$/.exec(u);
      if (chgDst) return rerun(cont.date, cont.origin, chgDst[1]);
      const chgOrg = /^A@D([A-Z]{3})$/.exec(u);
      if (chgOrg) return rerun(cont.date, chgOrg[1], cont.destination);
    }

    const translated = translateWorldspanToGalileo(raw);
    // Encode/decode family — handled pre-parse (the shared renderer
    // lives outside the Galileo parser's entry union).
    const edm = /^\.(C|A)(D|E) (.+)$/.exec(translated.trim().toUpperCase());
    if (edm) return renderEncodeDecode(edm[1] as 'C' | 'A', edm[2] as 'D' | 'E', edm[3]);
    let entry;
    try {
      entry = parseGalileoEntry(translated);
    } catch (err) {
      if (err instanceof ParseError) return GalileoResponse.FORMAT;
      throw err;
    }
    const segsBefore = wa.pnr.segments.length;
    const result = dispatchGalileo(entry, wa, ctx);
    // Native sold-segment response (calibration arc commit 4) —
    // verbatim line shape from the Go! Res manual p.31:
    //   1 IB6842Y 20MAY EZEMAD SS1     1310   0510 /O $   E
    //   1 DL 100Y 10SEP SA EZEATL SS1    2145   0655 #1/O $ E
    // (segment number, carrier+flight+class concatenated, date,
    // 2-letter DOW, concatenated city pair, status+seats, 24h
    // times, #1 next-day, the /O marker, participation mark, E.)
    // Native PNR display (calibration arc commit 5) — verbatim
    // layout from the Go! Res manual's ER/IR walkthrough (p.45):
    //   1P- 7UMAHZ
    //    1.1MAC.DERMOTT/LUCAS*ADT
    //    1 AR1130N 10MAR FR EZEMAD HK1 1500 0640 #1/O $ E
    //   P- 1.TQ3 54 11 4320-1111-T/...
    //   T- 1.TAW/00/13AUG
    //   G- 1.OSI YY ...
    //   **** ITEMS SUPPRESSED ****/ML
    // Rendered for retrieves (*<locator>, *-<name>, *R) and for
    // ER/IR once a locator exists ("the PNR is retrieved on screen"
    // per the manual). The *DR acknowledgment display is deferred
    // (needs airline-locator synthesis).
    const isRetrieve = entry.kind === 'display' && /^\*(?:[A-Z0-9]{6}|-|R$)/.test(translated);
    const isEndRetrieve = entry.kind === 'end_transaction' && (u === 'ER' || u === 'IR');
    if (isRetrieve || isEndRetrieve) {
      return Promise.resolve(result).then((r) => {
        if (this.isErrorResponse(r)) return r;
        let pnr = wa.pnr;
        if (pnr.names.length === 0 && pnr.segments.length === 0) {
          // ER commits + resets the work area — recover the
          // committed PNR through the locator that opens Galileo's
          // response (`<locator>  <pcc>/<agent>`).
          if (!isEndRetrieve) return r;
          const loc = /^([A-Z0-9]{6})\b/.exec(r);
          const found = loc && ctx.backend.pnrs.get(loc[1]);
          if (!found) return r;
          pnr = found;
        }
        return renderWorldspanPnr(pnr);
      });
    }

    if (entry.kind === 'sell') {
      return Promise.resolve(result).then((r) => {
        if (this.isErrorResponse(r) || wa.pnr.segments.length <= segsBefore) return r;
        return wa.pnr.segments
          .slice(segsBefore)
          .map((seg) => renderWorldspanSoldSegment(seg))
          .join('\n');
      });
    }
    // Native availability render (Worldspan-native-calibration arc,
    // commit 1): availability requests still dispatch through
    // Galileo so wa.lastAvailability is populated (keeping the
    // sell-from-display semantics), but the SCREEN is the Go! Res
    // manual's verbatim layout, not Galileo's.
    if (entry.kind === 'availability' && wa.lastAvailability && wa.lastAvailability.lines.length > 0) {
      return Promise.resolve(result).then((r) =>
        this.isErrorResponse(r) ? r : renderWorldspanAvailability(wa.lastAvailability!),
      );
    }
    return result;
  }

  isErrorResponse(response: string): boolean {
    return ERROR_RESPONSES.has(response);
  }
}
