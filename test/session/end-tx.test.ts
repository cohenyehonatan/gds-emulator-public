import { describe, it, expect, beforeEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

/**
 * Drives the host in-process (no TCP) through the booking flow, asserting the
 * PRINT mandatory-field gate at End Transaction.
 */
describe('end transaction — PRINT mandatory fields', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
  });

  async function bookSegment(): void {
    await host.process('115JUNJFKLAX', wa);
    expect(await host.process('01Y1', wa)).toContain('SS1');
  }

  it('rejects ER when phone is missing', async () => {
    await bookSegment();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('7TAW15JUN/', wa);
    await host.process('6P', wa);
    expect(await host.process('ER', wa)).toContain('NEED PHONE');
  });

  it('rejects ER when received-from is missing', async () => {
    await bookSegment();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('9305-555-1212-H', wa);
    await host.process('7TAW15JUN/', wa);
    expect(await host.process('ER', wa)).toContain('RECEIVED FROM');
  });

  it('commits a complete PNR and returns a record locator on E', async () => {
    await bookSegment();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('9305-555-1212-H', wa);
    await host.process('7TAW15JUN/', wa);
    await host.process('6P', wa);
    const resp = await host.process('E', wa);
    expect(resp).toMatch(/^[A-Z]{6}$/);
    expect(host.context.backend.pnrs.has(resp)).toBe(true);
  });

  it('round-trips: commit then retrieve by locator', async () => {
    await bookSegment();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('9305-555-1212-H', wa);
    await host.process('7TAW15JUN/', wa);
    await host.process('6P', wa);
    const locator = await host.process('E', wa);

    const display = await host.process(`*${locator}`, wa);
    expect(display).toContain(locator);
    expect(display).toContain('SMITH/JOHN');
  });
});
