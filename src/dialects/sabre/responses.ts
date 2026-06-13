/**
 * Sabre canned host responses.
 *
 * Lives under `dialects/sabre/` because every string here is Sabre-specific
 * wording the dialect owns — future dialects (`galileo`, `amadeus`) bring
 * their own response constants alongside their own parser/serializer.
 *
 * End-transaction rejections are now grounded in the Sabre Basic Course
 * (Ed. 1.0, © 2016 Sabre Inc., p.53 "Some Error Responses Upon End
 * Transaction" — see references/sabre-eot-error-responses.md). The phone,
 * ticketing, and name-count strings are verbatim from that source. The
 * source list has no received-from / no-names / no-itinerary message, so
 * those three remain reconstructed (received-from follows the verified
 * "NEED … - USE <n>" pattern; the other two are best-effort).
 */

export const Response = {
  // Verified verbatim (Sabre Basic Course p.53):
  NEED_PHONE: 'NEED PHONE FIELD - USE 9',
  NEED_TICKETING: 'NEED TICKETING/TIMELIMIT - USE 7 OR 8',
  NAMES_NOT_EQUAL: 'NUMBER OF NAMES NOT EQUAL TO RESERVATIONS',
  // Reconstructed — not present in the source error list:
  NEED_RECEIVED_FROM: 'NEED RECEIVED FROM - USE 6',
  NEED_ITINERARY: 'NEED ITINERARY',
  NEED_NAME: 'NO NAMES IN PNR',
  // General:
  FORMAT: 'FORMAT', // generic unrecognized/invalid entry
  NEED_SIGN_ON: 'NEED SIGN ON - USE SI', // reconstructed — session verb before sign-on; follows the NEED…-USE pattern
  RECORD_LOCATOR_NOT_FOUND: 'RECORD LOCATOR NOT FOUND', // TODO: confirm
  NO_PNR: 'NO PNR IN AAA', // TODO: confirm — nothing in the work area
  NO_ITINERARY: 'NO ITINERARY', // TODO: confirm — cancel/status with no segments
  SEGMENT_NOT_FOUND: 'SEGMENT NUMBER NOT IN ITINERARY', // TODO: confirm
  INVALID_STATUS: 'INVALID STATUS CODE', // TODO: confirm
  IGNORED: 'IGNORED',
  OK: 'OK',
} as const;
