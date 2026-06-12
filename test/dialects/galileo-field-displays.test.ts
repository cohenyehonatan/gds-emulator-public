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

  it('*SVC shows services for all booked segments; *SVC<n> one segment', async () => {
    const all = await host.process('*SVC', wa);
    expect(all).toContain('SVC 1. B6615 Y 15JUN JFKLAX');
    expect(all).toContain('EQP 32A'); // from the inventory schedule
    expect(all).toContain('FLT TIME 3HR15'); // 0700→1015
    expect(await host.process('*SVC1', wa)).toContain('B6615');
    expect(await host.process('*SVC9', wa)).toBe('SEGMENT NOT IN ITINERARY');
  });

  it('*H rows carry real history codes (H/HIST table): AN, AS, AG, AO, AM', async () => {
    await host.process('M.BA12345678', wa);
    const h = await host.process('*H', wa);
    expect(h).toMatch(/AN +\d{2}:\d{2} NAME ADD SMITH/);
    expect(h).toMatch(/AS +\d{2}:\d{2} SELL 1/);
    expect(h).toMatch(/AG +\d{2}:\d{2} SSR VGML/);
    expect(h).toMatch(/AO +\d{2}:\d{2} OSI YY/);
    expect(h).toMatch(/AM +\d{2}:\d{2} MM ADD BA12345678/);
  });

  it('history subsets filter by code: *HN names, *HSR SSRs, *HSI both SI kinds', async () => {
    const hn = await host.process('*HN', wa);
    expect(hn).toContain('NAME ADD SMITH');
    expect(hn).not.toContain('SELL');
    const hsr = await host.process('*HSR', wa);
    expect(hsr).toContain('SSR VGML');
    expect(hsr).not.toContain('OSI');
    const hsi = await host.process('*HSI', wa);
    expect(hsi).toContain('SSR VGML');
    expect(hsi).toContain('OSI YY');
    expect(await host.process('*HMM', wa)).toBe('NO MILEAGE MEMBERSHIP HISTORY');
  });

  it('*HQT shows the queue trail after QEB and QR (codes AQ / XQ)', async () => {
    await host.process('QEB/50', wa);
    const fresh = host.newWorkArea();
    await host.process('SON/ZGS', fresh);
    const list = await host.process('Q/50', fresh);
    const locator = list.slice(0, 6);
    await host.process('QR', fresh);
    await host.process(`*${locator}`, fresh);
    const hqt = await host.process('*HQT', fresh);
    expect(hqt).toContain('QUEUE PLACE 50');
    expect(hqt).toContain('QUEUE REMOVE 50');
    expect(hqt).toMatch(/AQ /);
    expect(hqt).toMatch(/XQ /);
  });

  it('*N.I combines names and itinerary (guide example, verbatim entry)', async () => {
    const resp = await host.process('*N.I', wa);
    expect(resp).toContain('SMITH/JOHN MR');
    expect(resp).toContain('B6');
  });

  it('*N.SI.VR — the guide combination, vendor remarks honestly empty', async () => {
    const resp = await host.process('*N.SI.VR', wa);
    expect(resp).toContain('SMITH/JOHN MR');
    expect(resp).toContain('VGML');
    expect(resp).toContain('NO VENDOR REMARKS');
  });

  it('*N.I+*HIA.SI mixes active displays with history (guide example)', async () => {
    const resp = await host.process('*N.I+*HIA.SI', wa);
    expect(resp).toContain('SMITH/JOHN MR'); // active names
    expect(resp).toMatch(/AS .*SELL 1/); // historical air rows
    expect(resp).toContain('VGML'); // active SI
  });

  it('chains with unknown tokens fall through (locators keep working)', async () => {
    expect(await host.process('*N.ZZZQ', wa)).toBe('FORMAT');
  });

  it('F. forms (Formats Guide verbatim) populate the single-item FOP field', async () => {
    expect(await host.process('F.S', wa)).toBe('OK'); // cash
    expect(await host.process('*FOP', wa)).toBe('F. S');
    expect(await host.process('F.@ AX373912345678901/D1209/E03', wa)).toBe('OK'); // change
    expect(await host.process('*FOP', wa)).toBe('F. AX373912345678901/D1209/E03');
    expect(await host.process('F.@', wa)).toBe('OK'); // delete
    expect(await host.process('*FOP', wa)).toBe('NO FORM OF PAYMENT DATA');
    expect(await host.process('F.CK', wa)).toBe('OK'); // cheque
    expect(await host.process('F.INV PAY BY INVOICE', wa)).toBe('OK'); // replaces (single item)
    expect(await host.process('F.TOTALLYWRONG!!', wa)).toBe('FORMAT');
  });

  it('*HF shows the FOP history with the FP code on change/delete', async () => {
    await host.process('F.S', wa);
    await host.process('F.@ CK', wa);
    await host.process('F.@', wa);
    const hf = await host.process('*HF', wa);
    expect(hf).toContain('FOP ADD S');
    expect(hf).toMatch(/FP +\d{2}:\d{2} FOP CHANGE CK/);
    expect(hf).toMatch(/FP +\d{2}:\d{2} FOP DELETE/);
  });

  it('FOP survives commit + retrieve (persistence round-trip)', async () => {
    await host.process('F.S', wa);
    const loc = await host.process('E', wa);
    const fresh = host.newWorkArea();
    await host.process('SON/ZGS', fresh);
    await host.process(`*${loc}`, fresh);
    expect(await host.process('*FOP', fresh)).toBe('F. S');
  });

  it('Apollo F-S translates (webhelp compare row)', async () => {
    const { ApolloDialect } = await import('../../src/dialects/apollo/index.js');
    const a = new GdsHost({ port: 0, logLevel: 'error', dialect: new ApolloDialect(), pcc: '7K9S' });
    const awa = a.newWorkArea();
    await a.process('SON/ZHA', awa);
    await a.process('A15JUNJFKLAX', awa);
    await a.process('01Y1', awa);
    expect(await a.process('F-S', awa)).toBe('OK');
    expect(await a.process('*FOP', awa)).toBe('F. S');
  });

  it('*TE selector family (Formats Guide verbatim entries)', async () => {
    await host.process('M.B612345678', wa);
    await host.process('F.AX373912345678901/D1209', wa);
    await host.process('FQ', wa);
    const tkp = await host.process('TKP', wa);
    const num = tkp.match(/TKT (\d{13})/)![1];

    // *TE002 — zero-padded index into the e-ticket list.
    expect(await host.process('*TE001', wa)).toContain(num);
    // *TEL — redisplay the list.
    expect(await host.process('*TEL', wa)).toContain('TICKETS');
    // By vendor + mileage membership (B6 validates the B6 itinerary).
    expect(await host.process('*TE/B6/FF12345678', wa)).toContain(num);
    expect(await host.process('*TE/B6/FF99999999', wa)).toBe('TICKET NOT FOUND');
    // By vendor + credit card — matches the F. field's card number.
    expect(await host.process('*TE/B6/CC373912345678901', wa)).toContain(num);
    expect(await host.process('*TE/B6/CC4444555566667777', wa)).toBe('TICKET NOT FOUND');
    // By vendor + date/board/off/name.
    expect(await host.process('*TE/B6/15JUNJFKLAX-SMITH', wa)).toContain(num);
    expect(await host.process('*TE/B6/15JUNJFKLAX-JONES', wa)).toBe('TICKET NOT FOUND');
    expect(await host.process('*TE/B6/15JUNLAXJFK-SMITH', wa)).toBe('TICKET NOT FOUND');
  });

  it('*TEH is a follow-up entry: history of the displayed e-ticket record', async () => {
    expect(await host.process('*TEH', wa)).toBe('NO ETICKET DISPLAYED');
    await host.process('FQ', wa);
    const tkp = await host.process('TKP', wa);
    const num = tkp.match(/TKT (\d{13})/)![1];
    await host.process('*TE001', wa);
    let teh = await host.process('*TEH', wa);
    expect(teh).toContain(`ETKT HISTORY ${num}`);
    expect(teh).toContain('ISSUED');
    expect(teh).not.toContain('VOIDED');
    expect(await host.process(`TRV/${num}`, wa)).toBe(`OK-VOID TKT ${num}`);
    teh = await host.process('*TEH', wa);
    expect(teh).toContain('VOIDED'); // the void lands in the e-ticket history
  });

  it('field displays with no BF on screen answer NO BOOKING FILE', async () => {
    const fresh = host.newWorkArea();
    await host.process('SON/ZGS', fresh);
    expect(await host.process('*N', fresh)).toContain('NO BOOKING FILE');
  });
});
