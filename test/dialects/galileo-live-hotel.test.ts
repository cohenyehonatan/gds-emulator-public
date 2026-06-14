import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { mapHotelSearch, mapHotelAvailability, mapHotelReservation } from '../../src/backends/travelport-mapper.js';
import type { WorkArea } from '../../src/session/work-area.js';
import { SessionEvent } from '../../src/session/session-state.js';

/**
 * Live HOA via the Travelport Stays API v11 (chunk 2 of
 * docs/live-stays-wiring.md). The request body is verified against the
 * Stays v11.34 spec AND pre-prod (7K9S accepts it); the RESPONSE mapping
 * is spec-derived (the trial tenant 500s on hotel content), so these
 * tests exercise the wiring + mapper against mocked spec-shaped responses.
 */

// Spec-shaped PropertiesResponse (the search 200 body, PropertiesResponseWrapper):
// Properties.PropertyInfo[].{Property: PropertyDetail, LowestAvailableRate}.
const PROPS_RESPONSE = {
  PropertiesResponse: {
    Properties: {
      '@type': 'Properties',
      PropertyInfo: [
        {
          '@type': 'PropertyInfo',
          availability: 'Available',
          LowestAvailableRate: { value: 189, code: 'EUR' },
          Property: {
            '@type': 'PropertyDetail',
            PropertyKey: { chainCode: 'HN', propertyCode: 'PAR1' },
            name: 'HILTON PARIS OPERA',
            Address: { City: 'PAR', AddressLine: ['108 RUE SAINT-LAZARE'] },
          },
        },
        {
          '@type': 'PropertyInfo',
          LowestAvailableRate: { value: 145, code: 'EUR' },
          Property: {
            '@type': 'PropertyDetail',
            PropertyKey: { chainCode: 'HI', propertyCode: 'PAR2' },
            name: 'HOLIDAY INN PARIS OPERA',
            Address: { City: 'PAR' },
          },
        },
      ],
    },
  },
};

describe('mapHotelSearch — Stays PropertiesResponse → HotelProperty[]', () => {
  it('maps PropertyInfo[].Property (PropertyKey + name + city) + LowestAvailableRate', () => {
    const props = mapHotelSearch(PROPS_RESPONSE, 'PAR');
    expect(props).toHaveLength(2);
    expect(props[0].chain).toBe('HN');
    expect(props[0].property).toBe('PAR1');
    expect(props[0].name).toBe('HILTON PARIS OPERA');
    expect(props[0].city).toBe('PAR');
    expect(props[0].address).toBe('108 RUE SAINT-LAZARE');
    expect(props[0].rates[0]).toMatchObject({ amount: 189, currency: 'EUR' });
  });

  it('maps REAL DEN capture entries (verified 2026-06-15: 100 props, open + closed)', () => {
    // Trimmed verbatim from a live DEN search (stays-den-search.json): an
    // OPEN property with a rate and a CLOSED one without (the "Rates
    // unavailable for 57 properties" case). Confirms the spec-derived
    // field paths against real data.
    const real = { PropertiesResponse: { Properties: { PropertyInfo: [
      { '@type': 'PropertyInfo', id: 'GE-E7437', availability: 'Open',
        LowestAvailableRate: { value: 609, code: 'USD' },
        Property: { '@type': 'PropertyDetail', PropertyKey: { chainCode: 'GE', propertyCode: 'E7437' },
          name: 'Gaylord Rockies Resort and Convention Center',
          Address: { City: 'Aurora', AddressLine: ['6700 North Gaylord Rockies Boulevard'] } } },
      { '@type': 'PropertyInfo', id: 'WI-B2095', availability: 'Close',
        Property: { '@type': 'PropertyDetail', PropertyKey: { chainCode: 'WI', propertyCode: 'B2095' },
          name: 'The Westin Denver International Airport',
          Address: { City: 'Denver', AddressLine: ['8300 Pena Boulevard'] } } },
    ] } } };
    const props = mapHotelSearch(real, 'DEN');
    expect(props).toHaveLength(2);
    expect(props[0]).toMatchObject({ chain: 'GE', property: 'E7437', city: 'Aurora' });
    expect(props[0].name).toContain('Gaylord');
    expect(props[0].rates[0]).toMatchObject({ amount: 609, currency: 'USD' }); // open → rate
    expect(props[1]).toMatchObject({ chain: 'WI', property: 'B2095', city: 'Denver' });
    expect(props[1].rates).toHaveLength(0); // closed → no rate (HOA shows RQ)
  });

  it('a property with no LowestAvailableRate maps to empty rates (→ HOA shows RQ)', () => {
    const r = { PropertiesResponse: { Properties: { PropertyInfo: [
      { Property: { PropertyKey: { chainCode: 'MC', propertyCode: 'X' }, name: 'M HOTEL', Address: { City: 'PAR' } } },
    ] } } };
    expect(mapHotelSearch(r, 'PAR')[0].rates).toHaveLength(0);
  });

  it('falls back to the searched city when Address.City is absent', () => {
    const r = { PropertiesResponse: { Properties: { PropertyInfo: [
      { Property: { PropertyKey: { chainCode: 'HN', propertyCode: 'Y' }, name: 'N' } },
    ] } } };
    expect(mapHotelSearch(r, 'LON')[0].city).toBe('LON');
  });
});

