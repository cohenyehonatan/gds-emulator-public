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
});

describe('Apollo seat map — SA/SM via Galileo translator (free pass-through)', () => {
  it('SA*S<n> works under ApolloDialect with no translator change needed', async () => {
    const { ApolloDialect } = await import('../../src/dialects/apollo/index.js');
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: 'AB' });
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    await host.process('01Y1', wa); // Apollo sell — translator rewrites to N1Y1
    const resp = await host.process('SA*S1', wa);
    expect(resp).toContain('15JUL JFKLAX');
    expect(resp).toContain('LEGEND');
  });
});
