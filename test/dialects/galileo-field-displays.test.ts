/**
 * `*<field>` Booking File field displays — Galileo Formats Guide
 * H/BFD table (references/galileo/booking-file-display-options.md,
 * entries + meanings verbatim; layouts reconstructed).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo *<field> displays', () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S' });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
    await host.process('A15JUNJFKLAX', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    await host.process('SI.VGML', wa);
    await host.process('SI.YY*VIP', wa);
  });

  it('*N names, *P phones, *TD ticketing, *RV received', async () => {
    expect(await host.process('*N', wa)).toContain('SMITH/JOHN MR');
    expect(await host.process('*P', wa)).toContain('LON*02012345678');
    expect(await host.process('*TD', wa)).toBe('T. TAU/10JUN');
    expect(await host.process('*RV', wa)).toBe('R. AGT');
  });

  it('*SR SSRs only, *SO OSIs only, *SI both', async () => {
    const sr = await host.process('*SR', wa);
    expect(sr).toContain('VGML');
    expect(sr).not.toContain('VIP');
    const so = await host.process('*SO', wa);
    expect(so).toContain('OSI YY VIP');
    expect(so).not.toContain('VGML');
    const si = await host.process('*SI', wa);
    expect(si).toContain('VGML');
    expect(si).toContain('VIP');
  });

  it('*FF shows filed fares after FQ; honest NO before', async () => {
    expect(await host.process('*FF', wa)).toBe('NO FILED FARES');
    await host.process('FQ', wa);
    expect(await host.process('*FF', wa)).toContain('FILED FARE 1');
  });

  it('*MM, *SD, *NP render their fields; empty fields answer NO <FIELD>', async () => {
    expect(await host.process('*MM', wa)).toBe('NO MILEAGE MEMBERSHIP DATA');
    await host.process('M.BA12345678', wa);
    expect(await host.process('*MM', wa)).toContain('BA12345678');
    await host.process('S.P1/6A', wa);
    expect(await host.process('*SD', wa)).toContain('6A');
    await host.process('NP.CALL PAX RE SCHEDULE', wa);
    expect(await host.process('*NP', wa)).toContain('CALL PAX RE SCHEDULE');
  });

  it('*FOP and *CD answer honestly while unmodeled/empty', async () => {
    expect(await host.process('*FOP', wa)).toBe('NO FORM OF PAYMENT DATA');
    expect(await host.process('*CD', wa)).toBe('NO CUSTOMER DATA');
  });

  it('*ALL assembles every populated section', async () => {
    await host.process('FQ', wa);
    const resp = await host.process('*ALL', wa);
    expect(resp).toContain('SMITH/JOHN MR'); // names via *R block
    expect(resp).toContain('VGML'); // service info
    expect(resp).toContain('FILED FARE 1'); // fares
    expect(resp).not.toContain('NO MILEAGE'); // empty sections omitted
  });

  it('*IA/*IH/*IC/*IN slice the itinerary by type; *I and *R show all types', async () => {
    await host.process('HOA6FEB-09FEBLON2', wa);
    await host.process('N1A1D3', wa); // hotel sell from availability
    await host.process('CAL23AUG-25AUGLON', wa);
    await host.process('N1A1', wa); // car sell

    const ia = await host.process('*IA', wa);
    expect(ia).toContain('B6'); // the air segment
    expect(ia).not.toContain('HHL');

    const ih = await host.process('*IH', wa);
    expect(ih).toContain('HHL');
    expect(ih).not.toContain('CCR');

    const ic = await host.process('*IC', wa);
    expect(ic).toContain('CCR');

    const inn = await host.process('*IN', wa);
    expect(inn).toContain('HHL');
    expect(inn).toContain('CCR');
    expect(inn).not.toContain('B6 615'); // air excluded from non-air

    const i = await host.process('*I', wa);
    expect(i).toContain('B6');
    expect(i).toContain('HHL');
    expect(i).toContain('CCR');

    const r = await host.process('*R', wa);
    expect(r).toContain('HHL'); // *R now shows aux segments too
  });

  it('*IS/*IT/*IX answer honestly for unmodeled segment types', async () => {
    expect(await host.process('*IS', wa)).toBe('NO SURFACE SEGMENTS');
    expect(await host.process('*IT', wa)).toBe('NO TOUR SEGMENTS');
    expect(await host.process('*IX', wa)).toBe('NO AIR TAXI SEGMENTS');
  });

  it('field displays with no BF on screen answer NO BOOKING FILE', async () => {
    const fresh = host.newWorkArea();
    await host.process('SON/ZGS', fresh);
    expect(await host.process('*N', fresh)).toContain('NO BOOKING FILE');
  });
});
