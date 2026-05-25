/**
 * Air segment within a PNR itinerary.
 *
 * Display form (workbook "EXAMPLE SOLD SEGMENT"):
 *   2 BA 192Y  23NOV S DFWLHR SS1  520P  800A  24NOV M/E
 *   │  │  │  │ │     │ │      │  │  │     │     └ arrival day offset
 *   │  │  │  │ │     │ │      │  └ seats  └ dep/arr local times
 *   │  │  │  │ │     │ └ city pair (origin+dest)
 *   │  │  │  │ └ date │ └ day of week
 *   │  │  │  └ class  status code (SS sold)
 *   │  │  └ flight number
 *   │  └ carrier
 *   └ segment number in itinerary
 */

export interface AirSegment {
  /** 1-based position in the itinerary. */
  segmentNumber: number;
  carrier: string; // e.g. "BA"
  flightNumber: string; // e.g. "192"
  bookingClass: string; // e.g. "Y"
  date: string; // Sabre date token, e.g. "23NOV"
  dayOfWeek: string; // single letter, e.g. "S" (sold-segment response)
  dayOfWeekNum: number; // 1-7 ISO (stored itinerary display)
  origin: string;
  destination: string;
  status: string; // SS sold, HK confirmed, LL waitlist, … (see constants.StatusCode)
  seats: number;
  departTime: string; // e.g. "520P" (blank for open / unknown-schedule long sells)
  arriveTime: string; // e.g. "800A"
  airlineLocator?: string; // passive sell: the carrier's own record locator
  // Set only for an overnight (next-day) arrival:
  arriveDate?: string; // Sabre date token of arrival, e.g. "24NOV"
  arriveDayOfWeek?: string; // letter DOW of arrival
  arriveDayOfWeekNum?: number; // numeric DOW of arrival
}
