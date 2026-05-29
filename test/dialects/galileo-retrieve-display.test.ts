import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';
import { SessionState } from '../../src/session/session-state.js';

describe('Galileo *<arg> parsing', async () => {
  it('parses *<locator> as display with locator argument', async () => {
    const r = parseGalileoEntry('*ABCDEF');
    expect(r.kind).toBe('display');
    if (r.kind === 'display') expect(r.argument).toBe('ABCDEF');
  });

  it('parses *R / *I redisplay verbs', async () => {
    const r1 = parseGalileoEntry('*R');
    if (r1.kind === 'display') expect(r1.argument).toBe('R');
    const r2 = parseGalileoEntry('*I');
    if (r2.kind === 'display') expect(r2.argument).toBe('I');
  });

  it('parses *-<surname>', async () => {
    const r = parseGalileoEntry('*-HENRIQUEZ');
    if (r.kind === 'display') expect(r.argument).toBe('-HENRIQUEZ');
  });

  it('parses *- WILLIAMS/CHRIS MR with internal whitespace preserved', async () => {
    const r = parseGalileoEntry('*- WILLIAMS/CHRIS MR');
    if (r.kind === 'display') expect(r.argument).toBe('- WILLIAMS/CHRIS MR');
  });
});

describe('Galileo dialect — retrieve and display through the host', async () => {
  let host: GdsHost;
  let wa: WorkArea;
  let locator: string;

  beforeEach(async () => {
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
    // Build and commit a baseline BF for retrieve tests
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    locator = await host.process('E', wa);
  });

  it('*R with no PNR returns NO BOOKING FILE', async () => {
    expect(await host.process('*R', wa)).toBe('NO BOOKING FILE');
  });

  it('*<locator> brings the BF into the active slot and renders it', async () => {
    const resp = await host.process(`*${locator}`, wa);
    expect(resp).toContain(locator);
    expect(resp).toContain('SMITH/JOHN MR');
    expect(resp).toContain('JFK');
    expect(resp).toContain('LAX');
    expect(resp).toContain('P. LON*02012345678');
    expect(resp).toContain('T. TAU/10JUN');
    expect(resp).toContain('R. AGT');
    expect(wa.state()).toBe(SessionState.DISPLAYED);
    expect(wa.pnr.locator).toBe(locator);
  });

  it('*<unknown-locator> returns NO BOOKING FILE', async () => {
    expect(await host.process('*ZZZZZZ', wa)).toBe('NO BOOKING FILE');
    expect(wa.state()).toBe(SessionState.EMPTY);
  });

  it('*R after retrieve redisplays the same BF', async () => {
    await host.process(`*${locator}`, wa);
    const resp = await host.process('*R', wa);
    expect(resp).toContain(locator);
    expect(resp).toContain('SMITH/JOHN MR');
  });

  it('*I after retrieve returns the itinerary only (no name lines, no phone)', async () => {
    await host.process(`*${locator}`, wa);
    const resp = await host.process('*I', wa);
    expect(resp).toContain('B6');
    expect(resp).toContain('JFK');
    expect(resp).not.toContain('SMITH/JOHN MR');
    expect(resp).not.toContain('P.');
    expect(resp).not.toContain('R.');
  });

  it('*-<surname> with a unique match retrieves and renders the BF', async () => {
    const resp = await host.process('*-SMITH', wa);
    expect(resp).toContain(locator);
    expect(resp).toContain('SMITH/JOHN MR');
    expect(wa.pnr.locator).toBe(locator);
  });

  it('*-<unknown> returns NO BOOKING FILE', async () => {
    expect(await host.process('*-NOBODY', wa)).toBe('NO BOOKING FILE');
  });

  it('*-<surname> with multiple matches lists locators', async () => {
    // Commit a second SMITH PNR
    await host.process('IG', wa);
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1B1', wa); // book B class instead so seat isn't exhausted
    await host.process('N.SMITH/JANE MS', wa);
    await host.process('P.LON*02087654321', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    const locator2 = await host.process('E', wa);
    expect(locator2).not.toBe(locator);
    const resp = await host.process('*-SMITH', wa);
    expect(resp).toContain(locator);
    expect(resp).toContain(locator2);
    // Single-line-per-locator listing
    expect(resp.split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('ER (end + retrieve) renders the committed BF after building a new one', async () => {
    // Start fresh: ignore, then build a new BF
    await host.process('IG', wa);
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1B1', wa);
    await host.process('N.DOE/JANE MS', wa);
    await host.process('P.LON*02098765432', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    const resp = await host.process('ER', wa);
    expect(resp).not.toMatch(/^[A-Z0-9]{6}$/); // not just a locator anymore
    expect(resp).toContain('DOE/JANE MS');
    expect(resp).toContain('JFK');
  });

  it('cross-area: retrieving in area B leaves A untouched', async () => {
    await host.process(`*${locator}`, wa);
    expect(wa.pnr.locator).toBe(locator);
    await host.process('SB', wa);
    expect(wa.pnr.hasContent()).toBe(false);
    // Retrieve into B
    await host.process(`*${locator}`, wa);
    expect(wa.pnr.locator).toBe(locator);
    // Back to A — should still have the retrieved BF
    await host.process('SA', wa);
    expect(wa.pnr.locator).toBe(locator);
  });
});
