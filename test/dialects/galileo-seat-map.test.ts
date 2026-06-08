import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';

function makeHost(): GdsHost {
  return new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
}

describe('Galileo seat map — SA / SM display family', () => {
  it('SA*S<n> with no PNR returns NO BOOKING FILE', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    expect(await host.process('SA*S1', wa)).toBe('NO BOOKING FILE');
  });

  it('SA*S<n> for an out-of-range segment returns SEGMENT NOT IN ITINERARY', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    await host.process('N1Y1', wa);
    expect(await host.process('SA*S9', wa)).toBe('SEGMENT NOT IN ITINERARY');
  });

  it('SA*S<n> happy path renders Galileo-style header + seat grid', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    await host.process('N1Y1', wa);
    const resp = await host.process('SA*S1', wa);
    // Galileo header: `<carrier><flight>/<class> <date> <citypair>  EQP <eq>`
    expect(resp).toMatch(/^[A-Z0-9]{2}\d+\/Y 15JUL JFKLAX  EQP /);
    expect(resp).toContain('ECONOMY (Y)');
    expect(resp).toContain('LEGEND');
  });

  it('SA*S<n> caches the displayed map on wa.lastSeatMap', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('SA*S1', wa);
    expect(wa.lastSeatMap?.segment).toBe(1);
  });

  it('SA* (refresh) with no cached map returns NO SEAT MAP DISPLAYED', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    expect(await host.process('SA*', wa)).toBe('NO SEAT MAP DISPLAYED');
  });

  it('SA* (refresh) replays the last displayed seat map', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    await host.process('N1Y1', wa);
    const first = await host.process('SA*S1', wa);
    const refresh = await host.process('SA*', wa);
    expect(refresh).toBe(first);
  });

  it('SM*A<line> from cached availability renders the seat map', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    const resp = await host.process('SM*A1', wa);
    expect(resp).toContain('15JUL JFKLAX');
    expect(resp).toContain('LEGEND');
  });

  it('SM*A<line><class> includes the class in the header', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    const resp = await host.process('SM*A1Y', wa);
    expect(resp).toMatch(/\/Y 15JUL/);
  });

  it('SM*A<line> with no prior availability returns NO AVAILABILITY', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    expect(await host.process('SM*A1', wa)).toBe('NO AVAILABILITY');
  });

  it('SM*A<line> with an out-of-range line returns LINE NOT IN AVAILABILITY', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    expect(await host.process('SM*A99', wa)).toBe('LINE NOT IN AVAILABILITY');
  });

  // Traditional-format `;` suffix (chunk 7 deferred follow-up) —
  // Travelport-Asia 2-Day Smartpoint Pro training PDF p.29 documents
  // `SA*S1;` as the way to force Smartpoint's cryptic "traditional
  // format" output (vs the default graphical view). Since our renderer
  // always emits cryptic text, `;` is a no-op alias here.
  it('SA*S<n>; (traditional-format suffix) is byte-equal to SA*S<n>', async () => {
    const host = makeHost();
    async function run(entry: string): Promise<string> {
      const wa = host.newWorkArea();
      await host.process('SON/ZGS', wa);
      await host.process('A15JULJFKLAX', wa);
      await host.process('N1Y1', wa);
      return host.process(entry, wa);
    }
    expect(await run('SA*S1;')).toBe(await run('SA*S1'));
  });

  it('SA*; (refresh + traditional suffix) replays the last seat map', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    await host.process('N1Y1', wa);
    const first = await host.process('SA*S1', wa);
    expect(await host.process('SA*;', wa)).toBe(first);
  });

  it('SM*A<line>; (avail-line + traditional suffix) renders the same as without', async () => {
    const host = makeHost();
    async function run(entry: string): Promise<string> {
      const wa = host.newWorkArea();
      await host.process('SON/ZGS', wa);
      await host.process('A15JULJFKLAX', wa);
      return host.process(entry, wa);
    }
    expect(await run('SM*A1;')).toBe(await run('SM*A1'));
  });
});

