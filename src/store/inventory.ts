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
  // Hub legs — JFK-SFO has no nonstop, so it builds connections via ORD and DEN.
  { carrier: 'AA', flightNumber: '300', origin: 'JFK', destination: 'ORD', departTime: '800A', arriveTime: '1000A', equipment: '738', classSeats: { F: 4, J: 9, Y: 9, B: 9, M: 9 } },
  { carrier: 'AA', flightNumber: '350', origin: 'ORD', destination: 'SFO', departTime: '1130A', arriveTime: '145P', equipment: '739', classSeats: { F: 4, J: 9, Y: 9, B: 9, M: 4 } },
  { carrier: 'UA', flightNumber: '500', origin: 'JFK', destination: 'DEN', departTime: '900A', arriveTime: '1115A', equipment: '752', classSeats: { F: 2, J: 6, Y: 9, B: 9, M: 2 } },
  { carrier: 'UA', flightNumber: '550', origin: 'DEN', destination: 'SFO', departTime: '1230P', arriveTime: '200P', equipment: '320', classSeats: { F: 2, J: 6, Y: 9, B: 9, M: 9 } },
];

const MIN_CONNECT_MINUTES = 45;
const MAX_CONNECTIONS = 4;

export interface AvailabilityOptions {
  /** Show flights departing at/after this minute-of-day (from a time qualifier). */
  afterMinutes?: number;
  /** Keep only flights with this class available (from a "-Y" qualifier). */
  bookingClass?: string;
  /** Keep only these carriers (from a "¥AA" preferred-airline qualifier). */
  carriers?: string[];
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

  private seatsFor(date: string, f: ScheduledFlight): Record<string, number> {
    const k = this.key(date, f.carrier, f.flightNumber);
    if (!this.remaining.has(k)) this.remaining.set(k, { ...f.classSeats });
    return { ...this.remaining.get(k)! };
  }

  private depMin(f: ScheduledFlight): number {
    return parseClockToMinutes(f.departTime) ?? 0;
  }
  private arrMin(f: ScheduledFlight): number {
    return parseClockToMinutes(f.arriveTime) ?? 0;
  }

  /** Two-leg connections O→hub→D with a feasible same-day connection time. */
  private connectionsFor(origin: string, destination: string): ScheduledFlight[][] {
    const out: ScheduledFlight[][] = [];
    for (const a of SCHEDULE.filter((f) => f.origin === origin && f.destination !== destination)) {
      for (const b of SCHEDULE.filter((f) => f.origin === a.destination && f.destination === destination)) {
        if (b.origin === origin) continue;
        if (this.depMin(b) >= this.arrMin(a) + MIN_CONNECT_MINUTES) {
          out.push([a, b]);
          if (out.length >= MAX_CONNECTIONS) return out;
        }
      }
    }
    return out;
  }

  /**
   * Availability lines for a city pair on a date. Nonstops first (sorted by
   * departure time), then two-leg connections. Honors time/class qualifiers.
   * Connection legs share a `connectionGroup` so a '*' sell can pull them all.
   */
  availability(
    date: string,
    dayOfWeek: string,
    origin: string,
    destination: string,
    opts: AvailabilityOptions = {}
  ): AvailabilityLine[] {
    const hasClass = (f: ScheduledFlight) =>
      opts.bookingClass == null || (this.seatsFor(date, f)[opts.bookingClass] ?? 0) > 0;
    const afterOk = (f: ScheduledFlight) =>
      opts.afterMinutes == null || this.depMin(f) >= opts.afterMinutes;
    const carrierOk = (f: ScheduledFlight) =>
      opts.carriers == null || opts.carriers.includes(f.carrier);

    // Nonstops.
    const nonstops = SCHEDULE.filter((f) => f.origin === origin && f.destination === destination)
      .filter((f) => hasClass(f) && afterOk(f) && carrierOk(f))
      .sort((a, b) => this.depMin(a) - this.depMin(b));

    // Connections — online on a preferred carrier (every leg must qualify).
    const connections = this.connectionsFor(origin, destination)
      .filter((legs) => afterOk(legs[0]) && legs.every((l) => hasClass(l) && carrierOk(l)))
      .sort((x, y) => this.depMin(x[0]) - this.depMin(y[0]));

    const lines: AvailabilityLine[] = [];
    const toLine = (f: ScheduledFlight, group?: number, legIndex?: number): AvailabilityLine => ({
      line: lines.length + 1,
      carrier: f.carrier,
      flightNumber: f.flightNumber,
      classes: this.seatsFor(date, f),
      origin: f.origin,
      destination: f.destination,
      departTime: f.departTime,
      arriveTime: f.arriveTime,
      equipment: f.equipment,
      date,
      dayOfWeek,
      connectionGroup: group,
      legIndex,
    });

    for (const f of nonstops) lines.push(toLine(f));
    connections.forEach((legs, g) => legs.forEach((f, i) => lines.push(toLine(f, g + 1, i))));
    return lines;
  }

  /** Remaining seats in a class for a known flight; undefined if not tracked. */
  remainingSeats(date: string, carrier: string, flightNumber: string, bookingClass: string): number | undefined {
    const seats = this.remaining.get(this.key(date, carrier, flightNumber));
    return seats ? (seats[bookingClass] ?? 0) : undefined;
  }

  /** Return seats to a class (e.g. when a rebook moves a segment off it). */
  release(date: string, carrier: string, flightNumber: string, bookingClass: string, seats: number): void {
    const seatsByClass = this.remaining.get(this.key(date, carrier, flightNumber));
    if (seatsByClass) seatsByClass[bookingClass] = (seatsByClass[bookingClass] ?? 0) + seats;
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
