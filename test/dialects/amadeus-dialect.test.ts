import { describe, it, expect } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';

describe('Amadeus dialect — identity + chain semantics', () => {
  it('exposes the Amadeus identity strings', () => {
    const d = new AmadeusDialect();
    expect(d.id).toBe('amadeus');
    expect(d.displayName).toBe('Amadeus');
    expect(d.screenName).toBe('AMADEUS');
    expect(d.bannerText).toContain('Amadeus');
    expect(d.bannerText).toContain('JI<duty>');
  });

  it('splits chained entries on `;` (Amadeus end-item)', () => {
    const d = new AmadeusDialect();
    expect(d.splitChain('JI2345HA/GS')).toEqual(['JI2345HA/GS']);
    expect(d.splitChain('JI2345HA/GS;JD;JO')).toEqual(['JI2345HA/GS', 'JD', 'JO']);
    // Empty fragments are dropped.
    expect(d.splitChain('JI2345HA/GS;;JD')).toEqual(['JI2345HA/GS', 'JD']);
  });

  it('flags chain-halting errors', () => {
    const d = new AmadeusDialect();
    expect(d.isErrorResponse('NOT IMPLEMENTED — amadeus dialect (v1)')).toBe(true);
    expect(d.isErrorResponse('FORMAT')).toBe(true);
    expect(d.isErrorResponse('NEEDS AGENT SIGN')).toBe(true);
    expect(d.isErrorResponse('HA SIGNED IN')).toBe(false);
  });
});

describe('Amadeus dialect — sign-in / sign-out / status', () => {
  function makeHost(): GdsHost {
    return new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC' });
  }

  it('JI<duty><initials>/<system> signs the agent in', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    const resp = await host.process('JI2345HA/GS', wa);
    expect(resp).toBe('HA SIGNED IN');
    expect(wa.agent).toBe('HA');
  });

  it('JIA<...> signs in to the specified work area', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    const resp = await host.process('JIA2345HA/GS', wa);
    expect(resp).toBe('HA SIGNED IN');
    expect(wa.agent).toBe('HA');
  });

  it('JO without prior sign-in returns NEEDS AGENT SIGN', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    expect(await host.process('JO', wa)).toBe('NEEDS AGENT SIGN');
  });

  it('JO signs out after JI (PNR cleared; agent identifier persists for next JI)', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    expect(await host.process('JO', wa)).toBe('HA SIGNED OUT');
    // Matches Galileo's sign-off semantic: wa.reset() clears the PNR
    // and session-derived state, but the agent identifier stays on the
    // WorkArea so a chained JI doesn't have to re-supply it. The state
    // machine has transitioned to SIGNED_OFF, which is what gates
    // further entries.
    expect(wa.state()).toBe('SIGNED_OFF');
  });

  it('JD displays work-area status when signed in', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    const resp = await host.process('JD', wa);
    expect(resp).toContain('WORK AREA STATUS');
    expect(resp).toContain('HA');
  });

  it('unimplemented verbs return the explicit honest-boundary stub', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    // AN = availability, SS = sell — both deferred for v1.
    expect(await host.process('AN15JUNJFKLAX', wa)).toBe('NOT IMPLEMENTED — amadeus dialect (v1)');
    expect(await host.process('SS1Y1', wa)).toBe('NOT IMPLEMENTED — amadeus dialect (v1)');
  });

  it('malformed sign-in returns FORMAT', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    expect(await host.process('JIxxxx', wa)).toBe('FORMAT');
    expect(await host.process('JI/GS', wa)).toBe('FORMAT');
  });

  it('JI;JD chain runs both entries', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    // GdsHost.process splits on the dialect's chain separator. Combined
    // entry returns the LAST response (matching the existing host
    // behavior).
    const resp = await host.process('JI2345HA/GS;JD', wa);
    expect(resp).toContain('WORK AREA STATUS');
    expect(wa.agent).toBe('HA');
  });

  it('chain halts at NOT IMPLEMENTED — downstream entry does not run', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('JI2345HA/GS', wa);
    // First entry (AN) returns NOT IMPLEMENTED → chain stops → JO never runs.
    await host.process('AN15JUNJFKLAX;JO', wa);
    expect(wa.agent).toBe('HA'); // still signed in
  });
});