// Real-shaped availability 200 body (HOC), trimmed VERBATIM from a live DEN
// rate-detail capture (stays-den-avail.json, Westin DEN, 48 offerings):
// CatalogOfferingsHospitalityResponse.CatalogOfferings.CatalogOffering[].
const AVAIL_RESPONSE = {
  CatalogOfferingsHospitalityResponse: {
    '@type': 'CatalogOfferingsResponseHospitality',
    CatalogOfferings: {
      '@type': 'CatalogOfferings',
      totalCatalogOffering: 2,
      CatalogOffering: [
        {
          '@type': 'CatalogOfferingHospitality',
          id: 'off-1',
          Identifier: { value: '3f215c9f-e05b-45ba-984c-bfb3b784681a:75e9666108f2', authority: 'TVPT' },
          ProductOptions: [
            {
              '@type': 'ProductOptions',
              Product: [
                {
                  '@type': 'ProductHospitalityOffer',
                  bookingCode: 'A00H18A',
                  RoomType: {
                    '@type': 'RoomType',
                    Description: { value: 'AAA Caa Hot Deals, Membership Card Required, Prepay In Full, Traditional, Guest Room, 1 King' },
                  },
                },
              ],
            },
          ],
          Price: {
            '@type': 'PriceDetail',
            CurrencyCode: { value: 'USD' },
            Base: 910.1,
            TotalTaxes: 143.34,
            TotalPrice: 1053.44,
            PriceBreakdown: [
              { '@type': 'PriceBreakdownHospitality', roomPricingType: 'Per night', AverageNightlyRate: [{ value: 455.05, code: 'USD', approximateInd: true }] },
            ],
          },
          TermsAndConditions: { '@type': 'TermsAndConditions', ProductRateCodeInfo: [{ '@type': 'ProductRateCodeInfo', RateCodeInfo: { rateCategory: 'Association' } }] },
        },
        {
          '@type': 'CatalogOfferingHospitality',
          id: 'off-2',
          Identifier: { value: 'aa11bb22:cc33dd44', authority: 'TVPT' },
          ProductOptions: [
            {
              '@type': 'ProductOptions',
              Product: [
                {
                  '@type': 'ProductHospitalityOffer',
                  bookingCode: 'X00PJNX',
                  RoomType: { '@type': 'RoomType', Description: { value: 'Parking, Deluxe, Guest Room, 2 Queen, High Floor' } },
                },
              ],
            },
          ],
          Price: {
            '@type': 'PriceDetail',
            CurrencyCode: { value: 'USD' },
            Base: 1708,
            TotalTaxes: 269.01,
            TotalPrice: 1977.01,
            PriceBreakdown: [
              { '@type': 'PriceBreakdownHospitality', roomPricingType: 'Per night', AverageNightlyRate: [{ value: 854, code: 'USD' }] },
            ],
          },
          TermsAndConditions: { '@type': 'TermsAndConditions', ProductRateCodeInfo: [{ '@type': 'ProductRateCodeInfo', RateCodeInfo: { rateCategory: 'Package' } }] },
        },
      ],
    },
    Result: { '@type': 'Result', Warning: [{ '@type': 'Warning', StatusCode: 404, Message: 'Rates returned without cancel policy require a rule request for complete information' }] },
  },
};

describe('mapHotelAvailability — Stays CatalogOfferings → HotelRateDetail[]', () => {
  it('maps each CatalogOffering (real DEN shape, verified 2026-06-14)', () => {
    const rates = mapHotelAvailability(AVAIL_RESPONSE);
    expect(rates).toHaveLength(2);
    expect(rates[0]).toMatchObject({
      bookingCode: 'A00H18A',
      base: 910.1,
      total: 1053.44,
      averageNightly: 455.05,
      currency: 'USD',
      category: 'Association',
    });
    expect(rates[0].description).toContain('Membership Card Required');
    expect(rates[0].offerId).toBe('3f215c9f-e05b-45ba-984c-bfb3b784681a:75e9666108f2');
    expect(rates[1]).toMatchObject({ bookingCode: 'X00PJNX', total: 1977.01, category: 'Package' });
  });

  it('tolerates a missing rate-code / breakdown (category + avg undefined)', () => {
    const minimal = { CatalogOfferingsHospitalityResponse: { CatalogOfferings: { CatalogOffering: [
      { Identifier: { value: 'x' }, ProductOptions: [{ Product: [{ bookingCode: 'B', RoomType: { Description: { value: 'D' } } }] }],
        Price: { CurrencyCode: { value: 'USD' }, Base: 100, TotalPrice: 120 } },
    ] } } };
    const rates = mapHotelAvailability(minimal);
    expect(rates[0]).toMatchObject({ bookingCode: 'B', total: 120, currency: 'USD' });
    expect(rates[0].averageNightly).toBeUndefined();
    expect(rates[0].category).toBeUndefined();
  });

  it('an empty offering list maps to no rates', () => {
    expect(mapHotelAvailability({ CatalogOfferingsHospitalityResponse: { CatalogOfferings: { CatalogOffering: [] } } })).toHaveLength(0);
  });
});

