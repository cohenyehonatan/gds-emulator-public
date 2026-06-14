import { describe, it, expect } from 'vitest';
import { mapReservation } from '../../src/backends/travelport-mapper.js';

/**
 * Multi-content reservations (Travelport Multi-Content Booking Guide):
 * a single BF can carry air + hotel + car, returned as separate Offer
 * instances with Product @type ProductAir / ProductHospitality /
 * ProductVehicle. Per-segment status + confirmation number come from the
 * matching Receipt[] (by OfferRef + OfferStatus@type), and
 * ReservationDisplaySequence assigns global segment numbers so *I/*R
 * interleave the three types in true itinerary order.
 *
 * Fixtures below are trimmed but FAITHFUL to the guide's two worked
 * examples (GDS active hotel+car; NDC hotel+car) — the field paths the
 * mapper reads are reproduced exactly.
 */

// Example 1: GDS air (QF419 SYD-MEL seq2, QF404 MEL-SYD seq4) + active
// hotel (HILTON, 40 nights) + active car (CCMR). DisplaySequence orders
// them car(1), air(2), hotel(3), air(4).
const GDS_ACTIVE = {
  ReservationResponse: {
    Reservation: {
      Identifier: { value: '4417BK' },
      Offer: [
        {
          id: 'offer_1',
          Product: [
            { '@type': 'ProductAir', id: 'product_1', FlightSegment: [{ sequence: 2, Flight: { carrier: 'QF', number: '419', Departure: { location: 'SYD', date: '2023-08-19', time: '08:00:00' }, Arrival: { location: 'MEL', date: '2023-08-19', time: '09:35:00' } } }] },
            { '@type': 'ProductAir', id: 'product_2', FlightSegment: [{ sequence: 4, Flight: { carrier: 'QF', number: '404', Departure: { location: 'MEL', date: '2023-09-29', time: '06:15:00' }, Arrival: { location: 'SYD', date: '2023-09-29', time: '07:40:00' } } }] },
          ],
        },
        {
          id: 'offer_2',
          Product: [{
            '@type': 'ProductHospitality', id: 'product_1', guests: 2, propertyName: 'HILTON GARDEN INN HALIFAX AIRPORT', Quantity: 1,
            PropertyKey: { chainCode: 'GI', propertyCode: '75407' },
            DateRange: { start: '2024-10-20', end: '2024-10-21' },
            PropertyAddress: { City: 'HALIFAX' },
          }],
          Price: { CurrencyCode: { codeAuthority: 'AUD', decimalPlace: 2 }, Base: 189, TotalPrice: 7560, PriceBreakdown: [{ '@type': 'PriceBreakdownHospitality', NightlyRate: [{ nights: 40 }] }] },
        },
        {
          id: 'offer_3',
          Product: [{
            '@type': 'ProductVehicle', id: 'product_1', Quantity: 1,
            Vehicle: {
              VehicleMakeModel: { code: 'CCMR', vendorCode: 'ZI' },
              VehicleCategoryCode: { codeContext: 'ACRISS', value: 'C' },
              VehicleDateLocation: {
                RentalPickup: { date: '2023-08-18', time: '20:00:00', VendorLocation: { code: 'SYD', rentalLocationName: 'T', rentalLocationNumber: '01' } },
                RentalReturn: { date: '2023-08-19', time: '05:00:00', VendorLocation: { code: 'SYD' } },
              },
            },
          }],
          Price: { CurrencyCode: { decimalPlace: 2, value: 'AUD' }, PriceBreakdown: [{ '@type': 'PriceBreakdownVehiclePrice', VehiclePrice: { ApproximateRate: { BaseRate: { code: 'AUD', value: 73.74 }, EstimatedTotalAmount: { value: 121.51 } } } }] },
          TermsAndConditionsFull: [{ '@type': 'TermsAndConditionsFullVehicle', ProductRateCodeInfo: [{ RateCodeInfo: { value: '41I' } }] }],
        },
      ],
      Traveler: [
        { PersonName: { Given: 'SABBYANUJ', Surname: 'MAJI' } },
        { PersonName: { Given: 'PX CHDONEMDNM MR', Surname: 'SRNMONE CNN' } },
      ],
      Receipt: [
        { '@type': 'ReceiptConfirmation', Confirmation: { Locator: { source: '1G', value: '4417BK' }, OfferStatus: { '@type': 'OfferStatusAir', StatusAir: [{ flightRefs: ['Flight_02', 'Flight_04'], code: 'HK', value: 'Confirmed' }] } } },
        { '@type': 'ReceiptConfirmation', OfferRef: ['offer_2'], Confirmation: { Locator: { locatorType: 'CONFIRMATION_NUMBER', source: 'RT', sourceContext: 'SUPPLIER', value: '6764XHI500' }, OfferStatus: { '@type': 'OfferStatusHospitality', Status: 'Confirmed' } } },
        { '@type': 'ReceiptConfirmation', OfferRef: ['offer_3'], Confirmation: { Locator: { source: 'ZI', sourceContext: 'Supplier', value: '25432390AU4' }, OfferStatus: { '@type': 'OfferStatusVehicle', Status: 'Confirmed' } } },
      ],
      ReservationDisplaySequence: {
        DisplaySequence: [
          { displaySequence: 1, OfferRef: 'offer_3', ProductRef: 'product_1' },
          { displaySequence: 2, OfferRef: 'offer_1', ProductRef: 'product_1', Sequence: 2 },
          { displaySequence: 3, OfferRef: 'offer_2', ProductRef: 'product_1' },
          { displaySequence: 4, OfferRef: 'offer_1', ProductRef: 'product_2', Sequence: 4 },
        ],
      },
    },
  },
};

