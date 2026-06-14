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
      'OP/W*               all-areas status display',
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
      'N<seats><class><line>*     connection sell — line + its legs',
      '  (connections display as consecutive lines; on LIVE the',
      '   offer is the booking unit, so any leg sells the journey)',
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
    lines: [
      'QEB/<n>             place BF on queue + end transaction',
      '  QEB/<n>+<n>       multi-queue   QEB/<PCC>/<n>  branch PCC',
      '  QEB/<n>*C<cat>*D<n>  with category / date-range qualifiers',
      'Q/<n>               sign into queue (loads first BF)',
      'QP / QPI            cursor back 1 / back 1 ignoring changes',
      'I                   ignore current BF, load next',
      'QR / QR/<n>[+<n>]   remove on-screen BF from queue(s)',
      'QRQ/ALL             remove from ALL agency queues',
      'QX / QXI / QXE      exit queue / exit+ignore / exit+end',
      'QXIR / QXER         same, then redisplay the BF',
      'QCA / QCA*<n>       count queues with BFs / list queue <n>',
      'QW                  which queues hold the on-screen BF',
      'QPB*                queue titles',
    ],
  },
  {
    keys: ['HOTELS', 'HOA', 'HOI', '0HTL'],
    title: 'HOTELS',
    lines: [
      'HOA<d1>-<d2><city><adults>   availability (3-letter city/airport code)',
      'HOA<d1>-<d2>/GEO-<lat>,<lng> availability by lat/long (live; no-IATA towns)',
      'HOI<city>[/<chain>]          index',
      'HOC<line>                    complete availability (all rates; live = rate detail)',
      'N<rooms>A<line>D<days>       sell from display (live: HOC rate line;',
      '                             books on a name N. + card F.; confirms at once)',
      '0HTL<chain><status><rooms><city><in>-OUT<out>[/H-<name>/P-<id>/R-<rate>]',
      '                             direct sell (no avail; status MK passive/HK active)',
    ],
  },
  {
    keys: ['CARS', 'CAL', 'CAI', 'CA', '0CCR'],
    title: 'CARS',
    lines: [
      'CAL<d1>-<d2><city>         availability',
      'CAI<city>                  vendor index',
      'N1A<line>                  sell from display',
      '0CCR<vendor><status><count><city><pu>-<do><type>[/RC-<rate>]',
      '                           direct sell (no avail; status MK passive/HK active)',
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
    keys: ['INTERFACE', 'MIR', 'HQC'],
    title: 'BACK-OFFICE INTERFACE (MIR)',
    lines: [
      'HMLM<lniata>DA      establish link to the MIR device',
      'HMLD                link status (U up / D down)',
      'HQC                 queue counts (Pending / Sent)',
      'HMOM<lniata>-U/-D   bring link up (transmits) / down',
      '(MIRs generate at TKP; files land in GDS_INTERFACE_DIR)',
    ],
  },
  {
    keys: ['BFD', 'DISPLAY'],
    title: 'BOOKING FILE DISPLAY (*<FIELD>)',
    lines: [
      '*R / *ALL           whole BF / all data incl hidden fields',
      '*I  *IA *IH *IC *IN itinerary — all / air / hotel / car / non-air',
      '*N *P *TD *RV       names / phones / ticketing / received',
      '*SI *SR *SO         service info — both / SSRs / OSIs',
      '*FF *FOP *MM *SD    fares / FOP / mileage membership / seats',
      '*NP *CD *SVC[n]     notepad / customer data / in-flight svc',
      '*N.I  *N.SI.VR      combinations    *N.I+*HIA.SI  + history',
      '*TE<n> *TEL *TEH    eticket record / relist / history',
      '*TE/<cxr>/FF<n> /CC<n> /<date><brd><off>-<name>   selectors',
      'F.S F.CK F.INV… F.<card>/D<MMYY>   FOP field (F.@ change/del)',
    ],
  },
  {
    keys: ['DIH', 'HIST', 'HISTORY'],
    title: 'BF HISTORY (*H FAMILY)',
    lines: [
      '*H                  entire history (coded rows: AN AS XS AG…)',
      '*HI *HIA *HIH *HIC  itinerary history — all/air/hotel/car',
      '*HN *HP *HMM        name / phone / mileage history',
      '*HSR *HSO *HSI      SSR / OSI / both',
      '*HTD *HQT           ticketing / queue trail',
      '*HFF *HNP           filed fares / notepads',
      '(codes per the in-tree H/HIST table — H/BFD for displays)',
    ],
  },
  {
    keys: ['PRINT', 'P', 'HQ'],
    title: 'PRINT FUNCTIONS (P- / HQ*)',
    lines: [
      'P-<display>            print any display (P-*R, P-*I, P-*H)',
      'P-*<locator> / P-*-<name>   print unretrieved BF',
      'HQC<gtid>              printer queue count (SET ADDRESS…)',
      'HQD<gtid> / HQX<gtid>  queue contents / delete',
      'HQS<gtid>              restart — flushes held ticket image',
      '(TKP holds the ticket image; jobs land in GDS_PRINT_DIR)',
    ],
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
    lines.push('  STORE    PNR PERSISTENCE — what survives a restart');
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