// Real-shaped book 200 body, trimmed VERBATIM from the live DEN booking the
// build probe created then cancelled (stays-den-build.json, locator GZWS3Q):
// ReservationResponse.Reservation.{Offer[].Product[], Receipt[].Confirmation}.
const BOOK_RESPONSE = {
  ReservationResponse: {
    Reservation: {
      '@type': 'Reservation',
      Offer: [
        {
          '@type': 'OfferHospitality',
          Identifier: { value: '3b336969-41e3-4e76-aa2d-1882cd1b947c:e2ab997d', authority: 'TVPT' },
          Product: [
            {
              '@type': 'ProductHospitality',
              Quantity: 1,
              bookingCode: '100A261',
              propertyName: 'The Westin Denver International Airport',
              associatedCityCode: 'DEN',
              associatedAirportCode: 'DEN',
              PropertyKey: { '@type': 'PropertyKey', chainCode: 'WI', propertyCode: 'B2095' },
              DateRange: { start: '2026-07-14', end: '2026-07-16' },
              RoomType: { value: 'Bedroom Suite, Bedroom 1: 1 King, Bedroom 2: 1 King' },
            },
          ],
          Price: {
            '@type': 'PriceDetail',
            CurrencyCode: { value: 'USD', decimalPlace: 2 },
            Base: 1938,
            TotalTaxes: 305.24,
            TotalPrice: 2243.24,
            PriceBreakdown: [
              { '@type': 'PriceBreakdownHospitality' },
              { '@type': 'PriceBreakdownHospitality', AverageNightlyRate: [{ value: 969, code: 'USD' }] },
            ],
          },
        },
      ],
      Traveler: [{ '@type': 'Traveler', id: 'T1', PersonName: { '@type': 'PersonName', Prefix: 'MR', Given: 'JOHN', Surname: 'SMITH' } }],
      Receipt: [
        { '@type': 'Receipt', OfferRef: ['O1'], Confirmation: { '@type': 'Confirmation', Locator: { value: '92113579', locatorType: 'Confirmation Number', source: 'WI', sourceContext: 'Supplier' }, OfferStatus: { '@type': 'OfferStatusHospitality', code: 'HK', Status: 'Confirmed' } } },
        { '@type': 'Receipt', OfferRef: ['O1'], Confirmation: { '@type': 'Confirmation', Locator: { value: '14537482', locatorType: 'IATA Number' }, OfferStatus: { '@type': 'OfferStatusHospitality', Status: 'Confirmed' } } },
        { '@type': 'Receipt', Confirmation: { '@type': 'Confirmation', Locator: { value: 'GZWS3Q', locatorType: 'PNR Locator', sourceContext: 'Travelport' }, OfferStatus: { '@type': 'OfferStatusHospitality', Status: 'Confirmed' } } },
      ],
    },
  },
};

describe('mapHotelReservation — Stays ReservationResponse → HotelSegment + locator', () => {
  it('maps the real DEN booking shape (verified 2026-06-14 against GZWS3Q)', () => {
    const { segment, locator } = mapHotelReservation(BOOK_RESPONSE);
    expect(segment).toMatchObject({
      chain: 'WI', property: 'B2095', city: 'DEN',
      checkIn: '14JUL', checkOut: '16JUL', nights: 2,
      rateCode: '100A261', ratePerNight: 969, currency: 'USD',
      rooms: 1, status: 'HK', confirmationNumber: '92113579',
    });
    expect(segment.name).toContain('Westin');
    expect(locator).toBe('GZWS3Q'); // the PNR Locator, not the supplier/IATA numbers
  });
});

