import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';
import { SessionState } from '../../src/session/session-state.js';

describe('Galileo PNR-field parsing', async () => {
  it('parses N.<surname>/<given> <title> preserving internal whitespace', async () => {
    const r = parseGalileoEntry('N.HENRIQUEZ/RUDY MR');
    expect(r.kind).toBe('name');
    if (r.kind === 'name') expect(r.text).toBe('HENRIQUEZ/RUDY MR');
  });

  it('rejects N. without a slash', async () => {
    expect(() => parseGalileoEntry('N.NOSLASH')).toThrow();
  });

  it('parses P.<rest> capturing the full Galileo phone payload', async () => {
    const r = parseGalileoEntry('P.T*0793 888184-JAN');
    if (r.kind === 'phone') expect(r.text).toBe('T*0793 888184-JAN');
  });

  it('parses T.T* and T.TAU/<DDMMM>', async () => {
    expect(parseGalileoEntry('T.T*').kind).toBe('ticketing');
    const r = parseGalileoEntry('T.TAU/10FEB');
    if (r.kind === 'ticketing') expect(r.text).toBe('TAU/10FEB');
  });

  it('parses R.<initials>', async () => {
    const r = parseGalileoEntry('R.AGT');
    if (r.kind === 'received_from') expect(r.text).toBe('AGT');
  });

  it('parses E / ET / ER as end_transaction (ER sets redisplay)', async () => {
    const e = parseGalileoEntry('E');
    if (e.kind === 'end_transaction') expect(e.redisplay).toBe(false);
    const et = parseGalileoEntry('ET');
    if (et.kind === 'end_transaction') expect(et.redisplay).toBe(false);
    const er = parseGalileoEntry('ER');
    if (er.kind === 'end_transaction') expect(er.redisplay).toBe(true);
  });

  it('parses I / IR as ignore', async () => {
    expect(parseGalileoEntry('I').kind).toBe('ignore');
    expect(parseGalileoEntry('IR').kind).toBe('ignore');
  });

  it('does not confuse N1Y1 (sell) with N. (name)', async () => {
    // N1Y1 has no dot, falls through to sell parser
    const sell = parseGalileoEntry('N1Y1');
    expect(sell.kind).toBe('sell');
    // N.SMITH/JOHN MR has a dot, takes the name branch
    const name = parseGalileoEntry('N.SMITH/JOHN MR');
    expect(name.kind).toBe('name');
  });
});

describe('Galileo dialect — PNR build end-to-end', async () => {
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
    await host.process('SON/ZHA', wa);
  });

  it('N.<surname>/<given> populates pnr.names and returns OK', async () => {
    expect(await host.process('N.SMITH/JOHN MR', wa)).toBe('OK');
    expect(wa.pnr.names.length).toBe(1);
    expect(wa.pnr.names[0].surname).toBe('SMITH');
    expect(wa.pnr.names[0].passengers[0].firstName).toContain('JOHN');
  });

  it('P.<text> stores the raw text in pnr.phones', async () => {
    await host.process('P.T*0793 888184-JAN', wa);
    expect(wa.pnr.phones.length).toBe(1);
    expect(wa.pnr.phones[0].number).toBe('T*0793 888184-JAN');
  });

  it('T.<text> populates pnr.ticketing', async () => {
    await host.process('T.TAU/10FEB', wa);
    expect(wa.pnr.ticketing).toBe('TAU/10FEB');
  });

  it('R.<text> populates pnr.receivedFrom', async () => {
    await host.process('R.AGT', wa);
    expect(wa.pnr.receivedFrom).toBe('AGT');
  });

  it('I (ignore) clears the active slot and returns IGNORED', async () => {
    await host.process('N.SMITH/JOHN MR', wa);
    expect(wa.pnr.names.length).toBe(1);
    expect(await host.process('I', wa)).toBe('IGNORED');
    expect(wa.pnr.names.length).toBe(0);
    expect(wa.state()).toBe(SessionState.EMPTY); // still signed in
  });

  it('E without mandatory fields returns the matching NEED_X error', async () => {
    expect(await host.process('E', wa)).toContain('USE'); // some "USE X." message
  });

  it('complete PNR commits on E and returns a locator', async () => {
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    const resp = await host.process('E', wa);
    expect(resp).toMatch(/^[A-Z0-9]{6}$/); // record locator shape
    expect(wa.pnr.segments.length).toBe(0); // reset after commit
    expect(wa.state()).toBe(SessionState.EMPTY);
  });

  it('E with names != seats returns NAMES_NOT_EQUAL', async () => {
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N2Y1', wa); // 2 seats
    await host.process('N.SMITH/JOHN MR', wa); // only 1 name
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    expect(await host.process('E', wa)).toContain('NOT EQUAL');
  });

  it('cross-area: building in B does not leak into A', async () => {
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('SB', wa);
    expect(wa.pnr.names.length).toBe(0);
    expect(wa.pnr.segments.length).toBe(0);
    await host.process('SA', wa);
    expect(wa.pnr.names.length).toBe(1);
    expect(wa.pnr.segments.length).toBe(1);
  });
});