// Example 2: air (QF409 seq1, QF402 seq3) + hotel (chain RT, 4 nights, no
// Base price) + car (ECAR). DisplaySequence: air(1), hotel(2), air(3), car(4).
const NDC_PASSIVE = {
  ReservationResponse: {
    Reservation: {
      Identifier: { value: '4411L5' },
      Offer: [
        {
          id: 'Offer_1',
          Product: [
            { '@type': 'ProductAir', id: 'product_1', FlightSegment: [{ sequence: 1, Flight: { carrier: 'QF', number: '409', Departure: { location: 'SYD', date: '2023-08-19', time: '07:00:00' }, Arrival: { location: 'MEL', date: '2023-08-19', time: '08:35:00' } } }] },
            { '@type': 'ProductAir', id: 'product_2', FlightSegment: [{ sequence: 3, Flight: { carrier: 'QF', number: '402', Departure: { location: 'MEL', date: '2023-08-24', time: '06:00:00' }, Arrival: { location: 'SYD', date: '2023-08-24', time: '07:25:00' } } }] },
          ],
        },
        {
          id: 'offer_2',
          Product: [{ '@type': 'ProductHospitality', id: 'product_1', guests: 1, PropertyKey: { chainCode: 'RT' }, DateRange: { start: '2023-08-19', end: '2023-08-23' } }],
          Price: { CurrencyCode: { codeAuthority: 'AUD', decimalPlace: 2 }, TotalPrice: 187.2, PriceBreakdown: [{ '@type': 'PriceBreakdownHospitality', NightlyRate: [{ nights: 4 }] }] },
        },
        {
          id: 'offer_3',
          Product: [{
            '@type': 'ProductVehicle', id: 'product_1', Quantity: 1,
            Vehicle: {
              VehicleMakeModel: { code: 'ECAR', vendorCode: 'ZI' },
              VehicleCategoryCode: { codeContext: 'ACRISS', value: 'C' },
              VehicleDateLocation: {
                RentalPickup: { date: '2023-08-24', time: '11:00:00', VendorLocation: { code: 'SYD' } },
                RentalReturn: { date: '2023-08-24', time: '16:54:00', VendorLocation: { code: 'SYD' } },
              },
            },
          }],
          Price: { CurrencyCode: { decimalPlace: 2, value: 'AUD' }, PriceBreakdown: [{ '@type': 'PriceBreakdownVehiclePrice', VehiclePrice: { ApproximateRate: { BaseRate: { code: 'AUD', value: 1245.5 } } } }] },
        },
      ],
      Traveler: [{ PersonName: { Given: 'PX ADTONE', Surname: 'SRNMONE' } }],
      Receipt: [
        { '@type': 'ReceiptConfirmation', OfferRef: ['Offer_1'], Confirmation: { Locator: { source: 'QF', sourceContext: 'VendorLocator', value: '57CZUC' } } },
        { '@type': 'ReceiptConfirmation', Confirmation: { Locator: { source: '1G', value: '4411L5' }, OfferStatus: { '@type': 'OfferStatusAir', StatusAir: [{ flightRefs: ['Flight_01', 'Flight_03'], code: 'ZK', value: 'Pending' }] } } },
        { '@type': 'ReceiptConfirmation', OfferRef: ['offer_2'], Confirmation: { Locator: { source: 'RT', sourceContext: 'SUPPLIER', value: 'HOTEL1234' }, OfferStatus: { '@type': 'OfferStatusHospitality', Status: 'Confirmed' } } },
        { '@type': 'ReceiptConfirmation', OfferRef: ['offer_3'], Confirmation: { Locator: { source: 'ZI', sourceContext: 'Supplier', value: 'CAR12345' }, OfferStatus: { '@type': 'OfferStatusVehicle', Status: 'Confirmed' } } },
      ],
      ReservationDisplaySequence: {
        DisplaySequence: [
          { displaySequence: 1, OfferRef: 'Offer_1', ProductRef: 'product_1', Sequence: 1 },
          { displaySequence: 2, OfferRef: 'offer_2', ProductRef: 'product_1' },
          { displaySequence: 3, OfferRef: 'Offer_1', ProductRef: 'product_2', Sequence: 3 },
          { displaySequence: 4, OfferRef: 'offer_3', ProductRef: 'product_1' },
        ],
      },
    },
  },
};

