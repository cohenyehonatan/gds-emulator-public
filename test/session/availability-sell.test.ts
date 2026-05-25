import { describe, it, expect, beforeEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

/** Richer availability (time/class qualifiers) and sell variants. */
describe('richer availability & sell', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    host.process('SI*4321', wa);
  });

  it('time qualifier starts the display at/after the requested time', () => {
    const all = host.process('115JUNJFKLAX', wa);
    expect(all).toContain('B6'); // 700A flight present without a qualifier

    const afternoon = host.process('115JUNJFKLAX1200', wa);
    expect(afternoon).toContain('UA'); // 100P departs after 1200
    expect(afternoon).not.toContain('B6'); // 700A filtered out
    expect(afternoon).not.toContain('700A');
  });

  it('class qualifier keeps only flights with that class', () => {
    const firstClass = host.process('115JUNJFKLAX-F', wa);
    expect(firstClass).toContain('AA'); // AA has F
    expect(firstClass).not.toContain('B6'); // B6 has no F cabin
  });

  it('filters availability to a preferred airline (¥), incl. the \' alias', () => {
    const aa = host.process('115JUNJFKLAX¥AA', wa);
    expect(aa).toContain('AA');
    expect(aa).not.toContain('B6');
    expect(aa).not.toContain('UA');
    // the ' physical-key alias normalizes to ¥
    const viaAlias = host.process("115JUNJFKLAX'UA", wa);
    expect(viaAlias).toContain('UA');
    expect(viaAlias).not.toContain('AA');
  });

  it('keeps only online connections of a preferred carrier', () => {
    const aa = host.process('115JUNJFKSFO¥AA', wa); // AA300/AA350 via ORD; UA dropped
    expect(aa).toContain('ORDSFO');
    expect(aa).not.toContain('DEN');
    expect(wa.lastAvailability!.lines).toHaveLength(2); // one AA connection only
  });

  it('scrolls (1*) and redisplays (1*R) the cached availability', () => {
    const first = host.process('115JUNJFKLAX', wa);
    expect(host.process('1*', wa)).toBe('NO MORE FLIGHTS'); // we never paginate past one screen
    expect(host.process('1*R', wa)).toBe(first); // redisplay
  });

  it('rejects scroll/redisplay with no prior availability', () => {
    const fresh = host.newWorkArea();
    host.process('SI*4321', fresh);
    expect(host.process('1*R', fresh)).toContain('NO AVAILABILITY');
  });

  it('shows return availability (1R<date>) with the reversed city pair', () => {
    host.process('115JUNJFKLAX', wa);
    const ret = host.process('1R20JUN', wa);
    expect(ret).toContain('20JUN  LAX/JFK');
    expect(ret).toContain('DL'); // DL 422 LAX-JFK
    // 1R¥7 adds 7 days and reverses again
    expect(host.process('1R¥7', wa)).toContain('27JUN  JFK/LAX');
  });

  it('rejects return availability with no prior display', () => {
    const fresh = host.newWorkArea();
    host.process('SI*4321', fresh);
    expect(host.process('1R20JUN', fresh)).toContain('NO AVAILABILITY');
  });

  it('direct-only (/D) excludes connections', () => {
    expect(host.process('115JUNJFKSFO', wa)).toContain('ORDSFO'); // connection shown
    expect(host.process('115JUNJFKSFO/D', wa)).toContain('NO FLIGHTS'); // connections excluded
    expect(host.process('115JUNJFKLAX/D', wa)).toContain('AA 100'); // nonstops still shown
  });

  it('waitlists a sold-out class (LL) without drawing inventory', () => {
    host.process('115JUNJFKLAX', wa);
    const resp = host.process('01V1LL', wa); // class V not in inventory → 0 seats
    expect(resp).toContain('LL1');
    expect(wa.pnr.segments[0].status).toBe('LL');
  });

  it('long-sells by flight number, filling times from the schedule', () => {
    const resp = host.process('0BA192Y15JUNDFWLHRNN2', wa); // BA192 is in the seed
    expect(resp).toContain('BA 192Y');
    expect(resp).toContain('NN2');
    expect(resp).toContain('520P'); // schedule time filled in
    expect(wa.pnr.segments[0].status).toBe('NN');
  });

  it('records a passive segment with its airline locator', () => {
    const resp = host.process('0VS651Y6OCTLHRLOSGK1*AB123C', wa);
    expect(resp).toContain('GK1*AB123C');
    expect(wa.pnr.segments[0].airlineLocator).toBe('AB123C');
  });

  it('sells an open segment', () => {
    const resp = host.process('0AFOPENJ9JULLOSCDGDS2', wa);
    expect(resp).toContain('AF OPENJ');
    expect(wa.pnr.segments[0].flightNumber).toBe('OPEN');
    expect(wa.pnr.segments[0].status).toBe('DS');
  });

  it('confirms a waitlist (LL → HL) at end transaction', () => {
    host.process('115JUNJFKLAX', wa);
    host.process('01Y1LL', wa); // waitlist a seat
    host.process('-SMITH/JOHN MR', wa);
    host.process('9305-555-1212-H', wa);
    host.process('7TAW15JUN/', wa);
    host.process('6P', wa);
    const locator = host.process('E', wa);
    const display = host.process(`*${locator}`, wa);
    expect(display).toContain('HL1'); // confirmed from waitlist
  });
});
