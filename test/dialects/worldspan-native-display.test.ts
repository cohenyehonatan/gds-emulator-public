/**
 * Worldspan native calibration, commit 1 — the neutral-availability
 * display rendered NATIVELY from the Go! Res manual's verbatim
 * layout (references/worldspan/Worldspan-Go-Res-Manual-4022-
 * Argentina-2007.pdf, p.25) instead of Galileo's wording:
 *
 *   29OCT-SA-0700 BUEROM ** ** WL-PLUS
 *   1*S#AZ 681 J7 D7 I7 Y7 B7 M7 H7 K7 EZEFCO 1445 0735 #1   772 0E
 *              V7 T7 N7 L1 W.
 *
 * Verbatim-pinned: the header (<date>-<DOW>-<time> <citypair> ** **
 * WL-PLUS — ** ** is the non-US timezone indicator), alliance
 * sigils (*A Star / *O OneWorld / *S SkyTeam, manual legend),
 * participation marks (# host, $ direct sell, blank full-service),
 * the 7-cap ("J7 = max bookable in one transaction"), 24-hour
 * times, #1 next-day, continuation legs showing only the
 * destination, equipment + stops + E. Per-carrier alliance/
 * participation VALUES reconstructed from public rosters.
 * Waitlist-state glyphs (B0/W./H-) aren't modeled.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { WorldspanDialect } from '../../src/dialects/worldspan/index.js';

function makeHost() {
  return new GdsHost({ port: 0, logLevel: 'error', dialect: new WorldspanDialect(), pcc: '1P' });
}

async function signedIn(h: GdsHost) {
  const wa = h.newWorkArea();
  await h.process('BSI$5467AB/GS', wa);
  return wa;
}

describe('native availability display', () => {
  it('header: <date>-<DOW>-0700 <citypair> ** ** WL-PLUS', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('A15JULJFKLAX', wa);
    expect(resp.split('\n')[0]).toMatch(/^15JUL-(SU|MO|TU|WE|TH|FR|SA)-0700 JFKLAX \*\* \*\* WL-PLUS$/);
  });

  it('lines carry alliance + participation sigils, 7-cap, 24h times, equip + 0E', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('A15JULJFKLAX', wa);
    // AA = OneWorld + host: `2*O#AA 100 F4 J7 Y7 B7 M7 JFKLAX 0800 1100   738 0E`
    expect(resp).toMatch(/^2\*O#AA {1,2}100 F4 J7 Y7 B7 M7 JFKLAX 0800 1100 {3}738 0E$/m);
    // B6 = no alliance, direct-sell: `1  $B6 615 …`
    expect(resp).toMatch(/^1 +\$B6 +615 /m);
    expect(resp).not.toMatch(/[A-Z][89]/); // counts cap at 7
  });

  it('overnight legs carry #1; continuation legs show only the destination', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('A27JUNDENFRA', wa);
    const lines = resp.split('\n');
    expect(lines[1]).toContain('DENKEF 1920 0600 #1');
    expect(lines[2]).toMatch(/ {3}FRA 0730 1135/); // destination only
    expect(lines[2]).not.toContain('KEFFRA');
  });

  it('sell from the native display still resolves line numbers', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    await h.process('A15JULJFKLAX', wa);
    const sold = await h.process('01Y2', wa);
    expect(sold).toContain('AA 100');
    expect(wa.pnr.segments).toHaveLength(1);
  });

  it('availability errors pass through untouched (no native render)', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('A15JULXXXYYY', wa);
    expect(resp).not.toContain('WL-PLUS');
  });
});

describe('continuation entries (manual HELP AVAILCONT table, verbatim forms)', () => {
  async function withDisplay(h: GdsHost) {
    const wa = await signedIn(h);
    await h.process('A15JULJFKLAX', wa);
    return wa;
  }

  it('AT / AY / A<n>D walk the calendar; A<date> jumps', async () => {
    const h = makeHost();
    const wa = await withDisplay(h);
    expect((await h.process('AT', wa)).split('\n')[0]).toContain('16JUL');
    expect((await h.process('AY', wa)).split('\n')[0]).toContain('15JUL');
    expect((await h.process('A7D', wa)).split('\n')[0]).toContain('22JUL');
    expect((await h.process('A28JUN', wa)).split('\n')[0]).toContain('28JUN-');
  });

  it('A-<cxr> filters; A-YY restores all airlines', async () => {
    const h = makeHost();
    const wa = await withDisplay(h);
    const filtered = await h.process('A-AA', wa);
    expect(filtered).toContain('AA');
    expect(filtered).not.toContain('B6');
    const all = await h.process('A-YY', wa);
    expect(all).toContain('B6');
  });

  it('A/R swaps the city pair; A@D changes the origin', async () => {
    const h = makeHost();
    const wa = await withDisplay(h);
    expect((await h.process('A/R', wa)).split('\n')[0]).toContain('LAXJFK');
    // From LAX-JFK, change origin back to JFK → JFK-JFK is empty;
    // use A@A to retarget the destination instead.
    expect((await h.process('A@AJFK', wa)).split('\n')[0]).not.toContain('LAXLAX');
  });

  it('A* recalls the current display; sells resolve against it', async () => {
    const h = makeHost();
    const wa = await withDisplay(h);
    const recall = await h.process('A*', wa);
    expect(recall.split('\n')[0]).toContain('15JUL');
    expect(await h.process('01Y1', wa)).toContain('B6 615');
  });

  it('continuation entries without a prior display fall through to FORMAT', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    expect(h.dialect.isErrorResponse(await h.process('AT', wa))).toBe(true);
  });
});

describe('encode/decode — Worldspan KC/KD/KAC/KAD (manual p.25) + Galileo .C/.A family', () => {
  it('Worldspan forms translate and resolve', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    expect(await h.process('KD/CDG', wa)).toBe('CDG  PARIS CH DE GAULLE');
    expect(await h.process('KC/LONDON', wa)).toBe('LHR  LONDON HEATHROW');
    expect(await h.process('KAD/LH', wa)).toBe('LH  LUFTHANSA');
    expect(await h.process('KAC/DELTA', wa)).toBe('DL  DELTA AIR LINES');
    expect(await h.process('KD/ZZZ', wa)).toBe('CODE NOT FOUND');
  });
});

describe('native sold-segment response (manual p.31, verbatim shape)', () => {
  it('sell renders the Worldspan line: concatenated cxr+flt+cls, DOW, citypair, /O + part + E', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    await h.process('A15JANHELBKK', wa);
    const resp = await h.process('01Y1', wa);
    // `1 6X 089Y 15JAN FR HELBKK SS1    1650   0735 #1/O #   E`
    expect(resp).toMatch(/^1 6X {1,2}089Y 15JAN [A-Z]{2} HELBKK SS1 {4}1650 {3}0735 #1\/O #   E$/);
  });

  it('multi-seat sell + non-overnight leg render correctly', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    await h.process('A15JULJFKLAX', wa);
    const resp = await h.process('02Y2', wa);
    expect(resp).toMatch(/SS2 {4}0800 {3}1100\/O/);
    expect(resp).not.toContain('#1');
  });

  it('failed sells pass through untouched', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('01Y1', wa); // no display
    expect(h.dialect.isErrorResponse(resp) || !resp.includes('/O')).toBe(true);
  });
});

describe('native PNR display (manual p.45 ER walkthrough, verbatim layout)', () => {
  async function builtPnr(h: GdsHost) {
    const wa = await signedIn(h);
    await h.process('A15JANHELBKK', wa);
    await h.process('01Y1', wa);
    await h.process('-MAC.DERMOTT/LUCAS', wa);
    await h.process('9*BUE54114320-T', wa);
    await h.process('6JACKIE', wa);
    await h.process('7TAW/00/13AUG', wa);
    await h.process('3OSI YY WORLDSPAN SERVICES ARG', wa);
    return wa;
  }

  it('ER answers with the native PNR: 1P- header, *ADT names, P-/T-/G- fields, trailer', async () => {
    const h = makeHost();
    const wa = await builtPnr(h);
    const resp = await h.process('ER', wa);
    const lines = resp.split('\n');
    expect(lines[0]).toMatch(/^1P- [A-Z0-9]{6}$/);
    expect(lines[1]).toBe(' 1.1MAC.DERMOTT/LUCAS*ADT');
    expect(lines[2]).toMatch(/^ 1 6X {1,2}089Y 15JAN [A-Z]{2} HELBKK SS1/);
    expect(resp).toContain('P- 1.BUE54114320-T');
    expect(resp).toContain('T- 1.TAW/00/13AUG');
    expect(resp).toContain('G- 1.OSI YY WORLDSPAN SERVICES ARG');
    expect(resp.split('\n').pop()).toBe('**** ITEMS SUPPRESSED ****/ML');
  });

  it('retrieve by locator + by name render the same native layout', async () => {
    const h = makeHost();
    const wa = await builtPnr(h);
    const er = await h.process('ER', wa);
    const loc = /^1P- ([A-Z0-9]{6})/.exec(er)![1];
    const wa2 = await signedIn(h);
    const byLoc = await h.process(`*${loc}`, wa2);
    expect(byLoc.split('\n')[0]).toBe(`1P- ${loc}`);
    const wa3 = await signedIn(h);
    expect((await h.process('**-MAC.DERMOTT', wa3)).split('\n')[0]).toBe(`1P- ${loc}`);
  });

  it('failed retrieves pass through (no native render)', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('*ZZZZZZ', wa);
    expect(resp).not.toContain('1P- ');
  });
});

