/**
 * In-terminal help across the dialects that document a cryptic help
 * verb. Entry forms are source-verbatim:
 *
 *   Galileo:   H/ · H/<topic> · HELP · HELP <topic>   (Comparison
 *              Guide "Help entry" rows: H/SON, H/AVAIL, H/QUEUE…)
 *   Apollo:    HELP <topic> (guide's Apollo column: HELP CA, HELP
 *              HOI…) — Galileo content + an Apollo-deltas footer
 *   Worldspan: HELP · HELP <topic> · INFO <topic> (guide: HELP,
 *              HELP A, HELP FARES, INFO FARES) — native forms from
 *              the translator table
 *   Amadeus:   HE · HE <code> · HELP (QRG intro: "enter HE followed
 *              by the relevant transaction code")
 *   Sabre:     deliberately NONE — both first-party courses point at
 *              the Format Finder web system; no cryptic form is
 *              documented.
 *
 * CONTENT is emulator-native (the real host help screens aren't
 * public) — every screen carries a banner saying so, and each topic
 * lists the verb surface this emulator implements.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { ApolloDialect } from '../../src/dialects/apollo/index.js';
import { WorldspanDialect } from '../../src/dialects/worldspan/index.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

const BANNER = 'EMULATOR HELP';

describe('Galileo H/ + HELP', () => {
  const host = () => new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });

  it('H/ and HELP render the banner + topic index', async () => {
    const h = host();
    for (const entry of ['H/', 'HELP']) {
      const resp = await h.process(entry, h.newWorkArea());
      expect(resp).toContain(BANNER);
      expect(resp).toContain('AVAIL');
      expect(resp).toContain('QUEUE');
    }
  });

  it('topic help shows the implemented forms (H/AVAIL, HELP S., H/QUEUE)', async () => {
    const h = host();
    expect(await h.process('H/AVAIL', h.newWorkArea())).toContain('A<date><org><dst>');
    expect(await h.process('HELP S.', h.newWorkArea())).toContain('ADVANCE SEAT REQUESTS');
    expect(await h.process('H/QUEUE', h.newWorkArea())).toContain('QEB/<n>');
  });

  it('H/QUEUE covers the full queue-mode surface, not just place/access', async () => {
    const h = host();
    const resp = await h.process('H/QUEUE', h.newWorkArea());
    for (const verb of ['QP / QPI', 'I ', 'QRQ/ALL', 'QX / QXI / QXE', 'QXIR / QXER', 'QCA', 'QW', 'QPB*']) {
      expect(resp, verb).toContain(verb);
    }
  });

  it('H/SELL documents the connection-star form (the N1N27/N1N28 trap)', async () => {
    const h = host();
    const resp = await h.process('H/SELL', h.newWorkArea());
    expect(resp).toContain('N<seats><class><line>*');
    expect(resp).toContain('connection sell');
  });

  it('H/PRINT documents the P- router and HQ* queue family', async () => {
    const h = host();
    const resp = await h.process('H/PRINT', h.newWorkArea());
    expect(resp).toContain('P-<display>');
    expect(resp).toContain('HQS<gtid>');
  });

  it('H/BFD and H/DIH document the display + history families (guide help entries)', async () => {
    const h = host();
    const bfd = await h.process('H/BFD', h.newWorkArea());
    expect(bfd).toContain('*SVC[n]');
    expect(bfd).toContain('*N.I+*HIA.SI');
    const dih = await h.process('H/DIH', h.newWorkArea());
    expect(dih).toContain('*HQT');
    expect(dih).toContain('*HIA');
  });

  it('chapter-prefix listing per the guide (H/A → topics starting with A)', async () => {
    const h = host();
    const resp = await h.process('H/A', h.newWorkArea());
    expect(resp).toContain('AVAILABILITY');
  });

  it('unknown topic points back at the index', async () => {
    const h = host();
    expect(await h.process('H/ZZZZ', h.newWorkArea())).toContain('NO HELP FOR ZZZZ');
  });
});

describe('Apollo HELP — Galileo content + deltas footer', () => {
  it('HELP SELL carries the Apollo-deltas line', async () => {
    const h = new GdsHost({ port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: 'AB' });
    const resp = await h.process('HELP SELL', h.newWorkArea());
    expect(resp).toContain(BANNER);
    expect(resp).toContain('APOLLO DELTAS');
    expect(resp).toContain('9V/S<n>');
  });
});

describe('Worldspan HELP / INFO — native forms', () => {
  const host = () => new GdsHost({ port: 0, logLevel: 'error', dialect: new WorldspanDialect(), pcc: '1P' });

  it('HELP renders the Worldspan-native topic index', async () => {
    const h = host();
    const resp = await h.process('HELP', h.newWorkArea());
    expect(resp).toContain('Worldspan forms');
  });

  it('HELP SEATS shows the 4R sigil forms, not Galileo S.', async () => {
    const h = host();
    const resp = await h.process('HELP SEATS', h.newWorkArea());
    expect(resp).toContain('4RS<seg>$<seat>');
    expect(resp).not.toContain('S.S<n>');
  });

  it('INFO FARES (the guide form) resolves', async () => {
    const h = host();
    expect(await h.process('INFO FARES', h.newWorkArea())).toContain('FARES / PRICING');
  });
});

describe('Amadeus HE', () => {
  const host = () => new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC' });

  it('HE and HELP render the topic index', async () => {
    const h = host();
    for (const entry of ['HE', 'HELP']) {
      expect(await h.process(entry, h.newWorkArea())).toContain(BANNER);
    }
  });

  it('HE FF shows the frequent-flyer family; HESM (no space) works', async () => {
    const h = host();
    expect(await h.process('HE FF', h.newWorkArea())).toContain('FFA<cxr>-<num>');
    expect(await h.process('HESM', h.newWorkArea())).toContain('SEAT MAPS');
  });

  it('unknown code points back at the index', async () => {
    const h = host();
    expect(await h.process('HE ZZZ', h.newWorkArea())).toContain('NO HELP FOR ZZZ');
  });
});

describe('Sabre — deliberately no help verb', () => {
  it('HELP is a FORMAT error (Format Finder is the documented help system)', async () => {
    const h = new GdsHost({ port: 0, logLevel: 'error', pcc: 'A0UC' });
    const wa = h.newWorkArea();
    await h.process('SI*', wa);
    const resp = await h.process('HELP', wa);
    expect(h.dialect.isErrorResponse(resp)).toBe(true);
  });
});

describe('Amadeus help-meta family (QRG p.5 "Amadeus Online Help Pages", verbatim forms)', () => {
  const host = () => new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC' });

  async function signedIn(h: GdsHost) {
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    return wa;
  }

  it('HE HE renders help-on-help with the full QRG meta table', async () => {
    const h = host();
    const resp = await h.process('HE HE', h.newWorkArea());
    expect(resp).toContain('AMADEUS ONLINE HELP PAGES');
    expect(resp).toContain('HE/');
    expect(resp).toContain('MP HE');
    expect(resp).toContain('HE STEPS');
  });

  it('HE STEPS renders the step-by-step PNR walkthrough', async () => {
    const h = host();
    const resp = await h.process('HE STEPS', h.newWorkArea());
    expect(resp).toContain('BUILD AND TICKET A PNR');
    expect(resp).toContain('JI2345HA/GS');
    expect(resp).toContain('TTP');
  });

  it('HE/ surfaces help for the last failed entry (manual: after a format error)', async () => {
    const h = host();
    const wa = await signedIn(h);
    await h.process('TTPGARBAGE!!', wa);
    const resp = await h.process('HE/', wa);
    expect(resp).toContain('LAST ENTRY: TTPGARBAGE!!');
    expect(resp).toContain('PRICING / TICKETING'); // TTP prefix inferred
  });

  it('HE/ with no failed entry points at the index', async () => {
    const h = host();
    const wa = await signedIn(h);
    expect(await h.process('HE/', wa)).toContain('NO FAILED ENTRY');
  });

  it('a successful entry does not overwrite the failed-entry memory', async () => {
    const h = host();
    const wa = await signedIn(h);
    await h.process('FFNGARBAGE!!', wa);          // fails
    await h.process('AN15JULJFKLAX', wa);          // succeeds
    const resp = await h.process('HE/', wa);
    expect(resp).toContain('LAST ENTRY: FFNGARBAGE!!');
  });

  it('MPHE redisplays the last help screen; nothing cached → pointer to index', async () => {
    const h = host();
    const wa = await signedIn(h);
    expect(await h.process('MPHE', wa)).toContain('NO HELP SCREEN');
    const first = await h.process('HE FF', wa);
    expect(await h.process('MPHE', wa)).toBe(first);
    expect(await h.process('MP HE', wa)).toBe(first);
  });

  it('HE PNR NAME (multi-word topic, QRG verbatim example) resolves to the NAMES topic', async () => {
    const h = host();
    const resp = await h.process('HE PNR NAME', h.newWorkArea());
    expect(resp).toContain('NAMES');
    expect(resp).toContain('NM<n><sur>');
  });
});

describe('HELP INTERFACE — the back-office pipeline is discoverable', () => {
  it('Galileo H/INTERFACE lists the HM* link-control family', async () => {
    const h = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
    const resp = await h.process('H/INTERFACE', h.newWorkArea());
    expect(resp).toContain('BACK-OFFICE INTERFACE (MIR)');
    expect(resp).toContain('HQC');
    expect(resp).toContain('HMOM');
  });

  it('Amadeus HE INTERFACE lists the B* application-queue family', async () => {
    const h = new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC' });
    const resp = await h.process('HE INTERFACE', h.newWorkArea());
    expect(resp).toContain('BACK-OFFICE INTERFACE (AIR)');
    expect(resp).toContain('BASTART');
    expect(resp).toContain('BR<seq>');
  });
});

describe('Galileo encode/decode — the help table no longer over-claims', () => {
  it('.CD/.CE/.AD/.AE resolve (previously FORMAT despite the H/DECODE listing)', async () => {
    const h = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
    const wa = h.newWorkArea();
    await h.process('SON/ZGS', wa);
    expect(await h.process('.CD JFK', wa)).toBe('JFK  NEW YORK JFK');
    expect(await h.process('.CE LONDON', wa)).toBe('LHR  LONDON HEATHROW');
    expect(await h.process('.AD AA', wa)).toBe('AA  AMERICAN AIRLINES');
    expect((await h.process('.AE AIR', wa)).split('\n').length).toBeGreaterThan(3);
  });
});

describe('HELP MARKETS / HE MARKETS — seeded-inventory discovery', () => {
  it('renders live from the Inventory across all four help-bearing dialects', async () => {
    for (const [dialect, entry, pcc] of [
      [new GalileoDialect(), 'HELP MARKETS', 'AB'],
      [new ApolloDialect(), 'HELP MARKETS', 'AB'],
      [new WorldspanDialect(), 'HELP MARKETS', '1P'],
      [new AmadeusDialect(), 'HE MARKETS', 'A0UC'],
    ] as const) {
      const h = new GdsHost({ port: 0, logLevel: 'error', dialect, pcc });
      const resp = await h.process(entry, h.newWorkArea());
      expect(resp, entry).toContain('AIR (city pair — carriers):');
      expect(resp, entry).toContain('JFK-LAX  AA B6 UA');
      expect(resp, entry).toContain('RAIL:');
    }
  });

  it('the help indexes and AVAIL topics point at MARKETS', async () => {
    const h = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
    expect(await h.process('HELP', h.newWorkArea())).toContain('MARKETS');
    expect(await h.process('H/AVAIL', h.newWorkArea())).toContain('HELP MARKETS');
    const a = new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC' });
    expect(await a.process('HE AN', a.newWorkArea())).toContain('HE MARKETS');
  });
});

describe('HELP MARKETS is backend-aware (the KEF-FRA discrepancy)', () => {
  it('on a LIVE backend it never shows the emulated seed — only observed markets', async () => {
    const { LiveTravelportBackend } = await import('../../src/backends/live-travelport-backend.js');
    const backend = new LiveTravelportBackend(
      { clientId: 'x', clientSecret: 'x', username: 'x', password: 'x' },
    );
    const h = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend });
    const wa = h.newWorkArea();
    const empty = await h.process('HELP MARKETS', wa);
    expect(empty).toContain('LIVE BACKEND — real vendor inventory');
    expect(empty).toContain('(none yet');
    expect(empty).not.toContain('JFK-LAX  AA B6 UA'); // the emulated seed must not leak
    // An availability response teaches the map (recorded passively).
    backend.recordObservedMarket('KEF', 'FRA', ['SK', 'FI', 'LH', 'AY', 'LX']);
    const learned = await h.process('HELP MARKETS', wa);
    expect(learned).toContain('KEF-FRA  AY FI LH LX SK');
    expect(learned).toContain('never probed');
  });

  it('on the emulated backend the seeded summary is unchanged', async () => {
    const h = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
    const resp = await h.process('HELP MARKETS', h.newWorkArea());
    expect(resp).toContain('JFK-LAX  AA B6 UA');
    expect(resp).not.toContain('LIVE BACKEND');
  });
});
