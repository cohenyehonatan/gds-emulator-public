import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { Pnr } from '../../src/models/pnr.js';
import type { TicketRecord } from '../../src/models/ticket.js';

describe('Galileo *TE<n> / *TE/<ticket> — display single eticket', () => {
  let host: GdsHost;
  let wa: ReturnType<GdsHost['newWorkArea']>;

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

  function buildPnrWithTickets(): Pnr {
    const pnr = new Pnr();
    pnr.locator = 'ABC123';
    pnr.names.push({
      surname: 'SMITH',
      passengers: [{ firstName: 'JOHN MR' }],
      count: 1,
      infant: false,
    });
    pnr.segments.push({
      segmentNumber: 1,
      carrier: 'UA',
      flightNumber: '1234',
      bookingClass: 'Y',
      date: '27JUN',
      dayOfWeek: '?',
      dayOfWeekNum: 0,
      origin: 'DEN',
      destination: 'FRA',
      status: 'HK',
      seats: 1,
      departTime: '0800',
      arriveTime: '0730',
    });
    const tickets: TicketRecord[] = [
      {
        number: '0011231231234',
        type: 'TE',
        stock: 'AT',
        passenger: 'SMITH/J',
        pcc: '7K9S',
        issuedAt: new Date(0),
        tariff: 'D',
        validatingCarrier: 'UA',
        base: 100,
        taxTotal: 20,
        total: 120,
        status: 'OPEN',
      },
      {
        number: '0011231231235',
        type: 'TE',
        stock: 'AT',
        passenger: 'SMITH/J',
        pcc: '7K9S',
        issuedAt: new Date(0),
        tariff: 'D',
        validatingCarrier: 'UA',
        base: 200,
        taxTotal: 40,
        total: 240,
        status: 'OPEN',
      },
    ];
    pnr.tickets = tickets;
    return pnr;
  }

  it('*TE1 returns the first eticket only', async () => {
    wa.pnr = buildPnrWithTickets();
    const resp = await host.process('*TE1', wa);
    expect(resp).toContain('0011231231234');
    expect(resp).not.toContain('0011231231235');
  });

  it('*TE2 returns the second eticket only', async () => {
    wa.pnr = buildPnrWithTickets();
    const resp = await host.process('*TE2', wa);
    expect(resp).toContain('0011231231235');
    expect(resp).not.toContain('0011231231234');
  });

  it('*TE/<number> returns the matching eticket', async () => {
    wa.pnr = buildPnrWithTickets();
    const resp = await host.process('*TE/0011231231234', wa);
    expect(resp).toContain('0011231231234');
    expect(resp).not.toContain('0011231231235');
  });

  it('*TE<out-of-range> returns TICKET NOT FOUND', async () => {
    wa.pnr = buildPnrWithTickets();
    const resp = await host.process('*TE99', wa);
    expect(resp).toBe('TICKET NOT FOUND');
  });

  it('*TE/<unknown-number> returns TICKET NOT FOUND', async () => {
    wa.pnr = buildPnrWithTickets();
    const resp = await host.process('*TE/9999999999999', wa);
    expect(resp).toBe('TICKET NOT FOUND');
  });

  it('*TE on a PNR with no tickets returns TICKET NOT FOUND', async () => {
    const pnr = buildPnrWithTickets();
    pnr.tickets = [];
    wa.pnr = pnr;
    const resp = await host.process('*TE1', wa);
    expect(resp).toBe('TICKET NOT FOUND');
  });

  it('*TE on no PNR returns NO PNR (existing convention)', async () => {
    const resp = await host.process('*TE1', wa);
    expect(resp).toMatch(/NO/); // NO PNR / NO BOOKING FILE
  });
});
