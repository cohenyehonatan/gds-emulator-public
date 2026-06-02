import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { FareQuote } from '../../src/models/fare.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo TMU<n>F<form> cryptic parsing', () => {
  it('TMU1FS — cash', () => {
    const r = parseGalileoEntry('TMU1FS');
    expect(r.kind).toBe('ticket_modifier');
    if (r.kind === 'ticket_modifier') {
      expect(r.filedFare).toBe(1);
      expect(r.fop).toEqual({ kind: 'cash' });
    }
  });

  it('TMU1FNONREF — cash, non-refundable', () => {
    const r = parseGalileoEntry('TMU1FNONREF');
    expect(r.kind).toBe('ticket_modifier');
    if (r.kind === 'ticket_modifier') {
      expect(r.fop).toEqual({ kind: 'cash', nonRefundable: true });
    }
  });

  it('TMU2FAX27391223456789*D1228 — credit card (Mini Guide verbatim PAN + expiry)', () => {
    const r = parseGalileoEntry('TMU2FAX27391223456789*D1228');
    expect(r.kind).toBe('ticket_modifier');
    if (r.kind === 'ticket_modifier') {
      expect(r.filedFare).toBe(2);
      expect(r.fop).toEqual({
        kind: 'credit_card',
        brand: 'AX',
        pan: '27391223456789',
        expiry: '1228',
      });
    }
  });

  it('TMU1FVI4111111111111111*D0530 — Visa credit card', () => {
    const r = parseGalileoEntry('TMU1FVI4111111111111111*D0530');
    expect(r.kind).toBe('ticket_modifier');
    if (r.kind === 'ticket_modifier') {
      expect(r.fop).toEqual({
        kind: 'credit_card',
        brand: 'VI',
        pan: '4111111111111111',
        expiry: '0530',
      });
    }
  });

  it('rejects bare TMU<n> with no F<form>', () => {
    expect(() => parseGalileoEntry('TMU1')).toThrow();
    expect(() => parseGalileoEntry('TMU1F')).toThrow();
  });

  it('rejects unsupported FOP form', () => {
    expect(() => parseGalileoEntry('TMU1FGR12345')).toThrow();
    expect(() => parseGalileoEntry('TMU1FBOGUS')).toThrow();
  });
});

describe('Galileo TMU dispatch — local FOP attach to filed fare', () => {
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

  function seedFiledFare(): FareQuote {
    const fq: FareQuote = {
      departureDate: '27JUN',
      validatingCarrier: 'UA',
      currency: 'USD',
      fareBasis: ['Y'],
      passengers: [
        { passengerType: 'ADT', count: 1, base: 100, taxes: [], taxTotal: 0, total: 100, fareCalc: '' },
      ],
    };
    wa.pnr.priceQuotes.push(fq);
    return fq;
  }

  it('TMU1FS sets cash FOP on filed fare 1', async () => {
    const fq = seedFiledFare();
    const resp = await host.process('TMU1FS', wa);
    expect(resp).toBe('OK-TMU1');
    expect(fq.fop).toEqual({ kind: 'cash' });
  });

  it('TMU1FNONREF sets cash + nonRefundable on filed fare 1', async () => {
    const fq = seedFiledFare();
    await host.process('TMU1FNONREF', wa);
    expect(fq.fop).toEqual({ kind: 'cash', nonRefundable: true });
  });

  it('TMU1FVI4111111111111111*D0530 sets credit card FOP', async () => {
    const fq = seedFiledFare();
    await host.process('TMU1FVI4111111111111111*D0530', wa);
    expect(fq.fop).toEqual({
      kind: 'credit_card',
      brand: 'VI',
      pan: '4111111111111111',
      expiry: '0530',
    });
  });

  it('TMU on non-existent filed fare returns NO FILED FARE <n>', async () => {
    const resp = await host.process('TMU3FS', wa);
    expect(resp).toBe('NO FILED FARE 3');
  });
});