describe('mapReservation — multi-content (air + hotel + car)', () => {
  it('GDS active: maps air, hotel, and car with status + confirmation', () => {
    const pnr = mapReservation(GDS_ACTIVE, '4417BK');
    expect(pnr.segments.map((s) => s.flightNumber)).toEqual(['419', '404']);
    expect(pnr.names).toHaveLength(2);

    expect(pnr.hotelSegments).toHaveLength(1);
    const h = pnr.hotelSegments[0];
    expect(h.chain).toBe('GI');
    expect(h.property).toBe('75407');
    expect(h.name).toContain('HILTON');
    expect(h.city).toBe('HALIFAX');
    expect(h.checkIn).toBe('20OCT');
    expect(h.checkOut).toBe('21OCT');
    expect(h.nights).toBe(40);
    expect(h.ratePerNight).toBe(189);
    expect(h.rooms).toBe(1);
    expect(h.status).toBe('HK');
    expect(h.confirmationNumber).toBe('6764XHI500');

    expect(pnr.carSegments).toHaveLength(1);
    const c = pnr.carSegments[0];
    expect(c.company).toBe('ZI');
    expect(c.vehicleType).toBe('CCMR');
    expect(c.category).toBe('C');
    expect(c.rateCode).toBe('41I');
    expect(c.city).toBe('SYD');
    expect(c.pickup).toBe('18AUG');
    expect(c.dropoff).toBe('19AUG');
    expect(c.days).toBe(1);
    expect(c.amount).toBe(73.74);
    expect(c.pickupTime).toBe('2000');
    expect(c.dropoffTime).toBe('0500');
    expect(c.status).toBe('HK');
    expect(c.confirmationNumber).toBe('25432390AU4');
  });

  it('GDS active: DisplaySequence assigns global numbers (car 1, air 2, hotel 3, air 4)', () => {
    const pnr = mapReservation(GDS_ACTIVE, '4417BK');
    expect(pnr.carSegments[0].segmentNumber).toBe(1);
    expect(pnr.segments[0].segmentNumber).toBe(2); // QF419
    expect(pnr.hotelSegments[0].segmentNumber).toBe(3);
    expect(pnr.segments[1].segmentNumber).toBe(4); // QF404
  });

  it('Example 2: hotel with no Base rate maps ratePerNight 0; car amount from BaseRate', () => {
    const pnr = mapReservation(NDC_PASSIVE, '4411L5');
    expect(pnr.hotelSegments[0].chain).toBe('RT');
    expect(pnr.hotelSegments[0].nights).toBe(4);
    expect(pnr.hotelSegments[0].ratePerNight).toBe(0);
    expect(pnr.hotelSegments[0].confirmationNumber).toBe('HOTEL1234');
    expect(pnr.carSegments[0].vehicleType).toBe('ECAR');
    expect(pnr.carSegments[0].amount).toBe(1245.5);
    expect(pnr.carSegments[0].rateCode).toBe(''); // no TermsAndConditions
    expect(pnr.carSegments[0].confirmationNumber).toBe('CAR12345');
    // DisplaySequence: air 1, hotel 2, air 3, car 4.
    expect(pnr.segments[0].segmentNumber).toBe(1);
    expect(pnr.hotelSegments[0].segmentNumber).toBe(2);
    expect(pnr.segments[1].segmentNumber).toBe(3);
    expect(pnr.carSegments[0].segmentNumber).toBe(4);
  });

  it('without ReservationDisplaySequence: numbers air, then hotel, then car', () => {
    const noDs = structuredClone(GDS_ACTIVE);
    delete (noDs.ReservationResponse.Reservation as any).ReservationDisplaySequence;
    const pnr = mapReservation(noDs, '4417BK');
    expect(pnr.segments.map((s) => s.segmentNumber)).toEqual([1, 2]);
    expect(pnr.hotelSegments[0].segmentNumber).toBe(3);
    expect(pnr.carSegments[0].segmentNumber).toBe(4);
  });

  it('does not duplicate travelers across the per-content offers', () => {
    const pnr = mapReservation(GDS_ACTIVE, '4417BK');
    expect(pnr.names).toHaveLength(2);
  });

  it('air-only retrieve is unaffected (no hotel/car, sequential air numbers)', () => {
    const airOnly = {
      ReservationResponse: {
        Reservation: {
          Identifier: { value: 'GZAIR' },
          Traveler: [{ PersonName: { Given: 'JOHN', Surname: 'SMITH' } }],
          Offer: [{ id: 'o1', Product: [{ '@type': 'ProductAir', id: 'p1', FlightSegment: [{ sequence: 1, Flight: { carrier: 'UA', number: '1', Departure: { location: 'JFK', date: '2026-06-27', time: '08:00:00' }, Arrival: { location: 'LAX', date: '2026-06-27', time: '11:00:00' } } }] }] }],
        },
      },
    };
    const pnr = mapReservation(airOnly, 'GZAIR');
    expect(pnr.segments).toHaveLength(1);
    expect(pnr.segments[0].segmentNumber).toBe(1);
    expect(pnr.hotelSegments).toHaveLength(0);
    expect(pnr.carSegments).toHaveLength(0);
  });
});