describe('Galileo live hotel SELL — Stays build (one-shot confirmed booking)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;
  const tokenResp = () =>
    new Response(JSON.stringify({ access_token: 'T', token_type: 'Bearer', expires_in: 3600 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  // Live N. spins up an air workbench (createWorkbench reads
  // ReservationResponse.Reservation.Identifier.value) — even for a
  // hotel-only flow, where the workbench then goes unused by the
  // standalone Stays build.
  const WORKBENCH = { ReservationResponse: { Reservation: { Identifier: { value: 'WB1' } } } };

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend({ clientId: 'x', clientSecret: 'y', username: 'z', password: 'w' });
    host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });
  afterEach(() => fetchSpy.mockRestore());

  // HOA (token+search) → HOC1 (avail, caches the offerIds). 3 live calls.
  async function driveToRateDisplay() {
    fetchSpy
      .mockResolvedValueOnce(tokenResp())
      .mockResolvedValueOnce(json(PROPS_RESPONSE))   // HOA search
      .mockResolvedValueOnce(json(AVAIL_RESPONSE));  // HOC availability
    await host.process('HOA6FEB-09FEBPAR2', wa);
    await host.process('HOC1', wa);
  }

  it('N1A1 after HOC books the rate + surfaces the real confirmation + locator', async () => {
    await driveToRateDisplay();
    fetchSpy.mockResolvedValueOnce(json(WORKBENCH)).mockResolvedValueOnce(json(BOOK_RESPONSE));
    await host.process('N.SMITH/JOHN MR', wa);            // createWorkbench
    await host.process('F.CCVI4111111111111111/D1230', wa); // no live call
    const resp = await host.process('N1A1', wa);          // build (book)

    expect(resp).toContain('HOTEL SOLD');
    expect(resp).toContain('WI');
    expect(resp).toContain('92113579');                  // supplier confirmation
    expect(resp).toContain('HOTEL CONFIRMED - LOCATOR GZWS3Q');
    expect(wa.pnr.hotelSegments).toHaveLength(1);
    expect(wa.pnr.hotelSegments[0]).toMatchObject({ chain: 'WI', status: 'HK', confirmationNumber: '92113579' });

    // The build request: verified endpoint + offer + traveler + card guarantee.
    const [url, init] = fetchSpy.mock.calls[4];
    expect(String(url)).toContain('/hotel/book/reservations/build');
    const body = JSON.parse((init?.body as string) ?? '{}');
    const rb = body.ReservationQueryBuild.ReservationBuild;
    expect(rb['@type']).toBe('ReservationBuildFromCatalogOffering');
    expect(rb.Traveler[0].PersonName.Surname).toBe('SMITH');
    expect(rb.Traveler[0].PersonName.Given).toBe('JOHN');
    expect(rb.BuildFromCatalogOfferingHospitality.CatalogOfferingIdentifier.value)
      .toBe('3f215c9f-e05b-45ba-984c-bfb3b784681a:75e9666108f2'); // AVAIL_RESPONSE offer[0]
    const card = rb.FormOfPayment[0].PaymentCard;
    expect(card.CardCode).toBe('VI');
    expect(card.CardNumber.PlainText).toBe('4111111111111111');
    expect(card.expireDate).toBe('1230'); // MMYY
  });

  it('N1A1 without a prior HOC (no offerId) → NEED RATE DISPLAY', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(json(PROPS_RESPONSE)).mockResolvedValueOnce(json(WORKBENCH));
    await host.process('HOA6FEB-09FEBPAR2', wa); // HOA only — no HOC
    await host.process('N.SMITH/JOHN MR', wa);   // createWorkbench
    await host.process('F.CCVI4111111111111111/D1230', wa);
    expect(await host.process('N1A1', wa)).toBe('NEED RATE DISPLAY - USE HOC');
  });

  it('N1A1 with no name on the BF → NEED NAME', async () => {
    await driveToRateDisplay();
    await host.process('F.CCVI4111111111111111/D1230', wa); // no name entered
    expect(await host.process('N1A1', wa)).toBe('NEED NAME - USE N.');
  });

  it('N1A1 with no form of payment → NEED FORM OF PAYMENT (mirrors the live 400)', async () => {
    await driveToRateDisplay();
    fetchSpy.mockResolvedValueOnce(json(WORKBENCH));
    await host.process('N.SMITH/JOHN MR', wa);
    expect(await host.process('N1A1', wa)).toBe('NEED FORM OF PAYMENT - USE F.');
  });

  it('N1A9 (rate line out of range) → INVALID LINE', async () => {
    await driveToRateDisplay();
    fetchSpy.mockResolvedValueOnce(json(WORKBENCH));
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('F.CCVI4111111111111111/D1230', wa);
    expect(await host.process('N1A9', wa)).toBe('INVALID LINE');
  });
});

