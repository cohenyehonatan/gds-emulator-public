import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo TRV/<ticket> parsing', () => {
  it('parses TRV/<13-digit>', () => {
    const r = parseGalileoEntry('TRV/0161234567890');
    expect(r.kind).toBe('void');
    if (r.kind === 'void') {
      expect(r.mode).toBe('manual');
      expect(r.ticketNumber).toBe('0161234567890');
    }
  });

  it('rejects malformed TRV', () => {
    expect(() => parseGalileoEntry('TRV')).toThrow();
    expect(() => parseGalileoEntry('TRV/123')).toThrow();
    expect(() => parseGalileoEntry('TRV/01612345678901')).toThrow();  // 14 digits
    expect(() => parseGalileoEntry('TRVE/0161234567890')).toThrow();  // reissued — deferred
  });
});

describe('Galileo live TRV/<ticket> — void via /tickets/updatestatus', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const ok = () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const reservationResp = (loc: string) =>
    new Response(JSON.stringify({
      Reservation: {
        Identifier: { value: loc },
        Traveler: [{ PersonName: { Given: 'JOHN', Surname: 'SMITH' } }],
        AirReservation: {
          Flights: [{
            carrier: 'UA', number: '1234',
            Departure: { location: 'DEN', time: '2026-06-27T08:00:00Z' },
            Arrival: { location: 'FRA', time: '2026-06-28T07:30:00Z' },
          }],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const receiptsResp = () =>
    new Response(JSON.stringify({
      Receipt: [{
        ticketNumber: '0161234567890',
        passengerName: 'SMITH/JOHN',
        validatingCarrier: 'UA',
        status: 'OPEN',
        base: 500, taxTotal: 80, total: 580,
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend({
      clientId: 'x', clientSecret: 'y', username: 'z', password: 'w',
    });
    host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend,
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });

  afterEach(() => fetchSpy.mockRestore());

  it('TRV/<ticket> after *HTI PUTs /tickets/updatestatus and marks local ticket VOIDED', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(receiptsResp())
      .mockResolvedValueOnce(ok());  // voidTicket

    await host.process('*ABC123', wa);
    await host.process('*HTI', wa);
    expect(wa.pnr.tickets[0].status).toBe('OPEN');
    const resp = await host.process('TRV/0161234567890', wa);
    expect(resp).toContain('OK-VOID');
    expect(resp).toContain('0161234567890');
    expect(wa.pnr.tickets[0].status).toBe('VOIDED');

    const [voidUrl, voidInit] = fetchSpy.mock.calls[3];
    expect(voidUrl).toContain('/air/ticket/tickets/updatestatus/0161234567890');
    expect(voidInit?.method).toBe('PUT');
    const body = JSON.parse((voidInit?.body as string) ?? '{}');
    expect(body.status).toBe('VOIDED');
  });

  it('TRV/<unknown ticket> on a populated PNR returns TKT NOT FOUND', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(receiptsResp())
      .mockResolvedValueOnce(ok());  // void POST succeeds at REST

    await host.process('*ABC123', wa);
    await host.process('*HTI', wa);
    // Live void succeeds (server says OK) but the ticket isn't in the
    // local mirror, so the post-PUT local lookup fails. This is a
    // documented gotcha — the agent should refresh *HTI first.
    const resp = await host.process('TRV/9999999999999', wa);
    expect(resp).toBe('TKT NOT FOUND');
  });

  it('404 from /tickets/updatestatus surfaces as TKT NOT FOUND', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(receiptsResp())
      .mockResolvedValueOnce(new Response('{}', { status: 404, statusText: 'Not Found' }));

    await host.process('*ABC123', wa);
    await host.process('*HTI', wa);
    expect(await host.process('TRV/0161234567890', wa)).toBe('TKT NOT FOUND');
  });

  it('5xx surfaces as LIVE BACKEND ERROR; local ticket unchanged', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(receiptsResp())
      .mockResolvedValueOnce(new Response('"down"', { status: 503, statusText: 'Service Unavailable' }));

    await host.process('*ABC123', wa);
    await host.process('*HTI', wa);
    const resp = await host.process('TRV/0161234567890', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
    expect(wa.pnr.tickets[0].status).toBe('OPEN');  // unchanged on failure
  });

  it('emulated TRV/<ticket> marks the local ticket VOIDED without any fetch', async () => {
    const emulatedHost = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);
    await emulatedHost.process('A15JUNJFKLAX', ewa);
    await emulatedHost.process('N1Y1', ewa);
    await emulatedHost.process('N.SMITH/JOHN MR', ewa);
    await emulatedHost.process('P.LON*02012345678', ewa);
    await emulatedHost.process('T.TAU/10JUN', ewa);
    await emulatedHost.process('R.AGT', ewa);
    await emulatedHost.process('FQ', ewa);
    await emulatedHost.process('TKP1', ewa);
    const tkt = ewa.pnr.tickets[0].number;
    const resp = await emulatedHost.process(`TRV/${tkt}`, ewa);
    expect(resp).toContain('OK-VOID');
    expect(ewa.pnr.tickets[0].status).toBe('VOIDED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
