import { describe, it, expect, beforeEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

/** End-item (§) chaining: several entries in one transmission (workbook p.3). */
describe('end-item chaining', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y1', wa); // itinerary so the PNR can later end
  });

  it('adds several PNR fields from one chained entry', async () => {
    await host.process('-SMITH/JOHN MR§9305-555-1212-H§7TAW15JUN/§6P', wa);
    expect(wa.pnr.names).toHaveLength(1);
    expect(wa.pnr.phones).toHaveLength(1);
    expect(wa.pnr.ticketing).toBe('TAW15JUN/');
    expect(wa.pnr.receivedFrom).toBe('P');
  });

  it('accepts the ASCII alias \\ for the end-item key', async () => {
    await host.process('-SMITH/JOHN MR\\9305-555-1212-H\\6P', wa);
    expect(wa.pnr.names).toHaveLength(1);
    expect(wa.pnr.phones).toHaveLength(1);
    expect(wa.pnr.receivedFrom).toBe('P');
  });

  it('combines received-from and end transaction (6P§E)', async () => {
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('9305-555-1212-H', wa);
    await host.process('7TAW15JUN/', wa);
    const resp = await host.process('6P§E', wa); // received-from + end in one entry
    expect(resp).toMatch(/[A-Z]{6}$/); // ends with the record locator
  });

  it('halts the chain at the first error', async () => {
    const resp = await host.process('-SMITH/JOHN MR§ZZZ§9305-555-1212-H', wa);
    expect(resp).toContain('FORMAT');
    expect(wa.pnr.names).toHaveLength(1); // name added before the bad entry
    expect(wa.pnr.phones).toHaveLength(0); // phone after the error never ran
  });
});