describe('Galileo TKP — uses stored TMU FOP for live addFormOfPayment', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const searchResp = () =>
    new Response(
      JSON.stringify({
        CatalogProductOfferingsResponse: {
          CatalogProductOfferings: {
            CatalogProductOffering: [
              {
                Identifier: { value: 'OFF-001' },
                ProductBrandOptions: [
                  {
                    Flight: [
                      {
                        carrier: 'UA',
                        number: 1234,
                        Departure: { location: 'DEN', time: '2026-06-27T08:00:00Z' },
                        Arrival: { location: 'FRA', time: '2026-06-28T07:30:00Z' },
                      },
                    ],
                    ProductBrandOffering: [{ FareDetail: [{ BookingCode: { code: 'Y', count: 9 } }] }],
                  },
                ],
              },
            ],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  const createWb = () =>
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-TMU' } } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  const ok = () =>
    new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const priceResp = () =>
    new Response(
      JSON.stringify({
        PricedOffersResponse: {
          PricedOffer: [
            {
              ValidatingCarrier: 'UA',
              CurrencyCode: { value: 'USD' },
              PriceClass: { fareBasis: 'Y' },
              Price: {
                Base: { value: 100 },
                TotalTaxes: { value: 0 },
                TotalPrice: { value: 100 },
              },
            },
          ],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend({
      clientId: 'x',
      clientSecret: 'y',
      username: 'z',
      password: 'w',
    });
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
      backend,
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });

  afterEach(() => fetchSpy.mockRestore());

  it('TKP after TMU<n>F<credit card> POSTs FormOfPaymentPaymentCard canonical body', async () => {
    // Seed a filed fare directly + a workbench + a single segment so TKP can issue.
    wa.liveWorkbenchId = 'WB-TMU';
    wa.pnr.segments.push({
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
    wa.pnr.priceQuotes.push({
      departureDate: '27JUN',
      validatingCarrier: 'UA',
      currency: 'USD',
      fareBasis: ['Y'],
      passengers: [
        { passengerType: 'ADT', count: 1, base: 100, taxes: [], taxTotal: 0, total: 100, fareCalc: '' },
      ],
    });

    await host.process('TMU1FVI4111111111111111*D0530', wa);

    fetchSpy.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(ok());

    await host.process('TKP1', wa);

    const [fopUrl, fopInit] = fetchSpy.mock.calls[1];
    expect(fopUrl).toContain('/payment/reservationworkbench/WB-TMU/formofpayment');
    const body = JSON.parse((fopInit?.body as string) ?? '{}');
    expect(body.FormOfPaymentPaymentCard?.PaymentCard?.CardCode).toBe('VI');
    expect(body.FormOfPaymentPaymentCard?.PaymentCard?.CardNumber?.PlainText).toBe('4111111111111111');
    expect(body.FormOfPaymentPaymentCard?.PaymentCard?.expireDate).toBe('0530');
    expect(body.FormOfPaymentPaymentCard?.PaymentCard?.CardType).toBe('Credit');
  });

  it('TKP after TMU<n>FNONREF sets agentNonRefundableInd:true on the cash body', async () => {
    wa.liveWorkbenchId = 'WB-TMU';
    wa.pnr.segments.push({
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
    wa.pnr.priceQuotes.push({
      departureDate: '27JUN',
      validatingCarrier: 'UA',
      currency: 'USD',
      fareBasis: ['Y'],
      passengers: [
        { passengerType: 'ADT', count: 1, base: 100, taxes: [], taxTotal: 0, total: 100, fareCalc: '' },
      ],
    });

    await host.process('TMU1FNONREF', wa);

    fetchSpy.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(ok());

    await host.process('TKP1', wa);

    const [, init] = fetchSpy.mock.calls[1];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.FormOfPaymentCash?.agentNonRefundableInd).toBe(true);
  });
});
