import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { mapReceipts } from '../../src/backends/travelport-mapper.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('mapReceipts', () => {
  it('extracts an array of Receipt[] into TicketRecord[]', () => {
    const fixture = {
      Receipt: [
        {
          ticketNumber: '0161234567890',
          passengerName: 'SMITH/JOHN',
          validatingCarrier: 'UA',
          status: 'OPEN',
          base: 500, taxTotal: 80, total: 580,
        },
        {
          ticketNumber: '0161234567891',
          passengerName: 'SMITH/JANE',
          validatingCarrier: 'UA',
          status: 'VOIDED',
          base: 500, taxTotal: 80, total: 580,
        },
      ],
    };
    const tickets = mapReceipts(fixture);
    expect(tickets).toHaveLength(2);
    expect(tickets[0]).toMatchObject({
      number: '0161234567890',
      passenger: 'SMITH/JOHN',
      validatingCarrier: 'UA',
      status: 'OPEN',
      total: 580,
    });
    expect(tickets[1].status).toBe('VOIDED');
  });

  it('drops a receipt without a ticket number', () => {
    const fixture = { Receipt: [{ passengerName: 'X' }] };
    expect(mapReceipts(fixture)).toEqual([]);
  });

  it('returns [] for empty/null input', () => {
    expect(mapReceipts({})).toEqual([]);
    expect(mapReceipts(null)).toEqual([]);
  });
});

describe('Galileo live *HTI — list tickets via /receipts', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
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
      Receipt: [
        {
          ticketNumber: '0161234567890',
          passengerName: 'SMITH/JOHN',
          validatingCarrier: 'UA',
          status: 'OPEN',
          base: 500, taxTotal: 80, total: 580,
        },
      ],
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

  it('*HTI after *<locator> GETs /receipts and renders the ticket list', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(receiptsResp());

    await host.process('*ABC123', wa);
    const resp = await host.process('*HTI', wa);
    expect(resp).toContain('TICKETS');
    expect(resp).toContain('0161234567890');
    expect(resp).toContain('SMITH/JOHN');
    expect(resp).toContain('OPEN');
    expect(wa.pnr.tickets).toHaveLength(1);

    const [receiptsUrl] = fetchSpy.mock.calls[2];
    expect(receiptsUrl).toContain('/air/receipt/reservations/ABC123/receipts');
  });

  it('*HTE behaves the same as *HTI', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(receiptsResp());

    await host.process('*ABC123', wa);
    const resp = await host.process('*HTE', wa);
    expect(resp).toContain('TICKETS');
    expect(resp).toContain('0161234567890');
  });

  it('*HTI without a locator falls back to local pnr.tickets', async () => {
    expect(await host.process('*HTI', wa)).toBe('NO BOOKING FILE');
  });

  it('5xx from /receipts surfaces as LIVE BACKEND ERROR', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(new Response('"down"', { status: 503, statusText: 'Service Unavailable' }));

    await host.process('*ABC123', wa);
    const resp = await host.process('*HTI', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
  });

  it('404 → NO BOOKING FILE', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(reservationResp('ABC123'))
      .mockResolvedValueOnce(new Response('{}', { status: 404, statusText: 'Not Found' }));

    await host.process('*ABC123', wa);
    expect(await host.process('*HTI', wa)).toBe('NO BOOKING FILE');
  });

  it('emulated *HTI renders local pnr.tickets without any fetch', async () => {
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
    const resp = await emulatedHost.process('*HTI', ewa);
    expect(resp).toContain('TICKETS');
    expect(resp).toMatch(/\d{13}/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
