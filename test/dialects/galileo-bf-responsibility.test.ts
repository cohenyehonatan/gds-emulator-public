import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';
import { Pnr } from '../../src/models/pnr.js';
import { clonePnr } from '../../src/store/json-file-pnr-store.js';

/**
 * BF responsibility attribution. The Galileo BF header
 * (`<locator>  <pcc>/<agent>`) must name the agent who CREATED the file,
 * not whoever is currently viewing it. Before this fix, retrieving the
 * same BF after a re-sign-on rewrote the header agent to the new
 * sign-on (observed live: GZTMFH showed A0UC/7K9S, then A0UC/0U1C after
 * SOF + SON/Z0U1C).
 */
describe('Galileo BF responsibility — header attributes the creator, not the viewer', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    wa = host.newWorkArea();
  });

  async function build(): Promise<void> {
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
  }

  it('stamps the creating agent at commit and keeps it across a re-sign-on retrieve', async () => {
    await host.process('SON/Z7K9S', wa);
    await build();
    const locator = (await host.process('E', wa)).trim();
    expect(locator).toMatch(/^[A-Z0-9]{6}$/);

    // First retrieve, still signed on as 7K9S: header shows the creator.
    const first = await host.process(`*${locator}`, wa);
    expect(first).toContain(`7K9S/7K9S`); // pcc/agent — both 7K9S here

    // Sign off, sign on as a DIFFERENT agent, retrieve the same BF.
    await host.process('I', wa); // drop the on-screen BF
    await host.process('SOF', wa);
    await host.process('SON/Z0U1C', wa);
    const second = await host.process(`*${locator}`, wa);

    // The header must STILL attribute the file to its creator (7K9S),
    // NOT the current viewer (0U1C) — this was the bug.
    expect(second).toContain(`7K9S/7K9S`);
    expect(second).not.toContain(`7K9S/0U1C`);
  });

  it('an in-build BF (no locator yet) shows the current sign-on as owner-to-be', async () => {
    await host.process('SON/Z0U1C', wa);
    await build();
    const display = await host.process('*R', wa);
    // No locator yet → placeholder locator, current agent in the header.
    expect(display).toContain('0U1C');
  });

  it('responsiblePcc/Agent survive the JsonFile clone round-trip', () => {
    const pnr = new Pnr();
    pnr.locator = 'ABC123';
    pnr.responsiblePcc = '7K9S';
    pnr.responsibleAgent = '7K9S';
    const round = clonePnr(pnr);
    expect(round.responsiblePcc).toBe('7K9S');
    expect(round.responsibleAgent).toBe('7K9S');
  });
});
