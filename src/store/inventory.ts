/**
 * Seed flight inventory — the analog of pectab's flight-database.
 *
 * Drives city-pair availability ('1') and is decremented on sell ('0').
 * v1 is a small in-memory schedule; replace/extend with a richer seed or a
 * loaded dataset later. Seat counts are per booking class.
 */

import type { AvailabilityLine } from '../models/availability-result.js';
import type { SeatMap } from '../models/seat-map.js';
import { parseClockToMinutes } from '../utils/validation.js';
import { SEAT_MAP_SEED } from './seat-map-seed.js';
import type { HotelProperty } from '../models/hotel.js';
import { HOTEL_SEED } from './hotel-seed.js';
import type { CarRental } from '../models/car.js';
import { CAR_SEED } from './car-seed.js';
import { resolveMct, connectionTypeFor } from '../models/mct.js';
import { MCT_SEED } from './mct-seed.js';
import type { RailService } from '../models/rail.js';
import { RAIL_SEED } from './rail-seed.js';
import type { EmdService } from '../models/emd.js';
import { EMD_SEED } from './emd-seed.js';

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
  // AF 002 CDG-JFK + AF 001 JFK-CDG — VERBATIM from the Service Hub
  // PNR samples in solutions 797696 + 823571 ("AF 002 R 20JUN 5
  // CDGJFK HK1  0730 2E 0830 1030", "AF 001 V 30JUN 1 JFKCDG HK1
  // 1530 1  1630 0555+1"). Pairs with the AF EMD guide seed so the
  // XBAG worked example runs end-to-end.
  { carrier: 'AF', flightNumber: '002', origin: 'CDG', destination: 'JFK', departTime: '830A', arriveTime: '1030A', equipment: '77W', classSeats: { F: 2, J: 6, Y: 9, B: 9, M: 9 } },
  { carrier: 'AF', flightNumber: '001', origin: 'JFK', destination: 'CDG', departTime: '430P', arriveTime: '555A', equipment: '77W', classSeats: { F: 2, J: 6, Y: 9, B: 9, M: 9 } },
  // 6X 089 HEL-BKK — VERBATIM from the Service Hub EMD-display PNR
  // sample (solution 873296: "6X 089 Y 15JAN 5 HELBKK HK1 2 1650
  // 0735+1"). 6X is Amadeus's test airline; this flight pairs with
  // the EMD service guide seed so the TTM/EWD flow is exercisable.
  { carrier: '6X', flightNumber: '089', origin: 'HEL', destination: 'BKK', departTime: '450P', arriveTime: '735A', equipment: '359', classSeats: { F: 2, J: 6, Y: 9, B: 9, M: 9 } },
  // Hub legs — JFK-SFO has no nonstop, so it builds connections via ORD and DEN.
  { carrier: 'AA', flightNumber: '300', origin: 'JFK', destination: 'ORD', departTime: '800A', arriveTime: '1000A', equipment: '738', classSeats: { F: 4, J: 9, Y: 9, B: 9, M: 9 } },
  { carrier: 'AA', flightNumber: '350', origin: 'ORD', destination: 'SFO', departTime: '1130A', arriveTime: '145P', equipment: '739', classSeats: { F: 4, J: 9, Y: 9, B: 9, M: 4 } },
  { carrier: 'UA', flightNumber: '500', origin: 'JFK', destination: 'DEN', departTime: '900A', arriveTime: '1115A', equipment: '752', classSeats: { F: 2, J: 6, Y: 9, B: 9, M: 2 } },
  { carrier: 'UA', flightNumber: '550', origin: 'DEN', destination: 'SFO', departTime: '1230P', arriveTime: '200P', equipment: '320', classSeats: { F: 2, J: 6, Y: 9, B: 9, M: 9 } },
  // ORD-SFO departing 20 min after AA300 arrives ORD — too tight to auto-build a
  // connection, but long-sellable into a PNR so VCT* can flag the short connect.
  { carrier: 'AA', flightNumber: '360', origin: 'ORD', destination: 'SFO', departTime: '1020A', arriveTime: '1245P', equipment: '738', classSeats: { F: 4, J: 9, Y: 9, B: 9, M: 9 } },
  // DEN-FRA via KEF — mirrors the FI connection that pre-prod 7K9S serves
  // (used by validate-galileo-handler-live.ts + diff harness). Two-leg
  // connection auto-builds via the KEF hub. Adding DEN→KEF and KEF→FRA
  // legs at compatible times gives the emulated availability handler a
  // valid set to return when the diff harness runs A27JUNDENFRA.
  { carrier: 'FI', flightNumber: '670', origin: 'DEN', destination: 'KEF', departTime: '720P', arriveTime: '600A', equipment: '75W', classSeats: { F: 2, J: 4, Y: 9, N: 2 } },
  { carrier: 'FI', flightNumber: '520', origin: 'KEF', destination: 'FRA', departTime: '730A', arriveTime: '1135A', equipment: '7M9', classSeats: { F: 2, J: 4, Y: 9, N: 2 } },
];

