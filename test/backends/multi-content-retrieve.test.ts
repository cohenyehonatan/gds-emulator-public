import { describe, it, expect } from 'vitest';
import { mapReservation } from '../../src/backends/travelport-mapper.js';

/**
 * Multi-content reservations (Travelport Multi-Content Booking Guide):
 * a single BF can carry air + hotel + car, returned as separate Offer
 * instances with Product types ProductAir / ProductHospitality /
 * ProductVehicle. Our retrieve mapper maps AIR only (hotel/car live
 * retrieve is a documented gap — see mapReservation + the v11 spec doc).
 *
 * This locks the REQUIRED robustness: a multi-content response must
 * still map the air content correctly and must NOT (a) crash, (b) emit
 * phantom segments from the hotel/car offers, or (c) duplicate the
 * traveler across the per-content offers. That keeps `*<locator>` on a
 * mixed BF honest about its air content instead of erroring.
 */
describe('mapReservation — multi-content (air + hotel + car) retrieve', () => {
  // GDS air + active hotel + active car, shaped per the guide: travelers
  // at reservation root; one Offer per content type; hotel/car Products
  // carry no FlightSegment.
  const MULTI_CONTENT = {
    ReservationResponse: {
      Reservation: {
        Identifier: { value: 'GZMULTI' },
        Traveler: [
          { PersonName: { Given: 'JOHN', Surname: 'SMITH' } },
        ],
        Offer: [
          {
            Product: [
              {
                type: 'ProductAir',
                FlightSegment: [
                  {
                    sequence: 1,
                    Flight: {
                      carrier: 'UA',
                      number: 1234,
                      Departure: { location: 'JFK', time: '2026-06-27T08:00:00Z' },
                      Arrival: { location: 'LAX', time: '2026-06-27T11:30:00Z' },
                      status: 'HK',
                      cabin: 'Y',
                    },
                  },
                ],
              },
            ],
          },
          {
            // ProductHospitality — no FlightSegment; must be ignored by the air mapper.
            Product: [{ type: 'ProductHospitality', Hospitality: { chain: 'HI', name: 'TEST HOTEL', status: 'HK' } }],
          },
          {
            // ProductVehicle — no FlightSegment; must be ignored by the air mapper.
            Product: [{ type: 'ProductVehicle', Vehicle: { code: 'ECAR', codeContext: 'ACRISS', status: 'HK' } }],
          },
        ],
      },
    },
  };

  it('maps the air segment and ignores the hotel/car offers without error', () => {
    const pnr = mapReservation(MULTI_CONTENT, 'GZMULTI');
    expect(pnr.locator).toBe('GZMULTI');
    // Exactly the one air segment — no phantoms from hotel/car offers.
    expect(pnr.segments).toHaveLength(1);
    expect(pnr.segments[0].carrier).toBe('UA');
    expect(pnr.segments[0].flightNumber).toBe('1234');
    expect(pnr.segments[0].origin).toBe('JFK');
    expect(pnr.segments[0].destination).toBe('LAX');
  });

  it('does not duplicate the traveler across the per-content offers', () => {
    const pnr = mapReservation(MULTI_CONTENT, 'GZMULTI');
    expect(pnr.names).toHaveLength(1);
    expect(pnr.names[0].surname).toBe('SMITH');
  });

  it('does not yet populate hotel/car segments on the live path (documented gap)', () => {
    const pnr = mapReservation(MULTI_CONTENT, 'GZMULTI');
    // Capture-first: a verified ProductHospitality/ProductVehicle mapper
    // needs a real pre-prod multi-content payload before it can be added.
    expect(pnr.hotelSegments).toHaveLength(0);
    expect(pnr.carSegments).toHaveLength(0);
  });

  it('a car-only (no air) reservation maps cleanly to an empty-air PNR', () => {
    const carOnly = {
      ReservationResponse: {
        Reservation: {
          Identifier: { value: 'GZCARONLY' },
          Traveler: [{ PersonName: { Given: 'JANE', Surname: 'DOE' } }],
          Offer: [
            { Product: [{ type: 'ProductVehicle', Vehicle: { code: 'ECAR', status: 'HK' } }] },
          ],
        },
      },
    };
    const pnr = mapReservation(carOnly, 'GZCARONLY');
    expect(pnr.locator).toBe('GZCARONLY');
    expect(pnr.segments).toHaveLength(0);
    expect(pnr.names).toHaveLength(1);
  });
});