describe('Galileo seat-map scrolling — MD/MU/MB/MT (Mini Format Guide v2)', () => {
  function makeHost(): GdsHost {
    return new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
  }

  it('SA*S<n> paginates with a ROWS X-Y OF Z footer + caches cachedSegment', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULDFWLHR', wa);
    await host.process('N1F1', wa); // BA192 777
    const resp = await host.process('SA*S1', wa);
    expect(resp).toMatch(/ROWS 1-\d+ OF \d+/);
    expect(wa.lastSeatMap?.cachedSegment).toBeDefined();
    expect(wa.lastSeatMap?.scrollRow).toBe(0);
  });

  it('MD scrolls down', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULDFWLHR', wa);
    await host.process('N1F1', wa);
    await host.process('SA*S1', wa);
    const resp = await host.process('MD', wa);
    expect(resp).toMatch(/ROWS \d+-\d+ OF \d+/);
    expect(wa.lastSeatMap?.scrollRow).toBeGreaterThan(0);
  });

  it('MU after MD scrolls back to top', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULDFWLHR', wa);
    await host.process('N1F1', wa);
    await host.process('SA*S1', wa);
    await host.process('MD', wa);
    expect(wa.lastSeatMap?.scrollRow).toBeGreaterThan(0);
    await host.process('MU', wa);
    expect(wa.lastSeatMap?.scrollRow).toBe(0);
  });

  it('MB jumps to bottom; MT jumps to top', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULDFWLHR', wa);
    await host.process('N1F1', wa);
    await host.process('SA*S1', wa);
    await host.process('MB', wa);
    expect(wa.lastSeatMap?.scrollRow).toBeGreaterThan(0);
    await host.process('MT', wa);
    expect(wa.lastSeatMap?.scrollRow).toBe(0);
  });

  it('MD/MU/MB/MT with no cached map return NO SEAT MAP DISPLAYED', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    for (const e of ['MD', 'MU', 'MB', 'MT']) {
      expect(await host.process(e, wa)).toBe('NO SEAT MAP DISPLAYED');
    }
  });

  it('Apollo MD/MU work via the Galileo translator (pass-through)', async () => {
    const { ApolloDialect } = await import('../../src/dialects/apollo/index.js');
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: 'AB' });
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULDFWLHR', wa);
    await host.process('01F1', wa);
    await host.process('SA*S1', wa);
    const md = await host.process('MD', wa);
    expect(md).toMatch(/ROWS \d+-\d+ OF \d+/);
  });
});

describe('Apollo seat map — 9V/ proper Apollo cryptic + SA*/SM* Galileo-style fallback', () => {
  it('9V/S<n> is the proper Apollo cryptic per the Comparison Guide', async () => {
    // Verified 2026-06-08 via Travelport+ Format Comparison Guide
    // ("View the seat map for segment 1": Apollo 9V/S1, Galileo SA*S1)
    // + Travelport GWS task documentation ("Terminal Equivalents:
    // Apollo 9V/… Galileo SA*… or SM*…"). Before this commit the
    // chunk 5 implementation only accepted the Galileo verbs under
    // ApolloDialect; real Apollo operators type 9V/S<n>.
    const { ApolloDialect } = await import('../../src/dialects/apollo/index.js');
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: 'AB' });
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    await host.process('01Y1', wa); // Apollo sell — translator rewrites to N1Y1
    const resp = await host.process('9V/S1', wa);
    expect(resp).toContain('15JUL JFKLAX');
    expect(resp).toContain('LEGEND');
  });

  it('9V/S<n> produces the same output as the equivalent SA*S<n>', async () => {
    const { ApolloDialect } = await import('../../src/dialects/apollo/index.js');
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: 'AB' });
    async function run(entry: string): Promise<string> {
      const wa = host.newWorkArea();
      await host.process('SON/ZGS', wa);
      await host.process('A15JULJFKLAX', wa);
      await host.process('01Y1', wa);
      return host.process(entry, wa);
    }
    expect(await run('9V/S1')).toBe(await run('SA*S1'));
  });

  it('SA*S<n> still works under ApolloDialect (Galileo-style fallback)', async () => {
    // Real Apollo operators wouldn't type SA*S<n>, but no reason to
    // reject it — the translator's seat-map rule fires only on
    // ^9V/, so SA*S<n> passes through unchanged.
    const { ApolloDialect } = await import('../../src/dialects/apollo/index.js');
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: 'AB' });
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    await host.process('01Y1', wa);
    const resp = await host.process('SA*S1', wa);
    expect(resp).toContain('15JUL JFKLAX');
    expect(resp).toContain('LEGEND');
  });
});