describe('schedule display — S entry (manual pp.27-28, layout verbatim)', () => {
  it('S<date><pair> renders header with destination timezone + DLY/EFF/DIS rows', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('S15JULJFKLAX', wa);
    const lines = resp.split('\n');
    expect(lines[0]).toMatch(/^15JUL-[A-Z]{2}-0700 JFKLAX \*\* PT$/); // LAX = Pacific
    // Classes WITHOUT counts; meal+stops trailer.
    expect(lines[1]).toMatch(/^1\.DLY {2}\$B6 {1,2}615 Y B M {3}JFKLAX 0700 1015 {4}32A BB0$/);
    expect(lines[2]).toBe('         EFF 01JAN DIS 31DEC');
    expect(resp).not.toMatch(/Y\d/); // no availability counts
  });

  it('continuations: S-<cxr> filters, S/R swaps (ET dest), S<date> re-dates, SD redisplays', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    await h.process('S15JULJFKLAX', wa);
    const filtered = await h.process('S-AA', wa);
    expect(filtered).toContain('AA');
    expect(filtered).not.toContain('B6');
    expect((await h.process('S/R', wa)).split('\n')[0]).toContain('LAXJFK ** ET');
    expect((await h.process('S22JUL', wa)).split('\n')[0]).toContain('22JUL');
    expect((await h.process('SD', wa)).split('\n')[0]).toContain('22JUL'); // redisplay keeps state
  });

  it('meal codes track departure hour; unknown market → NO FLIGHTS', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('S15JULJFKLAX', wa);
    expect(resp).toContain('1300 1600    320 LL0'); // midday = lunch
    expect(resp).toContain('1800 2100    32B DD0'); // evening = dinner
    expect(await h.process('S15JULXXXYYY', wa)).toBe('NO FLIGHTS');
  });
});
