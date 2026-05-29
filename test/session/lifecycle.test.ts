import { describe, it, expect, beforeEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

/** v1.1 deepened lifecycle: multi-pax names, cancel, status change, sections. */
describe('PNR lifecycle depth', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
  });

  async function bookTwoSegments(): void {
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y1', wa); // segment 1
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y2', wa); // segment 2 (line 2 = AA 180)
  }

  it('builds a multi-passenger name item and shows it via *N', async () => {
    await host.process('-2MURRAY/FRED MR/HANA MRS', wa);
    expect(wa.pnr.passengerCount()).toBe(2);
    const names = await host.process('*N', wa);
    expect(names).toContain('1.2MURRAY/FRED MR/HANA MRS');
  });

  it('cancels a single segment and renumbers the rest', async () => {
    await bookTwoSegments();
    expect(wa.pnr.segments).toHaveLength(2);
    const resp = await host.process('X1', wa);
    expect(wa.pnr.segments).toHaveLength(1);
    expect(wa.pnr.segments[0].segmentNumber).toBe(1); // renumbered
    expect(resp).toContain('AA'); // remaining itinerary echoed
  });

  it('cancels the entire itinerary with XI', async () => {
    await bookTwoSegments();
    expect(await host.process('XI', wa)).toContain('CANCELLED');
    expect(wa.pnr.segments).toHaveLength(0);
  });

  it('rejects cancel when there is no itinerary', async () => {
    expect(await host.process('X1', wa)).toContain('NO ITINERARY');
  });

  it('changes a segment status with .1HK', async () => {
    await bookTwoSegments();
    await host.process('.1HK', wa);
    expect(wa.pnr.segments[0].status).toBe('HK');
  });

  it('rejects an invalid status code', async () => {
    await bookTwoSegments();
    expect(await host.process('.1ZZ', wa)).toContain('INVALID STATUS');
  });

  it('rejects a status change for a non-existent segment', async () => {
    await bookTwoSegments();
    expect(await host.process('.9HK', wa)).toContain('SEGMENT NUMBER NOT IN ITINERARY');
  });

  it('passively cancels one segment with .1XK and renumbers the rest', async () => {
    await bookTwoSegments();
    const resp = await host.process('.1XK', wa);
    expect(wa.pnr.segments).toHaveLength(1);
    expect(wa.pnr.segments[0].segmentNumber).toBe(1); // renumbered from 2 → 1
    expect(resp).toContain('AA');
  });

  it('passively cancels a range with .1-2XK', async () => {
    await bookTwoSegments();
    expect(await host.process('.1-2XK', wa)).toContain('CANCELLED');
    expect(wa.pnr.segments).toHaveLength(0);
  });

  it('rejects .<seg>XK when the segment does not exist', async () => {
    await bookTwoSegments();
    expect(await host.process('.9XK', wa)).toContain('SEGMENT NUMBER NOT IN ITINERARY');
  });

  it('rejects .<seg>XK when there is no itinerary', async () => {
    expect(await host.process('.1XK', wa)).toContain('NO ITINERARY');
  });

  it('cancels and rebooks from a CPA line (X<seg>¥0<seats><class><line>)', async () => {
    await bookTwoSegments(); // segments 1 and 2 sold from cached availability
    const before = wa.pnr.segments[0];
    // Cancel seg 1 and re-sell line 2 from the cached availability in Y class.
    const resp = await host.process('X1¥01Y2', wa);
    // Order after: original seg 2 → renumbered to 1, new sell → 2.
    expect(wa.pnr.segments).toHaveLength(2);
    expect(wa.pnr.segments[0].segmentNumber).toBe(1);
    expect(wa.pnr.segments[1].segmentNumber).toBe(2);
    // The rebooked segment is on the original date's availability cache.
    expect(wa.pnr.segments[1].date).toBe(before.date);
    expect(resp).toContain('SS1'); // SS1 = sold 1 seat (from renderSoldSegment)
  });

  it('cancels and resells the same flight on a new date (X<seg>¥00<date>)', async () => {
    await bookTwoSegments();
    const orig = wa.pnr.segments[0];
    // Same carrier/flight/class, new date.
    const resp = await host.process(`X1¥0025JUN`, wa);
    expect(wa.pnr.segments).toHaveLength(2);
    // The rebooked leg is now segment 2 (after seg 2 renumbered to 1).
    const rebooked = wa.pnr.segments[1];
    expect(rebooked.carrier).toBe(orig.carrier);
    expect(rebooked.flightNumber).toBe(orig.flightNumber);
    expect(rebooked.bookingClass).toBe(orig.bookingClass);
    expect(rebooked.date).toBe('25JUN');
    expect(rebooked.origin).toBe(orig.origin);
    expect(rebooked.destination).toBe(orig.destination);
    expect(resp).toContain('25JUN');
  });

  it('cancellation stands when the date rebook would oversell', async () => {
    await bookTwoSegments();
    // Sell out the class on the new date by booking it from a different work area
    // until it's empty. The schedule defaults are small enough that one big sell
    // suffices on the target flight.
    const orig = wa.pnr.segments[0];
    // Drain the new-date class on the same flight (seed first, then drain).
    const w2 = host.newWorkArea();
    await host.process('SI*4321', w2);
    await host.process(`125JUN${orig.origin}${orig.destination}`, w2); // seeds via availability
    // Drain by selling a heavy quantity until oversold.
    // The default Y inventory is 9 seats per the SCHEDULE; book all 9.
    for (let i = 0; i < 9; i++) await host.process(`01${orig.bookingClass}1`, w2);

    // Now date-rebook on the same drained flight should fail; cancel still stood.
    const resp = await host.process(`X1¥0025JUN`, wa);
    expect(resp).toContain('CLASS NOT AVAILABLE');
    expect(wa.pnr.segments).toHaveLength(1); // seg 2 only; seg 1 was cancelled
  });

  it('shows a similar-name list when a surname matches more than one PNR', async () => {
    // Commit two SMITH PNRs.
    for (const first of ['JOHN', 'JANE']) {
      const w = host.newWorkArea();
      await host.process('SI*4321', w);
      await host.process('115JUNJFKLAX', w);
      await host.process('01Y1', w);
      await host.process(`-SMITH/${first}`, w);
      await host.process('9305-555-1212-H', w);
      await host.process('7TAW15JUN/', w);
      await host.process('6P', w);
      await host.process('E', w);
    }
    const list = await host.process('*-SMITH', wa);
    expect(list.split('\n').length).toBe(2);
    expect(list).toContain('SMITH/JOHN');
    expect(list).toContain('SMITH/JANE');
    // A list display does not pull a PNR into the work area.
    expect(wa.pnr.hasContent()).toBe(false);
  });

  it('selects a PNR from the similar-name list with *<n>', async () => {
    // Same two-SMITH setup, then exercise selection.
    for (const first of ['JOHN', 'JANE']) {
      const w = host.newWorkArea();
      await host.process('SI*4321', w);
      await host.process('115JUNJFKLAX', w);
      await host.process('01Y1', w);
      await host.process(`-SMITH/${first}`, w);
      await host.process('9305-555-1212-H', w);
      await host.process('7TAW15JUN/', w);
      await host.process('6P', w);
      await host.process('E', w);
    }
    await host.process('*-SMITH', wa); // produces the list, caches it on the WA

    // Capture the first line's surname/given to know the deterministic order.
    const list = await host.process('*-SMITH', wa);
    const firstLine = list.split('\n')[0];
    const expectedFirst = firstLine.includes('JOHN') ? 'JOHN' : 'JANE';

    // *1 selects line 1 — same wire-format response as a record-locator retrieve.
    const display1 = await host.process('*1', wa);
    expect(display1).toContain(`SMITH/${expectedFirst}`);
    expect(wa.pnr.hasContent()).toBe(true);
    expect(wa.state()).toBe('DISPLAYED');
  });

  it('rejects *<n> when the list has no entry at that position', async () => {
    for (const first of ['JOHN', 'JANE']) {
      const w = host.newWorkArea();
      await host.process('SI*4321', w);
      await host.process('115JUNJFKLAX', w);
      await host.process('01Y1', w);
      await host.process(`-SMITH/${first}`, w);
      await host.process('9305-555-1212-H', w);
      await host.process('7TAW15JUN/', w);
      await host.process('6P', w);
      await host.process('E', w);
    }
    await host.process('*-SMITH', wa);
    expect(await host.process('*3', wa)).toBe('RECORD LOCATOR NOT FOUND');
    expect(wa.pnr.hasContent()).toBe(false); // unchanged on out-of-range
  });

  it('rejects *<n> when no similar-name list is on screen', async () => {
    // No prior *-SMITH; *2 is not a section code and not a locator → FORMAT.
    expect(await host.process('*2', wa)).toBe('FORMAT');
  });
});