export const MIN_CONNECT_MINUTES = 45;
const MAX_CONNECTIONS = 4;

export interface AvailabilityOptions {
  /** Show flights departing at/after this minute-of-day (from a time qualifier). */
  afterMinutes?: number;
  /** Keep only flights with this class available (from a "-Y" qualifier). */
  bookingClass?: string;
  /** Keep only these carriers (from a "¥AA" preferred-airline qualifier). */
  carriers?: string[];
  /** Nonstops/direct only (from a "/D" qualifier) — no connections. */
  directOnly?: boolean;
  /** Only connections via this hub (from a connecting-city qualifier). */
  connectingCity?: string;
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
   * Look up a seat map for a flight. `equipment` overrides the
   * schedule's equipment when given (e.g. for direct-access SM
   * queries that bypass an itinerary). Returns undefined if the
   * equipment isn't in the seed — the renderer / dispatch should
   * surface "NO SEAT MAP AVAILABLE" to the operator in that case.
   */
  seatMapFor(carrier: string, flightNumber: string, equipment?: string): SeatMap | undefined {
    let eq = equipment;
    if (!eq) eq = this.scheduleFor(carrier, flightNumber)?.equipment;
    if (!eq) return undefined;
    const cabins = SEAT_MAP_SEED[eq];
    if (!cabins) return undefined;
    return { carrier, flightNumber, equipment: eq, Cabin: cabins };
  }

  /**
   * Hotel properties in a city. Filterable by chain code. Sourced
   * from the seed in HOTEL_SEED — fictional data for emulator use.
   *
   * Returns an empty array for unknown cities so callers can surface
   * a "NO HOTELS FOUND" message rather than throwing.
   */
  hotelsIn(city: string, chain?: string): HotelProperty[] {
    const all = HOTEL_SEED.filter((h) => h.city === city);
    return chain ? all.filter((h) => h.chain === chain) : all;
  }

  /** Look up a single hotel property by chain + property code. */
  hotelByCode(chain: string, property: string): HotelProperty | undefined {
    return HOTEL_SEED.find((h) => h.chain === chain && h.property === property);
  }

  /**
   * Car rentals available in a city. Filterable by 2-letter company
   * code. Returns empty array for unknown cities so callers can
   * surface "NO CARS FOUND" without throwing.
   */
  carsIn(city: string, company?: string): CarRental[] {
    const all = CAR_SEED.filter((c) => c.city === city);
    return company ? all.filter((c) => c.company === company) : all;
  }

  /**
   * Rail services between two stations, sorted by departure time
   * (the R/AD "by departure time" ordering — also Annex-I-compatible
   * since these are all non-stop services). Empty for unseeded pairs
   * so callers surface "NO RAIL SERVICES".
   */
  /** A carrier's EMD service guide (EGSD). Empty for unseeded carriers. */
  emdServicesFor(carrier: string): EmdService[] {
    return EMD_SEED.filter((e) => e.carrier === carrier);
  }

  /**
   * Human-readable summary of every seeded market — the HELP MARKETS
   * / HE MARKETS topic, so operators can discover what this emulated
   * inventory actually serves instead of guessing city pairs.
   */
  marketsSummary(): string[] {
    const byPair = new Map<string, Set<string>>();
    for (const f of SCHEDULE) {
      const key = `${f.origin}-${f.destination}`;
      if (!byPair.has(key)) byPair.set(key, new Set());
      byPair.get(key)!.add(f.carrier);
    }
    const lines: string[] = ['AIR (city pair — carriers):'];
    for (const [pair, cxrs] of [...byPair.entries()].sort()) {
      lines.push(`  ${pair}  ${[...cxrs].sort().join(' ')}`);
    }
    lines.push('  (+ connections auto-built via hubs, e.g. JFK-SFO, DEN-FRA)');
    const hotelCities = [...new Set(HOTEL_SEED.map((h) => h.city))].sort();
    const carCities = [...new Set(CAR_SEED.map((c) => c.city))].sort();
    const railPairs = [...new Set(RAIL_SEED.map((r) => `${r.origin}-${r.destination} (${r.provider})`))].sort();
    lines.push(`HOTELS: ${hotelCities.join(' ')}`);
    lines.push(`CARS: ${carCities.join(' ')}`);
    lines.push(`RAIL: ${railPairs.join(', ')}`);
    return lines;
  }

  railBetween(origin: string, destination: string): RailService[] {
    return RAIL_SEED
      .filter((r) => r.origin === origin && r.destination === destination)
      .sort((a, b) => (parseClockToMinutes(a.departTime) ?? 0) - (parseClockToMinutes(b.departTime) ?? 0));
  }

  /**
   * Resolve the Minimum Connect Time for a connection at an airport,
   * using the layered MCT seed (airport default → carrier exception →
   * carrier-pair re-override per the OAG-documented model). Falls back
   * to MIN_CONNECT_MINUTES (45) for unseeded airports — the same value
   * the auto-connect builder uses, so DM lookups stay consistent with
   * what availability actually surfaces.
   */
  mctFor(
    airport: string,
    connectionType: import('../models/mct.js').MctConnectionType,
    carrier?: string,
    toCarrier?: string,
  ): { minutes: number; source: 'pair' | 'carrier' | 'airport' | 'fallback' } {
    return resolveMct(MCT_SEED, airport, connectionType, carrier, toCarrier, MIN_CONNECT_MINUTES);
  }

  /** All seeded MCT records for an airport (drives the DM display). */
  mctRecordsFor(airport: string): import('../models/mct.js').MctRecord[] {
    return MCT_SEED.filter((r) => r.airport === airport);
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

  /**
   * Two-leg connections O→hub→D with a feasible same-day connection
   * time. Chunk 28: the feasibility check resolves the hub's MCT
   * through the layered model with full context — connection type
   * inferred from leg countries (DD/DI/ID/II) and the arriving +
   * departing carriers, so carrier exceptions filed at seeded hubs
   * change which connections build. Unseeded hubs fall back to the
   * flat MIN_CONNECT_MINUTES (45), preserving prior behavior.
   */
  private connectionsFor(origin: string, destination: string): ScheduledFlight[][] {
    const out: ScheduledFlight[][] = [];
    for (const a of SCHEDULE.filter((f) => f.origin === origin && f.destination !== destination)) {
      for (const b of SCHEDULE.filter((f) => f.origin === a.destination && f.destination === destination)) {
        if (b.origin === origin) continue;
        const type = connectionTypeFor(a, b);
        const mct = this.mctFor(a.destination, type, a.carrier, b.carrier);
        if (this.depMin(b) >= this.arrMin(a) + mct.minutes) {
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
    dow: { letter: string; num: number },
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

    // Display ranking per Regulation (EC) No 80/2009 Annex I point 7
    // (the EU CRS Code of Conduct's neutral principal display — see
    // docs/behavior-layer-research-2026-06-09.md):
    //   (i)  non-stop travel options ranked by departure time
    //   (ii) all other travel options ranked by elapsed journey time
    // Ranking must not be based on any factor relating to carrier
    // identity — the sort keys below are time-only by construction.

    // Nonstops. A connecting-city request suppresses them (connections only).
    const nonstops =
      opts.connectingCity != null
        ? []
        : SCHEDULE.filter((f) => f.origin === origin && f.destination === destination)
            .filter((f) => hasClass(f) && afterOk(f) && carrierOk(f))
            .sort((a, b) => this.depMin(a) - this.depMin(b));

    // Elapsed journey time of a connection: last-leg arrival minus
    // first-leg departure, +24h when the journey crosses midnight
    // (clock arithmetic on minute-of-day values).
    const elapsed = (legs: ScheduledFlight[]): number => {
      const span = this.arrMin(legs[legs.length - 1]) - this.depMin(legs[0]);
      return span >= 0 ? span : span + 24 * 60;
    };

    // Connections — online on a preferred carrier (every leg must qualify).
    // Skipped entirely for a direct-only ("/D") request; filtered to a hub when
    // a connecting city is specified. Ranked by elapsed journey time
    // per Annex I point 7(ii); departure time breaks ties.
    const connections = opts.directOnly
      ? []
      : this.connectionsFor(origin, destination)
          .filter((legs) => afterOk(legs[0]) && legs.every((l) => hasClass(l) && carrierOk(l)))
          .filter((legs) => opts.connectingCity == null || legs[0].destination === opts.connectingCity)
          .sort((x, y) => elapsed(x) - elapsed(y) || this.depMin(x[0]) - this.depMin(y[0]));

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
      dayOfWeek: dow.letter,
      dayOfWeekNum: dow.num,
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

  /**
   * Initialize remaining seats for a (date, flight) pair from the static
   * SCHEDULE so a subsequent `sell()` works without the agent first having
   * browsed availability on that date. Used by cancel-and-rebook on a new
   * date. Returns false if the flight isn't in the schedule.
   */
  seedSeats(date: string, carrier: string, flightNumber: string): boolean {
    const f = this.scheduleFor(carrier, flightNumber);
    if (!f) return false;
    const k = this.key(date, carrier, flightNumber);
    if (!this.remaining.has(k)) this.remaining.set(k, { ...f.classSeats });
    return true;
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
