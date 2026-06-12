/**
 * P- print router — GPM.net appendix (references/print/
 * galileo-apollo-print-functions.md, entry forms verbatim).
 *
 * The P- prefix routes any display entry's rendered screen to the
 * print spool (one file per job, GDS_PRINT_DIR). On-screen
 * confirmation reconstructed. Documented divergence: the unretrieved
 * forms retrieve the BF into the work area (shared display pipeline);
 * the real host prints without touching the screen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GdsHost } from '../../src/session/gds-host.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { ApolloDialect } from '../../src/dialects/apollo/index.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo P- print functions', () => {
  let host: GdsHost;
  let wa: WorkArea;
  let dir: string;
  let locator: string;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S' });
    dir = mkdtempSync(join(tmpdir(), 'gds-print-'));
    host.backend.printSpool.outputDir = dir;
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    locator = await host.process('E', wa);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('P-*R prints the retrieved BF — file lands in the spool', async () => {
    await host.process(`*${locator}`, wa);
    const resp = await host.process('P-*R', wa);
    expect(resp).toBe('PRINTED - C5F062');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const body = readFileSync(join(dir, files[0]), 'utf8');
    expect(body).toContain('SMITH/JOHN MR');
    expect(body).toContain(locator);
  });

  it('P-*<locator> prints the unretrieved BF by locator', async () => {
    const resp = await host.process(`P-*${locator}`, wa);
    expect(resp).toBe('PRINTED - C5F062');
    expect(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')).toContain('SMITH/JOHN MR');
  });

  it('P-*-SMITH prints the unretrieved BF by name', async () => {
    const resp = await host.process('P-*-SMITH', wa);
    expect(resp).toBe('PRINTED - C5F062');
  });

  it('P-*I prints only the itinerary portion', async () => {
    await host.process(`*${locator}`, wa);
    await host.process('P-*I', wa);
    const body = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8');
    expect(body).toContain('JFK');
    expect(body).not.toContain('SMITH/JOHN'); // names are not itinerary
  });

  it('P-*H prints the BF history', async () => {
    await host.process(`*${locator}`, wa);
    const resp = await host.process('P-*H', wa);
    expect(resp).toBe('PRINTED - C5F062');
  });

  it('a failing inner display shows its error and prints NOTHING', async () => {
    const resp = await host.process('P-*ZZZ!!', wa);
    expect(host.dialect.isErrorResponse(resp)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe('HQ* host queue verbs (GTID-suffixed, appendix verbatim)', () => {
  let host: GdsHost;
  let wa: WorkArea;
  let dir: string;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S' });
    dir = mkdtempSync(join(tmpdir(), 'gds-print-'));
    host.backend.printSpool.outputDir = dir;
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('TKP holds the ticket image; HQC counts it; HQS flushes it to the spool', async () => {
    expect(await host.process('HQCC5F062', wa)).toBe('SET ADDRESS C5F062 00');
    await host.process('FQ', wa);
    await host.process('TKP', wa);
    expect(await host.process('HQCC5F062', wa)).toBe('SET ADDRESS C5F062 01');
    expect(await host.process('HQDC5F062', wa)).toContain('TICKET IMAGE');
    expect(await host.process('HQSC5F062', wa)).toBe('RESTART IN PROGRESS - PLEASE WAIT');
    expect(await host.process('HQCC5F062', wa)).toBe('SET ADDRESS C5F062 00');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0]), 'utf8')).toContain('TKT');
  });

  it('HQX deletes the held image without printing', async () => {
    await host.process('FQ', wa);
    await host.process('TKP', wa);
    expect(await host.process('HQXC5F062', wa)).toBe('QUEUE C5F062 DELETED');
    expect(await host.process('HQCC5F062', wa)).toBe('SET ADDRESS C5F062 00');
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('bare HQC still serves the Trams MIR Pending/Sent counts', async () => {
    const resp = await host.process('HQC', wa);
    expect(resp).toContain('PENDING');
    expect(resp).toContain('SENT');
  });

  it('HQ* works in the Apollo dialect too (appendix covers both)', async () => {
    const a = new GdsHost({ port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: '7K9S' });
    const awa = a.newWorkArea();
    await a.process('SON/ZHA', awa);
    expect(await a.process('HQCC5F062', awa)).toBe('SET ADDRESS C5F062 00');
  });
});

describe('Apollo P- print functions', () => {
  it('P-**-SMITH (Apollo name form) routes through the translator and prints', async () => {
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: '7K9S' });
    const dir = mkdtempSync(join(tmpdir(), 'gds-print-'));
    host.backend.printSpool.outputDir = dir;
    const wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
    await host.process('A15JUNJFKLAX', wa);
    await host.process('01Y1', wa); // Apollo 0-prefix reference sell
    await host.process('N.SMITH/JOHN MR', wa); // field entries pass through
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    await host.process('E', wa);

    const resp = await host.process('P-**-SMITH', wa);
    expect(resp).toBe('PRINTED - C5F062');
    expect(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')).toContain('SMITH/JOHN');
    rmSync(dir, { recursive: true, force: true });
  });
});
