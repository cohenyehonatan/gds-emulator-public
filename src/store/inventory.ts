/**
 * Seed flight inventory — the analog of pectab's flight-database.
 *
 * Drives city-pair availability ('1') and is decremented on sell ('0').
 * v1 is a small in-memory schedule; replace/extend with a richer seed or a
 * loaded dataset later. Seat counts are per booking class.
 */

import type { AvailabilityLine } from '../models/availability-result.js';
import { parseClockToMinutes } from '../utils/validation.js';

export interface ScheduledFlight {
  carrier: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departTime: string;
  arriveTime: string;
  equipment: string;
  /** Default seats available per class when a date is first queried. */
  classSeats: Record<string, number>;
}

const SCHEDULE: ScheduledFlight[] = [
  { carrier: 'B6', flightNumber: '615', origin: 'JFK', destination: 'LAX', departTime: '700A', arriveTime: '1015A', equipment: '32A', classSeats: { Y: 9, B: 9, M: 9 } },
  { carrier: 'AA', flightNumber: '100', origin: 'JFK', destination: 'LAX', departTime: '800A', arriveTime: '1100A', equipment: '738', classSeats: { F: 4, J: 9, Y: 9, B: 9, M: 9 } },
  { carrier: 'UA', flightNumber: '240', origin: 'JFK', destination: 'LAX', departTime: '100P', arriveTime: '400P', equipment: '320', classSeats: { F: 2, J: 6, Y: 9, B: 9, M: 2 } },
  { carrier: 'AA', flightNumber: '180', origin: 'JFK', destination: 'LAX', departTime: '600P', arriveTime: '900P', equipment: '32B', classSeats: { F: 2, J: 4, Y: 9, B: 7, M: 9 } },
  { carrier: 'DL', flightNumber: '422', origin: 'LAX', destination: 'JFK', departTime: '900A', arriveTime: '520P', equipment: '76W', classSeats: { F: 4, J: 6, Y: 9, B: 9, M: 4 } },
  { carrier: 'AA', flightNumber: '118', origin: 'LAX', destination: 'JFK', departTime: '300P', arriveTime: '1130P', equipment: '738', classSeats: { F: 4, J: 9, Y: 9, B: 9, M: 0 } },
  { carrier: 'BA', flightNumber: '192', origin: 'DFW', destination: 'LHR', departTime: '520P', arriveTime: '800A', equipment: '777', classSeats: { F: 4, J: 9, Y: 9, B: 5, M: 0 } },
];

export interface AvailabilityOptions {
  /** Show flights departing at/after this minute-of-day (from a time qualifier). */
  afterMinutes?: number;
  /** Keep only flights with this class available (from a "-Y" qualifier). */
  bookingClass?: string;
}

export class Inventory {
  /** date|carrier|flightNumber -> remaining seats per class. */
  private remaining = new Map<string, Record<string, number>>();

  private key(date: string, carrier: string, flightNumber: string): string {
    return `${date}|${carrier}|${flightNumber}`;
  }

  /** Look up a scheduled flight (for filling times on a long sell). */
  scheduleFor(carrier: string, flightNumber: string): ScheduledFlight | undefined {
    return SCHEDULE.find((f) => f.carrier === carrier && f.flightNumber === flightNumber);
  }

  /**
   * Availability lines for a city pair on a date, sorted by departure time.
   * Honors an optional time qualifier (start at/after) and class qualifier.
   */
  availability(
    date: string,
    dayOfWeek: string,
    origin: string,
    destination: string,
    opts: AvailabilityOptions = {}
  ): AvailabilityLine[] {
    let flights = SCHEDULE.filter((f) => f.origin === origin && f.destination === destination);

    // Materialize remaining seats and sort by departure time.
    flights = flights
      .slice()
      .sort((a, b) => (parseClockToMinutes(a.departTime) ?? 0) - (parseClockToMinutes(b.departTime) ?? 0));

    if (opts.afterMinutes != null) {
      flights = flights.filter((f) => (parseClockToMinutes(f.departTime) ?? 0) >= opts.afterMinutes!);
    }

    return flights
      .map((f) => {
        const k = this.key(date, f.carrier, f.flightNumber);
        if (!this.remaining.has(k)) this.remaining.set(k, { ...f.classSeats });
        return { f, seats: { ...this.remaining.get(k)! } };
      })
      .filter(({ seats }) => opts.bookingClass == null || (seats[opts.bookingClass] ?? 0) > 0)
      .map(({ f, seats }, i) => ({
        line: i + 1,
        carrier: f.carrier,
        flightNumber: f.flightNumber,
        classes: seats,
        origin: f.origin,
        destination: f.destination,
        departTime: f.departTime,
        arriveTime: f.arriveTime,
        equipment: f.equipment,
        date,
        dayOfWeek,
      }));
  }

  /** Decrement seats for a sold flight. Returns false if not enough seats. */
  sell(date: string, carrier: string, flightNumber: string, bookingClass: string, seats: number): boolean {
    const k = this.key(date, carrier, flightNumber);
    const seatsByClass = this.remaining.get(k);
    if (!seatsByClass || (seatsByClass[bookingClass] ?? 0) < seats) return false;
    seatsByClass[bookingClass] -= seats;
    return true;
  }
}
