import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';

describe('Galileo PQ/ past-date BF retrieve', () => {
  let host: GdsHost;
  let wa: ReturnType<GdsHost['newWorkArea']>;

  beforeEach(async () => {
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });

  it('PQ/R-<locator> parses to display kind with PQ-R: argument', () => {
    const r = parseGalileoEntry('PQ/R-3S71JL');
    expect(r.kind).toBe('display');
    if (r.kind === 'display') {
      expect(r.argument).toBe('PQ-R:3S71JL');
    }
  });

  it('PQ/R-<locator> retrieves from local pnrStore (session retention)', async () => {
    // Build + commit a PNR so the pnrStore has it.
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    const locator = await host.process('E', wa);
    expect(locator).toMatch(/^[A-Z0-9]{6}$/);

    // After end-tx the WA is clear; PQ/R-<locator> should re-pull it.
    const resp = await host.process(`PQ/R-${locator}`, wa);
    expect(resp).toContain(locator);
    expect(wa.pnr.locator).toBe(locator);
  });

  it('PQ/R-<unknown-locator> returns PAST DATE BF NOT FOUND', async () => {
    const resp = await host.process('PQ/R-ZZZZZ1', wa);
    expect(resp).toBe('PAST DATE BF NOT FOUND');
  });

  it('PQ/<date>name forms return PAST DATE BF SEARCH DEFERRED', async () => {
    const r = parseGalileoEntry('PQ/24JAN24SHARP/RICHARD');
    expect(r.kind).toBe('display');
    if (r.kind === 'display') {
      expect(r.argument).toContain('PQ-DEFERRED');
    }
    const resp = await host.process('PQ/24JAN24SHARP/RICHARD', wa);
    expect(resp).toBe('PAST DATE BF SEARCH DEFERRED');
  });

  it('PQ/B/<date>-<surname> deferred', async () => {
    const resp = await host.process('PQ/B/26MAR24-SMIT', wa);
    expect(resp).toBe('PAST DATE BF SEARCH DEFERRED');
  });

  it('PQ/<from>-<to>-<surname> deferred', async () => {
    const resp = await host.process('PQ/01JAN2431JAN24-PALIN', wa);
    expect(resp).toBe('PAST DATE BF SEARCH DEFERRED');
  });
});
