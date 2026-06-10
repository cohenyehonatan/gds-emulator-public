/**
 * Galileo in-terminal help — `H/<topic>` / `HELP [<topic>]`.
 *
 * Entry forms are verbatim from the Comparison Guide's "Help entry"
 * rows (`H/SON`, `H/AVAIL`, `H/0`, `H/P.`, `H/QUEUE`, …). The CONTENT
 * is emulator-native: the real Galileo help screens aren't publicly
 * documented, so each topic lists the verb surface this emulator
 * implements — which is exactly what an operator at this terminal
 * needs. The banner on every screen says so.
 *
 * Apollo passes through Galileo's parser but intercepts help in its
 * own dialect to show Apollo-native forms; same for Worldspan. This
 * table is Galileo's own.
 */

interface HelpTopic {
  /** Aliases the topic answers to (uppercased, post-`H/` token). */
  keys: string[];
  title: string;
  lines: string[];
}

const TOPICS: HelpTopic[] = [
  {
    keys: ['SON', 'SOF', 'SIGNON'],
    title: 'SIGN ON / SIGN OFF',
    lines: [
      'SON/Z<agent>        sign on',
      'SOF                 sign off',
      'SA-SE               switch work area',
    ],
  },
  {
    keys: ['AVAIL', 'A'],
    title: 'AVAILABILITY',
    lines: [
      'A<date><org><dst>          city-pair availability',
      '(seeded city pairs: HELP MARKETS)',
      'A<date><org><dst>/<cxr>    carrier-filtered',
      'TTL<n>                     flight details for line n',
    ],
  },
  {
    keys: ['0', 'SELL', 'N'],
    title: 'SELL',
    lines: [
      'N<seats><class><line>      reference sell from availability',
      'N1A<line>[D<days>]         hotel/car sell from aux display',
      '0<cxr><flt><cls><date><citypair><status><seats>   direct sell',
    ],
  },
  {
    keys: ['N.', 'NAME'],
    title: 'NAME FIELD',
    lines: [
      'N.<surname>/<given> <title>    add name',
      'N.P<n>@<new>                   change name n',
      'N.P<n>@                        delete name n',
    ],
  },
  {
    keys: ['P.', 'PHONE'],
    title: 'PHONE FIELD',
    lines: ['P.<text>            add phone', 'P.<n>@<new>         change', 'P.<n>@              delete'],
  },
  {
    keys: ['T.', 'TICKETING'],
    title: 'TICKETING FIELD',
    lines: ['T.TAU/<date>        time limit', 'T.T*                ticketed', 'T.@                 delete'],
  },
  {
    keys: ['R.', 'RECEIVED'],
    title: 'RECEIVED FROM',
    lines: ['R.<name>            add received-from', 'R.@                 delete'],
  },
  {
    keys: ['SI.', 'SSR', 'OSI'],
    title: 'SSR / OSI',
    lines: [
      'SI.<code>                  SSR all pax/segments',
      'SI.P<p>S<s>/<code>         SSR per pax + segment',
      'SI.<cxr>*<text>            OSI',
    ],
  },
  {
    keys: ['S.', 'ASR', 'SEATS'],
    title: 'ADVANCE SEAT REQUESTS',
    lines: [
      'S.<seat|pref>              all pax/segments (10A, NW, NA…)',
      'S.S<n>/<seat>              segment-specific',
      'S.P<n>/<seat>              passenger-specific',
      'S.S<n>@ / S.@              cancel segment / all',
    ],
  },
  {
    keys: ['SM', 'SA*', 'SEATMAP'],
    title: 'SEAT MAPS',
    lines: [
      'SA*S<n>[;][/NW][/<row>]    seat map for segment n',
      'SM*A<line>[<class>]        from availability line',
      'SA*                        refresh   SC*<seat>  characteristics',
      'MD MU MB MT                scroll',
    ],
  },
  {
    keys: ['FQ', 'FARES', 'PRICING'],
    title: 'PRICING',
    lines: ['FQ                  fare quote itinerary', 'TKP                 ticket', 'FQN / FN*<n>        fare notes'],
  },
  {
    keys: ['QUEUE', 'Q'],
    title: 'QUEUES',
    lines: ['QEB/<n>             place BF on queue', 'Q/<n>               access queue', 'QR / QX             remove / exit'],
  },
  {
    keys: ['HOTELS', 'HOA', 'HOI'],
    title: 'HOTELS',
    lines: [
      'HOA<d1>-<d2><city><adults>   availability',
      'HOI<city>[/<chain>]          index',
      'HOC<line>                    complete availability',
      'N<rooms>A<line>D<days>       sell from display',
    ],
  },
  {
    keys: ['CARS', 'CAL', 'CAI', 'CA'],
    title: 'CARS',
    lines: [
      'CAL<d1>-<d2><city>         availability',
      'CAI<city>                  vendor index',
      'N1A<line>                  sell from display',
    ],
  },
  {
    keys: ['CANC', 'X', 'CHAN'],
    title: 'CANCEL / CHANGE',
    lines: [
      'X<n> / XI / XA             cancel segment / itinerary / air',
      '@<n><status>               change segment status',
      '@<sel>/<class>             rebook to class',
    ],
  },
  {
    keys: ['END', 'ER', 'E'],
    title: 'END TRANSACTION',
    lines: ['E / ER              end / end + retrieve', 'I / IR              ignore / ignore + retrieve'],
  },
  {
    keys: ['DECODE', 'ENCODE'],
    title: 'ENCODE / DECODE',
    lines: ['.CD <code> / .CE <name>     city decode / encode', '.AD <code> / .AE <name>     airline'],
  },
];

const BANNER = 'EMULATOR HELP — implemented verb surface (host help screens are not public)';

export function renderGalileoHelp(topic?: string): string {
  if (!topic) {
    const lines = [BANNER, '', 'TOPICS — H/<topic> or HELP <topic>:'];
    for (const t of TOPICS) {
      lines.push(`  ${t.keys[0].padEnd(8)} ${t.title}`);
    }
    lines.push('  MARKETS  SEEDED INVENTORY — what this emulator serves');
    return lines.join('\n');
  }
  const t = TOPICS.find((x) => x.keys.includes(topic));
  if (!t) {
    // Chapter-prefix listing per the guide's "Request help for
    // chapter(s) starting with A — H/A" form.
    const matches = TOPICS.filter((x) => x.keys.some((k) => k.startsWith(topic)));
    if (matches.length > 0) {
      return [BANNER, '', `TOPICS MATCHING ${topic}:`, ...matches.map((m) => `  ${m.keys[0].padEnd(8)} ${m.title}`)].join('\n');
    }
    return `NO HELP FOR ${topic} — H/ FOR THE TOPIC INDEX`;
  }
  return [BANNER, '', t.title, ...t.lines.map((l) => `  ${l}`)].join('\n');
}
