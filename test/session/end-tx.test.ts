import { describe, it, expect, beforeEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

/**
 * Drives the host in-process (no TCP) through the booking flow, asserting the
 * PRINT mandatory-field gate at End Transaction.
 */
describe('end transaction — PRINT mandatory fields', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*4321', wa);
  });

  function bookSegment(): void {
    host.process('115JUNJFKLAX', wa);
    expect(host.process('01Y1', wa)).toContain('SS1');
  }

  it('rejects ER when phone is missing', () => {
    bookSegment();
    host.process('-SMITH/JOHN MR', wa);
    host.process('7TAW15JUN/', wa);
    host.process('6P', wa);
    expect(host.process('ER', wa)).toContain('NEED PHONE');
  });

  it('rejects ER when received-from is missing', () => {
    bookSegment();
    host.process('-SMITH/JOHN MR', wa);
    host.process('9305-555-1212-H', wa);
    host.process('7TAW15JUN/', wa);
    expect(host.process('ER', wa)).toContain('RECEIVED FROM');
  });

  it('commits a complete PNR and returns a record locator on E', () => {
    bookSegment();
    host.process('-SMITH/JOHN MR', wa);
    host.process('9305-555-1212-H', wa);
    host.process('7TAW15JUN/', wa);
    host.process('6P', wa);
    const resp = host.process('E', wa);
    expect(resp).toMatch(/^[A-Z]{6}$/);
    expect(host.context.pnrStore.has(resp)).toBe(true);
  });

  it('round-trips: commit then retrieve by locator', () => {
    bookSegment();
    host.process('-SMITH/JOHN MR', wa);
    host.process('9305-555-1212-H', wa);
    host.process('7TAW15JUN/', wa);
    host.process('6P', wa);
    const locator = host.process('E', wa);

    const display = host.process(`*${locator}`, wa);
    expect(display).toContain(locator);
    expect(display).toContain('SMITH/JOHN');
  });
});
