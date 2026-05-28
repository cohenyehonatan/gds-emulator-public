import { describe, it, expect, beforeEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

/** v1.1 deepened lifecycle: multi-pax names, cancel, status change, sections. */
describe('PNR lifecycle depth', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*4321', wa);
  });

  function bookTwoSegments(): void {
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1', wa); // segment 1
    host.process('115JUNJFKLAX', wa);
    host.process('01Y2', wa); // segment 2 (line 2 = AA 180)
  }

  it('builds a multi-passenger name item and shows it via *N', () => {
    host.process('-2MURRAY/FRED MR/HANA MRS', wa);
    expect(wa.pnr.passengerCount()).toBe(2);
    const names = host.process('*N', wa);
    expect(names).toContain('1.2MURRAY/FRED MR/HANA MRS');
  });

  it('cancels a single segment and renumbers the rest', () => {
    bookTwoSegments();
    expect(wa.pnr.segments).toHaveLength(2);
    const resp = host.process('X1', wa);
    expect(wa.pnr.segments).toHaveLength(1);
    expect(wa.pnr.segments[0].segmentNumber).toBe(1); // renumbered
    expect(resp).toContain('AA'); // remaining itinerary echoed
  });

  it('cancels the entire itinerary with XI', () => {
    bookTwoSegments();
    expect(host.process('XI', wa)).toContain('CANCELLED');
    expect(wa.pnr.segments).toHaveLength(0);
  });

  it('rejects cancel when there is no itinerary', () => {
    expect(host.process('X1', wa)).toContain('NO ITINERARY');
  });

  it('changes a segment status with .1HK', () => {
    bookTwoSegments();
    host.process('.1HK', wa);
    expect(wa.pnr.segments[0].status).toBe('HK');
  });

  it('rejects an invalid status code', () => {
    bookTwoSegments();
    expect(host.process('.1ZZ', wa)).toContain('INVALID STATUS');
  });

  it('rejects a status change for a non-existent segment', () => {
    bookTwoSegments();
    expect(host.process('.9HK', wa)).toContain('SEGMENT NUMBER NOT IN ITINERARY');
  });

  it('shows a similar-name list when a surname matches more than one PNR', () => {
    // Commit two SMITH PNRs.
    for (const first of ['JOHN', 'JANE']) {
      const w = host.newWorkArea();
      host.process('SI*4321', w);
      host.process('115JUNJFKLAX', w);
      host.process('01Y1', w);
      host.process(`-SMITH/${first}`, w);
      host.process('9305-555-1212-H', w);
      host.process('7TAW15JUN/', w);
      host.process('6P', w);
      host.process('E', w);
    }
    const list = host.process('*-SMITH', wa);
    expect(list.split('\n').length).toBe(2);
    expect(list).toContain('SMITH/JOHN');
    expect(list).toContain('SMITH/JANE');
    // A list display does not pull a PNR into the work area.
    expect(wa.pnr.hasContent()).toBe(false);
  });

  it('selects a PNR from the similar-name list with *<n>', () => {
    // Same two-SMITH setup, then exercise selection.
    for (const first of ['JOHN', 'JANE']) {
      const w = host.newWorkArea();
      host.process('SI*4321', w);
      host.process('115JUNJFKLAX', w);
      host.process('01Y1', w);
      host.process(`-SMITH/${first}`, w);
      host.process('9305-555-1212-H', w);
      host.process('7TAW15JUN/', w);
      host.process('6P', w);
      host.process('E', w);
    }
    host.process('*-SMITH', wa); // produces the list, caches it on the WA

    // Capture the first line's surname/given to know the deterministic order.
    const list = host.process('*-SMITH', wa);
    const firstLine = list.split('\n')[0];
    const expectedFirst = firstLine.includes('JOHN') ? 'JOHN' : 'JANE';

    // *1 selects line 1 — same wire-format response as a record-locator retrieve.
    const display1 = host.process('*1', wa);
    expect(display1).toContain(`SMITH/${expectedFirst}`);
    expect(wa.pnr.hasContent()).toBe(true);
    expect(wa.state()).toBe('DISPLAYED');
  });

  it('rejects *<n> when the list has no entry at that position', () => {
    for (const first of ['JOHN', 'JANE']) {
      const w = host.newWorkArea();
      host.process('SI*4321', w);
      host.process('115JUNJFKLAX', w);
      host.process('01Y1', w);
      host.process(`-SMITH/${first}`, w);
      host.process('9305-555-1212-H', w);
      host.process('7TAW15JUN/', w);
      host.process('6P', w);
      host.process('E', w);
    }
    host.process('*-SMITH', wa);
    expect(host.process('*3', wa)).toBe('RECORD LOCATOR NOT FOUND');
    expect(wa.pnr.hasContent()).toBe(false); // unchanged on out-of-range
  });

  it('rejects *<n> when no similar-name list is on screen', () => {
    // No prior *-SMITH; *2 is not a section code and not a locator → FORMAT.
    expect(host.process('*2', wa)).toBe('FORMAT');
  });
});
