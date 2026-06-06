import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { ApolloDialect, translateApolloToGalileo } from '../../src/dialects/apollo/index.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';

describe('Apollo dialect — identity', () => {
  it('exposes the 1V identity strings', () => {
    const d = new ApolloDialect();
    expect(d.id).toBe('apollo');
    expect(d.displayName).toBe('Apollo (1V)');
    expect(d.screenName).toBe('APOLLO 1V');
    expect(d.bannerText).toContain('Apollo (1V)');
  });

  it('flags chain-halting errors the same way Galileo does (shared dispatch)', () => {
    const d = new ApolloDialect();
    expect(d.isErrorResponse('FORMAT')).toBe(true);
    expect(d.isErrorResponse('NOT IMPLEMENTED — galileo dialect')).toBe(true);
    expect(d.isErrorResponse('HA SIGNED ON AT 7K9S')).toBe(false);
  });
});

describe('translateApolloToGalileo — three known syntactic deltas', () => {
  it('reference sell: 01Y1 → N1Y1', () => {
    expect(translateApolloToGalileo('01Y1')).toBe('N1Y1');
  });

  it('reference sell multi-class: 03C2Y3 → N3C2Y3', () => {
    expect(translateApolloToGalileo('03C2Y3')).toBe('N3C2Y3');
  });

  it('direct sell (0<carrier>) passes through unchanged — same in both dialects', () => {
    // Apollo Comparison Guide p.22: direct sell `0AY631C11JULHELARNN1`
    // is identical between Apollo and Galileo. The Apollo→Galileo
    // translator must NOT rewrite the leading 0 here.
    expect(translateApolloToGalileo('0AY631C11JULHELARNN1')).toBe('0AY631C11JULHELARNN1');
  });

  it('segment status: .1HK → @1HK', () => {
    expect(translateApolloToGalileo('.1HK')).toBe('@1HK');
  });

  it('segment status with multi-digit segment: .12HK → @12HK', () => {
    expect(translateApolloToGalileo('.12HK')).toBe('@12HK');
  });

  it('availability carrier qualifier: A23JULFRAROM+LH → A23JULFRAROM/LH', () => {
    expect(translateApolloToGalileo('A23JULFRAROM+LH')).toBe('A23JULFRAROM/LH');
  });

  it('non-availability `+` passes through (chain separator)', () => {
    // `+` outside availability context (e.g. queue chain) stays as-is.
    // The splitChain step handles chains; the translator only rewrites
    // a `+<carrier>` pattern at the END of an availability entry.
    expect(translateApolloToGalileo('QEB/35+40')).toBe('QEB/35+40');
  });

  it('unknown / non-Apollo-specific entries pass through unchanged', () => {
    expect(translateApolloToGalileo('SON/ZHA')).toBe('SON/ZHA');
    expect(translateApolloToGalileo('SOF')).toBe('SOF');
    expect(translateApolloToGalileo('*ABC123')).toBe('*ABC123');
    expect(translateApolloToGalileo('XI')).toBe('XI');
    expect(translateApolloToGalileo('N.SMITH/JOHN MR')).toBe('N.SMITH/JOHN MR');
  });
});

describe('Apollo dialect — end-to-end via host', () => {
  it('SON/Z<usercode> signs on (delegates to Galileo dispatch)', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: '7K9S',
    });
    const wa = host.newWorkArea();
    const resp = await host.process('SON/ZHA', wa);
    expect(resp).toContain('SIGNED ON');
    expect(resp).toContain('7K9S');
  });

  it('Apollo reference sell .1Y1 works via translation to Galileo N1Y1', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: '7K9S',
    });
    const wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
    await host.process('A15JUNJFKLAX', wa);
    // Apollo cryptic — host translates to Galileo's N1Y1 internally.
    const resp = await host.process('01Y1', wa);
    expect(resp).not.toContain('FORMAT');
    expect(wa.pnr.segments.length).toBe(1);
  });

  it('Apollo segment-status .1HK works via translation to Galileo @1HK', async () => {
    const host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: '7K9S',
    });
    const wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
    await host.process('A15JUNJFKLAX', wa);
    await host.process('01Y1', wa);
    const resp = await host.process('.1HK', wa);
    // Galileo's @1HK handler returns the rendered itinerary on success.
    expect(resp).not.toContain('FORMAT');
    expect(wa.pnr.segments[0]?.status).toBe('HK');
  });

  it('Apollo and Galileo produce identical responses for shared verbs', async () => {
    // Smoke-test the dialect-equivalence claim: anything that passes
    // through the translator unchanged should behave identically.
    const apolloHost = new GdsHost({
      port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: '7K9S',
    });
    const galileoHost = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S',
    });
    const apolloWa = apolloHost.newWorkArea();
    const galileoWa = galileoHost.newWorkArea();
    for (const entry of ['SON/ZHA', 'A15JUNJFKLAX']) {
      const a = await apolloHost.process(entry, apolloWa);
      const g = await galileoHost.process(entry, galileoWa);
      expect(a).toBe(g);
    }
  });
});
