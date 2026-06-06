import { describe, it, expect } from 'vitest';
import { mapReservation } from '../../src/backends/travelport-mapper.js';

const FULL_FIXTURE = {
  Reservation: {
    Identifier: { value: 'ABC123' },
    Traveler: [
      {
        passengerTypeCode: 'ADT',
        PersonName: { Given: 'JOHN', Surname: 'SMITH' },
        Telephone: [{ phoneNumber: '+44-208-555-1212', role: 'Mobile' }],
      },
      {
        passengerTypeCode: 'ADT',
        PersonName: { Given: 'JANE', Surname: 'SMITH' },
      },
    ],
    AirReservation: {
      Flights: [
        {
          carrier: 'UA',
          number: 1234,
          Departure: { location: 'DEN', time: '2026-06-27T08:00:00Z' },
          Arrival: { location: 'FRA', time: '2026-06-28T07:30:00Z' },
          status: 'HK',
          cabin: 'Y',
        },
        {
          carrier: 'UA',
          number: 5678,
          Departure: { location: 'FRA', time: '2026-07-04T10:00:00Z' },
          Arrival: { location: 'DEN', time: '2026-07-04T13:30:00Z' },
          cabin: 'Y',
        },
      ],
    },
  },
};

describe('mapReservation', () => {
  it('stamps the locator from the input (not the response)', () => {
    const pnr = mapReservation(FULL_FIXTURE, 'OVERRIDE');
    expect(pnr.locator).toBe('OVERRIDE');
  });

  it('extracts every Traveler into NameItem[] with surname + first name', () => {
    const pnr = mapReservation(FULL_FIXTURE, 'ABC123');
    expect(pnr.names).toHaveLength(2);
    expect(pnr.names[0].surname).toBe('SMITH');
    expect(pnr.names[0].passengers[0].firstName).toBe('JOHN');
    expect(pnr.names[1].passengers[0].firstName).toBe('JANE');
  });

  it('extracts AirReservation.Flights into AirSegment[] with carrier/flight/route/times', () => {
    const pnr = mapReservation(FULL_FIXTURE, 'ABC123');
    expect(pnr.segments).toHaveLength(2);
    expect(pnr.segments[0]).toMatchObject({
      segmentNumber: 1,
      carrier: 'UA',
      flightNumber: '1234',
      bookingClass: 'Y',
      origin: 'DEN',
      destination: 'FRA',
      departTime: '0800',
      arriveTime: '0730',
      status: 'HK',
    });
    expect(pnr.segments[0].date).toBe('27JUN');
    expect(pnr.segments[1].origin).toBe('FRA');
    expect(pnr.segments[1].destination).toBe('DEN');
  });

  it('extracts Telephone entries from each traveler into pnr.phones', () => {
    const pnr = mapReservation(FULL_FIXTURE, 'ABC123');
    expect(pnr.phones).toHaveLength(1);
    expect(pnr.phones[0].number).toBe('+44-208-555-1212');
  });

  it('returns a Pnr with just the locator when the response is empty', () => {
    const pnr = mapReservation({}, 'EMPTY1');
    expect(pnr.locator).toBe('EMPTY1');
    expect(pnr.names).toHaveLength(0);
    expect(pnr.segments).toHaveLength(0);
    expect(pnr.phones).toHaveLength(0);
  });

  it('returns a Pnr with just the locator when response is null/undefined', () => {
    expect(mapReservation(null, 'A').locator).toBe('A');
    expect(mapReservation(undefined, 'B').locator).toBe('B');
  });

  it('tolerates the wrapped shape (OrderReservationResponse.Reservation)', () => {
    const wrapped = { OrderReservationResponse: { Reservation: FULL_FIXTURE.Reservation } };
    const pnr = mapReservation(wrapped, 'WRAPPED');
    expect(pnr.names).toHaveLength(2);
    expect(pnr.segments).toHaveLength(2);
  });

  it('drops a flight that lacks required fields', () => {
    const bad = {
      Reservation: {
        AirReservation: {
          Flights: [
            { carrier: 'UA' }, // no number, no departure/arrival
            {
              carrier: 'UA',
              number: 999,
              Departure: { location: 'JFK', time: '2026-06-01T10:00:00Z' },
              Arrival: { location: 'LAX', time: '2026-06-01T13:00:00Z' },
            },
          ],
        },
      },
    };
    const pnr = mapReservation(bad, 'X');
    expect(pnr.segments).toHaveLength(1);
    expect(pnr.segments[0].flightNumber).toBe('999');
  });

  it('tolerates a flat BookingSegment shape (newer access groups)', () => {
    const flat = {
      Reservation: {
        BookingSegment: [
          {
            carrier: 'AA',
            number: 100,
            bookingClass: 'F',
            status: 'HK',
            Departure: { location: 'JFK', time: '2026-06-27T08:00:00Z' },
            Arrival: { location: 'LAX', time: '2026-06-27T11:00:00Z' },
          },
        ],
      },
    };
    const pnr = mapReservation(flat, 'FLAT01');
    expect(pnr.segments).toHaveLength(1);
    expect(pnr.segments[0].carrier).toBe('AA');
    expect(pnr.segments[0].bookingClass).toBe('F');
  });

  it('captures phones from PrimaryContact too', () => {
    const withContact = {
      Reservation: {
        PrimaryContact: [{ Telephone: [{ phoneNumber: '+1-800-555-0100' }] }],
        Traveler: [{ PersonName: { Given: 'X', Surname: 'Y' } }],
      },
    };
    const pnr = mapReservation(withContact, 'C');
    expect(pnr.phones).toHaveLength(1);
    expect(pnr.phones[0].number).toBe('+1-800-555-0100');
  });

  it('canonical pre-prod retrieve shape: ReservationResponse + Offer[].Product[].FlightSegment[].Flight', () => {
    // VERIFIED PRE-PROD 2026-06-06: live retrieve returns
    //   { ReservationResponse: { Reservation: {
    //       Identifier, Offer[Product[FlightSegment[Flight]]], Traveler, ... } } }
    // — segments live nested several layers deep inside each Offer's
    // Products, NOT on a flat AirReservation.Flights[]. mapReservation
    // unwraps ReservationResponse, then mapReservationSegments walks
    // Offer[].Product[].FlightSegment[] in sequence order.
    const response = {
      ReservationResponse: {
        Reservation: {
          Identifier: { authority: 'Travelport', value: '<wb-uuid>' },
          Traveler: [{
            passengerTypeCode: 'ADT',
            PersonName: { '@type': 'PersonName', Given: 'JOHN', Surname: 'SMITH' },
          }],
          Offer: [{
            Product: [{
              FlightSegment: [
                {
                  sequence: 1,
                  Flight: {
                    carrier: 'FI', number: '672', equipment: '75W',
                    Departure: { location: 'DEN', date: '2026-07-06', time: '20:10:00' },
                    Arrival: { location: 'KEF', date: '2026-07-07', time: '06:00:00' },
                  },
                },
                {
                  sequence: 2,
                  Flight: {
                    carrier: 'FI', number: '524', equipment: '7M8',
                    Departure: { location: 'KEF', date: '2026-07-07', time: '07:30:00' },
                    Arrival: { location: 'FRA', date: '2026-07-07', time: '11:35:00' },
                  },
                },
              ],
            }],
          }],
        },
      },
    };
    const pnr = mapReservation(response, 'GZTZ5L');
    expect(pnr.locator).toBe('GZTZ5L');
    expect(pnr.names).toHaveLength(1);
    expect(pnr.names[0].surname).toBe('SMITH');
    expect(pnr.names[0].passengers[0].firstName).toBe('JOHN');
    expect(pnr.segments).toHaveLength(2);
    expect(pnr.segments[0].carrier).toBe('FI');
    expect(pnr.segments[0].flightNumber).toBe('672');
    expect(pnr.segments[0].origin).toBe('DEN');
    expect(pnr.segments[0].destination).toBe('KEF');
    expect(pnr.segments[1].carrier).toBe('FI');
    expect(pnr.segments[1].flightNumber).toBe('524');
  });
});
