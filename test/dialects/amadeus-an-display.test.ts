/**
 * Chunk 33 — AN availability display calibrated to the VERBATIM
 * layout from Service Hub solution 897281 ("How to understand air
 * availability display (AN)"):
 *
 *   ** AMADEUS AVAILABILITY - AN ** NCE COTE D AZUR.FR 110MO 10JUN 0000
 *    2 6X 083   P9 F9 A1 J9 C9 D9 Z4 /SFO I CDG2C 620P 155P+1E0/744
 *      7X7706   C9 D9 Y9 S9 K9 H9 T9 /CDG2D NCE 2 345P+1 520P+1E0/320 14:00
 *
 * Verbatim-pinned: banner, destination display name (format; the
 * names for our seeded airports are reconstructed), <days-out><DOW>,
 * date + 0000 time, class-status pairs capped at 9 ("9 or more"),
 * /origin+terminal dest+terminal route block (terminal codes
 * synthetic), +1 overnight marker, E0/<equipment> hard against the
 * arrival time, unnumbered continuation legs, elapsed H:MM on the
 * last connection leg. Not modeled (documented in the renderer):
 * waitlist/request/closed status letters, codeshare prefixes,
 * flight-irregularity codes.
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

function makeHost() {
  return new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC' });
}

async function signedIn(h: GdsHost) {
  const wa = h.newWorkArea();
  await h.process('JI2345HA/GS', wa);
  return wa;
}

describe('AN header (verbatim banner + days-out/DOW + date + time)', () => {
  it('renders the banner, destination display name, and date block', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('AN15JULJFKLAX', wa);
    const header = resp.split('\n')[0];
    expect(header).toMatch(
      /^\*\* AMADEUS AVAILABILITY - AN \*\* LAX LOS ANGELES INTL\.USCA \d{1,3}(SU|MO|TU|WE|TH|FR|SA) 15JUL 0000$/,
    );
  });

  it('days-out and weekday agree with the calendar', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('AN15JULJFKLAX', wa);
    const m = /(\d{1,3})(SU|MO|TU|WE|TH|FR|SA) 15JUL/.exec(resp)!;
    const daysOut = parseInt(m[1], 10);
    const target = new Date();
    target.setUTCDate(target.getUTCDate() + daysOut);
    expect(target.getUTCDate()).toBe(15);
    expect(target.getUTCMonth()).toBe(6); // July
    const dows = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    expect(m[2]).toBe(dows[target.getUTCDay()]);
  });
});

describe('AN lines (verbatim shape)', () => {
  it('nonstop: number, carrier+flight, classes, /route with terminals, times, E0/equip', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('AN15JULJFKLAX', wa);
    // " 1 B6 615   Y9 B9 M9 /JFK 4 LAXB 700A 1015AE0/32A"
    expect(resp).toMatch(/ 1 B6 615 {3}Y9 B9 M9 \/JFK 4 LAXB \d{1,4}A \d{1,4}AE0\/32A/);
  });

  it('seat counts cap at 9 — "9 or more seats available"', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('AN15JULJFKLAX', wa);
    expect(resp).not.toMatch(/[A-Z]\d{2}/); // no two-digit counts
  });

  it('overnight legs carry the +1 marker hard against E0', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('AN15JANHELBKK', wa);
    expect(resp).toContain('450P 735A+1E0/359');
  });

  it('connections: continuation leg unnumbered, elapsed H:MM on the last leg only', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    const resp = await h.process('AN27JUNDENFRA', wa);
    const lines = resp.split('\n');
    const first = lines.find((l) => l.includes('FI 670'))!;
    const second = lines.find((l) => l.includes('FI 520'))!;
    expect(first).toMatch(/^ 1 FI 670/);
    expect(second).toMatch(/^ {3}FI +520/); // no line number
    expect(first).not.toMatch(/\d{1,2}:\d{2}$/); // no elapsed on leg 1
    expect(second).toMatch(/ \d{1,2}:\d{2}$/); // elapsed on the last leg
  });

  it('sell from the new display still resolves line numbers', async () => {
    const h = makeHost();
    const wa = await signedIn(h);
    await h.process('AN15JULJFKLAX', wa);
    const sell = await h.process('SS1Y2', wa);
    expect(sell).toContain('AA 100');
    expect(wa.pnr.segments).toHaveLength(1);
  });
});
