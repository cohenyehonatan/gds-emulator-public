/**
 * Work-area switching + status across all five dialects:
 *   Sabre ¤<l> + *S/*S* · Galileo S<A-E> + OP/W* · Apollo passthrough
 *   · Worldspan B<A-E> + B$ · Amadeus JI-area forms/JM/JX/JB/JS/JD/JO.
 * Entry forms source-documented; status layouts reconstructed
 * (renderAreaStatus).
 */

import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { WorldspanDialect } from '../../src/dialects/worldspan/index.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

describe('Amadeus area family (QRG p.9 forms)', () => {
  const host = () => new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC' });

  it('JI* signs into all six areas; JIA/B into a list; JD shows the grid', async () => {
    const h = host();
    const wa = h.newWorkArea();
    expect(await h.process('JI*2345HA/GS', wa)).toBe('HA SIGNED IN - AREAS A/B/C/D/E/F');
    const jd = await h.process('JD', wa);
    expect(jd.split('\n')).toHaveLength(7);
    expect(jd).not.toContain('SIGNED_OFF');
    const h2 = host();
    const wa2 = h2.newWorkArea();
    await h2.process('JIA/C2345HA/GS', wa2);
    const jd2 = await h2.process('JD', wa2);
    expect(jd2).toContain('*A  EMPTY  HA');
    expect(jd2).toContain(' C  EMPTY  HA');
    expect(jd2).toContain(' B  SIGNED_OFF');
  });

  it('JM moves without signing in; JX moves AND signs in; work survives the round-trip', async () => {
    const h = host();
    const wa = h.newWorkArea();
    await h.process('JI2345HA/GS', wa);
    await h.process('AN15JULJFKLAX', wa);
    await h.process('SS1Y1', wa);
    expect(await h.process('JMB', wa)).toBe('WORK AREA B');
    expect(wa.pnr.segments).toHaveLength(0); // B is its own slot
    expect(await h.process('SS1Y1', wa)).toBe('NEEDS AGENT SIGN'); // JM does not sign in
    expect(await h.process('JXC', wa)).toBe('HA SIGNED IN - AREA C');
    expect(await h.process('JMA', wa)).toBe('WORK AREA A');
    expect(wa.pnr.segments).toHaveLength(1); // A's work intact
  });

  it('JMHA resolves by agent sign; JB redisplays; JS acknowledges', async () => {
    const h = host();
    const wa = h.newWorkArea();
    await h.process('JIB2345HA/GS', wa);
    await h.process('JMA', wa); // wander off (A unsigned)
    expect(await h.process('JMHA', wa)).toBe('WORK AREA B');
    expect(await h.process('JB', wa)).toBe('HA SIGNED IN - AREA B');
    expect(await h.process('JS', wa)).toBe('WORK AREA B SUSPENDED');
  });

  it('JOB signs out one area; JO* clears everything including the agent', async () => {
    const h = host();
    const wa = h.newWorkArea();
    await h.process('JI*2345HA/GS', wa);
    expect(await h.process('JOB', wa)).toBe('HA SIGNED OUT - AREA B');
    expect(wa.agent).toBe('HA'); // others still in
    expect(await h.process('JO*', wa)).toBe('HA SIGNED OUT - AREAS A/B/C/D/E/F');
    expect(wa.agent).toBeUndefined();
  });
});

describe('status displays — Sabre *S/*S*, Galileo OP/W*, Worldspan B$', () => {
  it('Sabre *S shows the active area; *S* shows all six', async () => {
    const h = new GdsHost({ port: 0, logLevel: 'error', pcc: 'A0UC' });
    const wa = h.newWorkArea();
    await h.process('SI*', wa);
    expect((await h.process('*S', wa)).split('\n')).toHaveLength(2);
    expect((await h.process('*S*', wa)).split('\n')).toHaveLength(7);
  });

  it('Galileo OP/W* and Worldspan B$ render the grid; switching marks the active row', async () => {
    const g = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
    const gw = g.newWorkArea();
    await g.process('SON/ZGS', gw);
    await g.process('SB', gw);
    expect(await g.process('OP/W*', gw)).toContain('*B  ');
    const w = new GdsHost({ port: 0, logLevel: 'error', dialect: new WorldspanDialect(), pcc: '1P' });
    const ww = w.newWorkArea();
    await w.process('BSI$5467AB/GS', ww);
    expect(await w.process('B$', ww)).toContain('*A  EMPTY  AB');
  });
});
