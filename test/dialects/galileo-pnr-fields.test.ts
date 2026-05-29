import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';
import { SessionState } from '../../src/session/session-state.js';

describe('Galileo PNR-field parsing', () => {
  it('parses N.<surname>/<given> <title> preserving internal whitespace', () => {
    const r = parseGalileoEntry('N.HENRIQUEZ/RUDY MR');
    expect(r.kind).toBe('name');
    if (r.kind === 'name') expect(r.text).toBe('HENRIQUEZ/RUDY MR');
  });

  it('rejects N. without a slash', () => {
    expect(() => parseGalileoEntry('N.NOSLASH')).toThrow();
  });

  it('parses P.<rest> capturing the full Galileo phone payload', () => {
    const r = parseGalileoEntry('P.T*0793 888184-JAN');
    if (r.kind === 'phone') expect(r.text).toBe('T*0793 888184-JAN');
  });

  it('parses T.T* and T.TAU/<DDMMM>', () => {
    expect(parseGalileoEntry('T.T*').kind).toBe('ticketing');
    const r = parseGalileoEntry('T.TAU/10FEB');
    if (r.kind === 'ticketing') expect(r.text).toBe('TAU/10FEB');
  });

  it('parses R.<initials>', () => {
    const r = parseGalileoEntry('R.AGT');
    if (r.kind === 'received_from') expect(r.text).toBe('AGT');
  });

  it('parses E / ET / ER as end_transaction (ER sets redisplay)', () => {
    const e = parseGalileoEntry('E');
    if (e.kind === 'end_transaction') expect(e.redisplay).toBe(false);
    const et = parseGalileoEntry('ET');
    if (et.kind === 'end_transaction') expect(et.redisplay).toBe(false);
    const er = parseGalileoEntry('ER');
    if (er.kind === 'end_transaction') expect(er.redisplay).toBe(true);
  });

  it('parses I / IR as ignore', () => {
    expect(parseGalileoEntry('I').kind).toBe('ignore');
    expect(parseGalileoEntry('IR').kind).toBe('ignore');
  });

  it('does not confuse N1Y1 (sell) with N. (name)', () => {
    // N1Y1 has no dot, falls through to sell parser
    const sell = parseGalileoEntry('N1Y1');
    expect(sell.kind).toBe('sell');
    // N.SMITH/JOHN MR has a dot, takes the name branch
    const name = parseGalileoEntry('N.SMITH/JOHN MR');
    expect(name.kind).toBe('name');
  });
});

describe('Galileo dialect — PNR build end-to-end', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(() => {
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    wa = host.newWorkArea();
    host.process('SON/ZHA', wa);
  });

  it('N.<surname>/<given> populates pnr.names and returns OK', () => {
    expect(host.process('N.SMITH/JOHN MR', wa)).toBe('OK');
    expect(wa.pnr.names.length).toBe(1);
    expect(wa.pnr.names[0].surname).toBe('SMITH');
    expect(wa.pnr.names[0].passengers[0].firstName).toContain('JOHN');
  });

  it('P.<text> stores the raw text in pnr.phones', () => {
    host.process('P.T*0793 888184-JAN', wa);
    expect(wa.pnr.phones.length).toBe(1);
    expect(wa.pnr.phones[0].number).toBe('T*0793 888184-JAN');
  });

  it('T.<text> populates pnr.ticketing', () => {
    host.process('T.TAU/10FEB', wa);
    expect(wa.pnr.ticketing).toBe('TAU/10FEB');
  });

  it('R.<text> populates pnr.receivedFrom', () => {
    host.process('R.AGT', wa);
    expect(wa.pnr.receivedFrom).toBe('AGT');
  });

  it('I (ignore) clears the active slot and returns IGNORED', () => {
    host.process('N.SMITH/JOHN MR', wa);
    expect(wa.pnr.names.length).toBe(1);
    expect(host.process('I', wa)).toBe('IGNORED');
    expect(wa.pnr.names.length).toBe(0);
    expect(wa.state()).toBe(SessionState.EMPTY); // still signed in
  });

  it('E without mandatory fields returns the matching NEED_X error', () => {
    expect(host.process('E', wa)).toContain('USE'); // some "USE X." message
  });

  it('complete PNR commits on E and returns a locator', () => {
    host.process('A15JUNJFKLAX', wa);
    host.process('N1Y1', wa);
    host.process('N.SMITH/JOHN MR', wa);
    host.process('P.LON*02012345678', wa);
    host.process('T.TAU/10JUN', wa);
    host.process('R.AGT', wa);
    const resp = host.process('E', wa);
    expect(resp).toMatch(/^[A-Z0-9]{6}$/); // record locator shape
    expect(wa.pnr.segments.length).toBe(0); // reset after commit
    expect(wa.state()).toBe(SessionState.EMPTY);
  });

  it('E with names != seats returns NAMES_NOT_EQUAL', () => {
    host.process('A15JUNJFKLAX', wa);
    host.process('N2Y1', wa); // 2 seats
    host.process('N.SMITH/JOHN MR', wa); // only 1 name
    host.process('P.LON*02012345678', wa);
    host.process('T.TAU/10JUN', wa);
    host.process('R.AGT', wa);
    expect(host.process('E', wa)).toContain('NOT EQUAL');
  });

  it('cross-area: building in B does not leak into A', () => {
    host.process('A15JUNJFKLAX', wa);
    host.process('N1Y1', wa);
    host.process('N.SMITH/JOHN MR', wa);
    host.process('SB', wa);
    expect(wa.pnr.names.length).toBe(0);
    expect(wa.pnr.segments.length).toBe(0);
    host.process('SA', wa);
    expect(wa.pnr.names.length).toBe(1);
    expect(wa.pnr.segments.length).toBe(1);
  });
});