// Real-shaped passive 200 body, trimmed from the live DEN passive sell the
// probe created then cancelled (stays-den-passive.json, locator GZWS4M):
// status MK, the supplier confirmation we supplied echoed back.
const PASSIVE_RESPONSE = {
  ReservationResponse: {
    Reservation: {
      '@type': 'Reservation',
      Offer: [
        {
          '@type': 'Offer',
          passiveOfferInd: true,
          Product: [
            {
              '@type': 'ProductHospitality',
              bookingCode: 'PASSIVE',
              passiveBookingReasonCode: 'G',
              propertyName: 'GRAND PLAZA DEN',
              associatedCityCode: 'HDQ',
              PropertyKey: { '@type': 'PropertyKey' },
              DateRange: { start: '2026-07-14', end: '2026-07-16' },
            },
          ],
          Price: { '@type': 'PriceDetail', CurrencyCode: { value: 'USD' }, Base: 0, TotalPrice: 0 },
        },
      ],
      Traveler: [{ '@type': 'Traveler', PersonName: { '@type': 'PersonName', Surname: 'SMITH', Given: 'JOHN' } }],
      Receipt: [
        { '@type': 'ReceiptConfirmation', Confirmation: { '@type': 'ConfirmationHold', Locator: { value: 'XYZ789', locatorType: 'Confirmation Number', sourceContext: 'Supplier' }, OfferStatus: { '@type': 'OfferStatusHospitality', code: 'MK', Status: 'Confirmed' } } },
        { '@type': 'ReceiptConfirmation', Confirmation: { '@type': 'ConfirmationHold', Locator: { value: 'GZWS4M', locatorType: 'PNR Locator', sourceContext: 'Travelport' }, OfferStatus: { '@type': 'OfferStatusHospitality', Status: 'Confirmed' } } },
      ],
    },
  },
};

describe('Galileo live hotel PASSIVE sell — Stays /passive (0HTL…MK)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;
  const tokenResp = () =>
    new Response(JSON.stringify({ access_token: 'T', token_type: 'Bearer', expires_in: 3600 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const WORKBENCH = { ReservationResponse: { Reservation: { Identifier: { value: 'WB1' } } } };

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend({ clientId: 'x', clientSecret: 'y', username: 'z', password: 'w' });
    host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });
  afterEach(() => fetchSpy.mockRestore());

  it('0HTL…MK/CF- records the external booking + surfaces status MK + locator', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResp())          // token (lazy, on N.)
      .mockResolvedValueOnce(json(WORKBENCH))      // N. → createWorkbench
      .mockResolvedValueOnce(json(PASSIVE_RESPONSE)); // 0HTL…MK → bookHotelPassive
    await host.process('N.SMITH/JOHN MR', wa);
    const resp = await host.process('0HTLHHMK1DEN14JUL-OUT16JUL/H-GRAND PLAZA/CF-XYZ789', wa);

    expect(resp).toContain('HOTEL SOLD');
    expect(resp).toContain('MK');
    expect(resp).toContain('XYZ789');                       // supplier confirmation echoed
    expect(resp).toContain('HOTEL CONFIRMED - LOCATOR GZWS4M');
    expect(wa.pnr.hotelSegments).toHaveLength(1);
    expect(wa.pnr.hotelSegments[0]).toMatchObject({ chain: 'HH', city: 'DEN', status: 'MK', confirmationNumber: 'XYZ789' });

    // Verified passive request: PropertyAddress (not PropertyKey), concrete
    // Receipt @types, the supplier confirmation in the Locator.
    const [url, init] = fetchSpy.mock.calls[2];
    expect(String(url)).toContain('/hotel/book/reservations/passive');
    const body = JSON.parse((init?.body as string) ?? '{}');
    const offer = body.ReservationDetail.Offer[0];
    expect(offer['@type']).toBe('Offer');
    expect(offer.Product[0].PropertyAddress).toBeDefined();
    expect(offer.Product[0].PropertyKey).toBeUndefined();   // external → no GDS key
    const receipt = body.ReservationDetail.Receipt[0];
    expect(receipt['@type']).toBe('ReceiptConfirmation');
    expect(receipt.Confirmation['@type']).toBe('ConfirmationHold');
    expect(receipt.Confirmation.Locator.value).toBe('XYZ789');
    expect(receipt.Confirmation.Locator.locatorType).toBe('Confirmation Number');
  });

  it('0HTL…MK without /CF- (no confirmation) → NEED CONFIRMATION', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(json(WORKBENCH));
    await host.process('N.SMITH/JOHN MR', wa);
    expect(await host.process('0HTLHHMK1DEN14JUL-OUT16JUL/H-GRAND PLAZA', wa)).toBe('NEED CONFIRMATION - USE /CF-');
  });

  it('0HTL…MK with no name on the BF → NEED NAME', async () => {
    // No N. → no workbench call; the passive sell rejects before going live.
    expect(await host.process('0HTLHHMK1DEN14JUL-OUT16JUL/CF-XYZ789', wa)).toBe('NEED NAME - USE N.');
  });
});

