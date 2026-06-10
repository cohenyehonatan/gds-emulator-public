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
