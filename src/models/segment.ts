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

import type { StatusCode } from '../protocol/constants.js';

export interface AirSegment {
  /** 1-based position in the itinerary. */
  segmentNumber: number;
  carrier: string; // e.g. "BA"
  flightNumber: string; // e.g. "192"
  bookingClass: string; // e.g. "Y"
  date: string; // Sabre date token, e.g. "23NOV"
  dayOfWeek: string; // single letter, e.g. "S"
  origin: string;
  destination: string;
  status: (typeof StatusCode)[keyof typeof StatusCode];
  seats: number;
  departTime: string; // e.g. "520P"
  arriveTime: string; // e.g. "800A"
}