describe('Galileo live hotel CANCEL — Stays canceloffer (X<n>)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;
  const tokenResp = () =>
    new Response(JSON.stringify({ access_token: 'T', token_type: 'Bearer', expires_in: 3600 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  // canceloffer returns the reservation with the offer flipped to Cancelled.
  const cancelResp = () =>
    new Response(JSON.stringify({ ReservationResponse: { Reservation: { Receipt: [{ Confirmation: { OfferStatus: { Status: 'Cancelled' } } }] } } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend({ clientId: 'x', clientSecret: 'y', username: 'z', password: 'w' });
    host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
    // Simulate a retrieved committed BF: a locator + a hotel segment carrying
    // its offer id (what mapReservation captures) + supplier confirmation, and
    // the FSM in DISPLAYED (the RETRIEVE event a real *<locator> would fire).
    wa.machine.transition(SessionEvent.RETRIEVE);
    wa.pnr.locator = 'GZWS4M';
    wa.pnr.hotelSegments = [{
      segmentNumber: 1, chain: 'WI', property: 'B2095', name: 'WESTIN DEN', city: 'DEN',
      checkIn: '14JUL', checkOut: '16JUL', nights: 2, rateCode: '', ratePerNight: 0,
      currency: 'USD', rooms: 1, status: 'HK', confirmationNumber: '92113628',
      offerId: 'OFFER-UUID-1',
    }];
  });
  afterEach(() => fetchSpy.mockRestore());

  it('X<n> fires the Stays canceloffer (locator + offerID + supplierLocator) + drops the segment', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(cancelResp());
    const resp = await host.process('X1', wa);
    expect(resp).toBe('HOTEL CANCELLED');
    expect(wa.pnr.hotelSegments).toHaveLength(0);

    const [url, init] = fetchSpy.mock.calls[1];
    expect(init?.method).toBe('PUT');
    expect(String(url)).toContain('/hotel/book/reservations/GZWS4M/canceloffer');
    expect(String(url)).toContain('offerID=OFFER-UUID-1');
    expect(String(url)).toContain('supplierLocator=92113628');
  });

  it('X<n> with no captured offer id → LIVE OFFER ID MISSING (no fetch)', async () => {
    wa.pnr.hotelSegments[0].offerId = undefined;
    expect(await host.process('X1', wa)).toBe('LIVE OFFER ID MISSING');
  });

  it('X<n> on an uncommitted hotel (no locator) → FINISH OR IGNORE', async () => {
    wa.pnr.locator = undefined;
    expect(await host.process('X1', wa)).toBe('FINISH OR IGNORE');
  });

  // A committed BF with BOTH an air segment (seg 1) and the hotel (seg 2).
  const withAirSegment = () => {
    wa.pnr.hotelSegments[0].segmentNumber = 2;
    wa.pnr.segments = [{
      segmentNumber: 1, carrier: 'AA', flightNumber: '100', bookingClass: 'Y', date: '14JUL',
      dayOfWeek: 'M', dayOfWeekNum: 1, origin: 'JFK', destination: 'DEN', status: 'HK',
      seats: 1, departTime: '900A', arriveTime: '1100A',
    }];
  };

  it('XI cancels BOTH air (cancelReservation) and hotel (canceloffer) — gap closed', async () => {
    withAirSegment();
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(cancelResp()).mockResolvedValueOnce(cancelResp());
    const resp = await host.process('XI', wa);
    expect(resp).toBe('ITINERARY CANCELLED');
    expect(wa.pnr.hotelSegments).toHaveLength(0);
    expect(wa.pnr.segments).toHaveLength(0);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/hotel/book/reservations/GZWS4M/canceloffer'))).toBe(true);
    expect(urls.some((u) => u.includes('/air/receipt/reservations/GZWS4M/receipts'))).toBe(true);
  });

  it('mixed X<air>.<hotel> cancels both in one entry — gap closed', async () => {
    withAirSegment();
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(cancelResp()).mockResolvedValueOnce(cancelResp());
    const resp = await host.process('X1.2', wa); // air 1 + hotel 2
    expect(resp).toBe('ITINERARY CANCELLED');
    expect(wa.pnr.hotelSegments).toHaveLength(0);
    expect(wa.pnr.segments).toHaveLength(0);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/canceloffer'))).toBe(true); // hotel
  });

  it('a bad number in a mixed selection rejects BEFORE cancelling anything', async () => {
    withAirSegment();
    // X1.9 — 1 is air, 9 is neither: must reject with no live call + no removal.
    expect(await host.process('X1.9', wa)).toBe('SEGMENT NUMBER NOT IN ITINERARY');
    expect(wa.pnr.hotelSegments).toHaveLength(1);
    expect(wa.pnr.segments).toHaveLength(1);
    expect(fetchSpy.mock.calls.length).toBe(0); // no token, no cancel
  });
});

describe('Galileo live HOA — Stays hotel search', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;
  const tokenResp = () =>
    new Response(JSON.stringify({ access_token: 'T', token_type: 'Bearer', expires_in: 3600 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  const searchResp = (body: unknown = PROPS_RESPONSE) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const availResp = (body: unknown = AVAIL_RESPONSE) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend({ clientId: 'x', clientSecret: 'y', username: 'z', password: 'w' });
    host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });
  afterEach(() => fetchSpy.mockRestore());

  it('HOA hits /hotel/search/properties/search with ISO dates + renders the live list', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(searchResp());
    const resp = await host.process('HOA6FEB-09FEBPAR2', wa);
    expect(resp).toContain('HOTEL AVAILABILITY PAR');
    expect(resp).toContain('HILTON PARIS OPERA');
    expect(resp).toContain('189EUR');

    // The request: verified endpoint + body shape + DDMON→ISO conversion.
    const [url, init] = fetchSpy.mock.calls[1];
    expect(String(url)).toContain('/hotel/search/properties/search');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.PropertiesQuerySearch['@type']).toBe('PropertiesQuerySearch');
    expect(body.PropertiesQuerySearch.SearchBy.SearchAirport).toBe('PAR');
    expect(body.PropertiesQuerySearch.CheckInDate).toMatch(/^\d{4}-02-06$/);
    expect(body.PropertiesQuerySearch.CheckOutDate).toMatch(/^\d{4}-02-09$/);
    expect(body.PropertiesQuerySearch.RoomStayCandidate[0].GuestCounts.GuestCount[0].count).toBe(2);

    // Cached for the follow-on reference sell, just like the emulated path.
    expect(wa.lastHotelAvail?.properties).toHaveLength(2);
  });

  it('HOI is a DIRECTORY: full property list (availableOnly=false), no rate column', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(searchResp());
    const resp = await host.process('HOIDEN', wa); // index, no dates
    expect(resp).toContain('HOTEL INDEX DEN');
    expect(resp).toContain('HILTON PARIS OPERA');
    expect(resp).not.toContain('189'); // index shows NO rate, even though the data carries one
    // Index requests the full directory (not just bookable) + defaults a
    // near-future window (the search requires dates).
    const body = JSON.parse((fetchSpy.mock.calls[1][1]?.body as string) ?? '{}');
    expect(body.PropertiesQuerySearch.SearchBy.SearchAirport).toBe('DEN');
    expect(body.PropertiesQuerySearch.returnOnlyAvailablePropertiesInd).toBe(false);
    expect(body.PropertiesQuerySearch.CheckOutDate > body.PropertiesQuerySearch.CheckInDate).toBe(true);
  });

  it('HOA requests only bookable properties (availableOnly=true) + shows rates', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(searchResp());
    const resp = await host.process('HOA6FEB-09FEBPAR2', wa);
    expect(resp).toContain('189EUR'); // availability shows the rate
    const body = JSON.parse((fetchSpy.mock.calls[1][1]?.body as string) ?? '{}');
    expect(body.PropertiesQuerySearch.returnOnlyAvailablePropertiesInd).toBe(true);
  });

  it('HOI<city>/<chain> filters the live results by chain', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(searchResp());
    const resp = await host.process('HOIDEN/HN', wa);
    expect(resp).toContain('HILTON PARIS OPERA'); // chain HN
    expect(resp).not.toContain('HOLIDAY INN'); // chain HI filtered out
  });

  it('HOA…/GEO-<lat>,<lng> searches by geolocation (the code-free path)', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(searchResp());
    // Estes Park, CO — no IATA code; only lat/long reaches it.
    const resp = await host.process('HOA17JUN-22JUN/GEO-40.3772,-105.5217', wa);
    expect(resp).toContain('HOTEL AVAILABILITY 40.3772,-105.5217 17JUN-22JUN');
    expect(resp).toContain('HILTON PARIS OPERA');
    const body = JSON.parse((fetchSpy.mock.calls[1][1]?.body as string) ?? '{}');
    expect(body.PropertiesQuerySearch.SearchBy['@type']).toBe('SearchByGeoLocation');
    expect(body.PropertiesQuerySearch.SearchBy.Latitude).toBe(40.3772);
    expect(body.PropertiesQuerySearch.SearchBy.Longitude).toBe(-105.5217);
    expect(body.PropertiesQuerySearch.SearchBy.SearchAirport).toBeUndefined();
  });

  it('negative latitude (Southern Hemisphere) parses through the /GEO-- double dash', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(searchResp());
    // Sydney: lat is negative, so the entry reads "/GEO--33.8688,..." — the
    // /GEO- delimiter's own dash plus the value's minus sign.
    await host.process('HOA17JUN-22JUN/GEO--33.8688,151.2093', wa);
    const body = JSON.parse((fetchSpy.mock.calls[1][1]?.body as string) ?? '{}');
    expect(body.PropertiesQuerySearch.SearchBy.Latitude).toBe(-33.8688);
    expect(body.PropertiesQuerySearch.SearchBy.Longitude).toBe(151.2093);
  });

  it('a live search with no properties → NO HOTELS', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(
      searchResp({ PropertiesResponse: { Properties: { PropertyInfo: [] } } })
    );
    expect(await host.process('HOA6FEB-09FEBPAR2', wa)).toBe('NO HOTELS');
  });

  it('tolerates the "Rates unavailable for N properties" warning + still lists hotels', async () => {
    // Verified pre-prod 2026-06-15: DEN returned ~56 properties alongside an
    // informational "[?/99] Rates unavailable for 56 properties" Result
    // message. postJson would have thrown on that Message and aborted a
    // good search; postJsonRaw must let it through so the mapper runs.
    const withWarning = {
      PropertiesResponse: {
        Result: { Error: [{ Message: 'Rates unavailable for 56 properties', StatusCode: 99 }] },
        Properties: PROPS_RESPONSE.PropertiesResponse.Properties,
      },
    };
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(searchResp(withWarning));
    const resp = await host.process('HOA6FEB-09FEBPAR2', wa);
    expect(resp).not.toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('HILTON PARIS OPERA');
    expect(wa.lastHotelAvail?.properties).toHaveLength(2);
  });

  it('a property lacking a rate renders RQ (rate on request), not Infinity', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(
      searchResp({ PropertiesResponse: { Properties: { PropertyInfo: [
        { Property: { PropertyKey: { chainCode: 'MC', propertyCode: 'P' }, name: 'MARRIOTT PARIS', Address: { City: 'PAR' } } },
      ] } } })
    );
    const resp = await host.process('HOA6FEB-09FEBPAR2', wa);
    expect(resp).toContain('MARRIOTT PARIS');
    expect(resp).toContain('RQ');
    expect(resp).not.toContain('Infinity');
  });

  it('HOC<line> is its own REST call — full rate detail for the cached property', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResp())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(availResp());
    await host.process('HOA6FEB-09FEBPAR2', wa); // caches 2 properties
    const resp = await host.process('HOC1', wa); // complete availability for line 1

    // Header is the property; body is every bookable rate (not the lone search rate).
    expect(resp).toContain('HNPAR1 HILTON PARIS OPERA');
    expect(resp).toContain('A00H18A');
    expect(resp).toContain('1053.44 USD');
    expect(resp).toContain('AVG 455.05');
    expect(resp).toContain('Association');
    expect(resp).toContain('Membership Card Required'); // the description line
    expect(resp).toContain('X00PJNX'); // second rate
    expect(resp).toContain('Package');

    // The availability call: verified endpoint, property key, dates, occupancy.
    const [url, init] = fetchSpy.mock.calls[2];
    expect(String(url)).toContain('/hotel/availability/catalogofferingshospitality');
    const body = JSON.parse((init?.body as string) ?? '{}');
    const crit = body.CatalogOfferingsQueryRequest.CatalogOfferingsRequest[0];
    expect(crit['@type']).toBe('CatalogOfferingsRequestHospitality');
    expect(crit.StayDates).toMatchObject({ start: expect.stringMatching(/-02-06$/), end: expect.stringMatching(/-02-09$/) });
    const pk = crit.HotelSearchCriterion.PropertyRequest[0].PropertyKey;
    expect(pk).toMatchObject({ chainCode: 'HN', propertyCode: 'PAR1' });
    expect(crit.HotelSearchCriterion.RoomStayCandidates.RoomStayCandidate[0].GuestCounts.GuestCount[0].count).toBe(2);
  });

  it('HOC before any hotel display → NO HOTEL DISPLAY (no live call)', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp());
    expect(await host.process('HOC1', wa)).toBe('NO HOTEL DISPLAY');
  });

  it('HOC on an out-of-range line → INVALID LINE', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(searchResp());
    await host.process('HOA6FEB-09FEBPAR2', wa);
    expect(await host.process('HOC9', wa)).toBe('INVALID LINE');
  });

  it('HOC where the property has zero live rate offerings → NO RATES AVAILABLE', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResp())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(availResp({ CatalogOfferingsHospitalityResponse: { CatalogOfferings: { CatalogOffering: [] } } }));
    await host.process('HOA6FEB-09FEBPAR2', wa);
    const resp = await host.process('HOC1', wa);
    expect(resp).toContain('HNPAR1 HILTON PARIS OPERA');
    expect(resp).toContain('NO RATES AVAILABLE');
  });
});
