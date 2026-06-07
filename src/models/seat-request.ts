/**
 * Seat assignment / preference element on a PNR.
 *
 * Amadeus QRG p.40 "Seat Requests and Maps":
 *   ST/12C/P2/S5      specific seat 12C for pax 2 on segment 5
 *   ST/RQST/18B/P2/S5 request (advance booking) for specific seat
 *   ST/WB/P3          preference: window/bulkhead, pax 3
 *   ST/NSSA           preference: non-smoking aisle, all pax
 *
 * v1 captures the seat label (when specific) OR the preference code
 * (when symbolic) — both stored as `code`. Segment + passenger
 * references are optional and follow the canonical NameRef + segment-
 * number conventions used elsewhere.
 *
 * Cancellation:
 *   SX                 cancel ALL seat elements
 *   SX/S<n>            cancel all seats on segment n
 *   XE<element-num>    cancel by element number (deferred — element-
 *                      number addressing is a v5 generalisation)
 */

import type { NameRef } from './service.js';

export interface SeatRequest {
  /**
   * Either the specific seat label (e.g. "12C") or the preference
   * code (e.g. "WB", "NSSA"). The dispatch handler doesn't validate
   * — anything past the leading `ST/` slot rides through.
   */
  code: string;
  /** Optional segment binding (`/S<n>`). undefined = all segments. */
  segment?: number;
  /** Optional passenger binding (`/P<n>[.<m>]`). undefined = all pax. */
  nameRef?: NameRef;
}
