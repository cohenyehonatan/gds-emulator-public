/**
 * Sabre cryptic-entry constants.
 *
 * Source of truth: references/Sabre-Basic-Reservation-Course.pdf
 * ("Working in the Sabre System", Training Workbook Ed. 2.7, © Sabre Inc.).
 * The Sabre System Keyboard Quick Reference (workbook p.6) maps each leading
 * key (sigil) to a function. v1 implements the core PNR-lifecycle subset.
 */

export const DEFAULT_PORT = 9600;

/**
 * Entry sigils — the leading key of a cryptic entry. Multi-char sigils
 * (SI, SO, IG, ER, ET) must be matched longest-first in the parser.
 */
export const Sigil = {
  AVAILABILITY: '1', //  1: City pair availability   e.g. 122JANFRAMAD
  FLIGHT_INFO: '2', //   2: Flight information (FLIFO)  — later phase
  SELL: '0', //          0: Sell segment             e.g. 01Y1
  NAME: '-', //          -: Passenger name           e.g. -ALONSO/EDITH
  PHONE: '9', //         9: Phone number             e.g. 9415-555-2121-H
  TICKETING: '7', //     7: Ticketing arrangement    e.g. 7TAW22JAN/
  RECEIVED_FROM: '6', // 6: Received from            e.g. 6NIGEL
  REMARKS: '5', //       5: Remarks                  — later phase
  DISPLAY: '*', //       *: Display / retrieve       e.g. *ABCDEF, *-SANCHEZ, *A
  CHANGE: '¤', //   ¤: Change/delete key        e.g. 91¤214-555-2121-H — later phase
  SEGMENT_STATUS: '.', //.: Change segment status    e.g. .1HK — later phase
  // Multi-char:
  SIGN_IN: 'SI',
  SIGN_OUT: 'SO',
  IGNORE: 'IG',
  IGNORE_SHORT: 'I',
  END_REDISPLAY: 'ER',
  END_TX: 'ET',
  END: 'E',
} as const;

/** Segment action/status codes (subset). See workbook "Change Segment Status". */
export const StatusCode = {
  SS: 'SS', // sold (direct sell response)
  HK: 'HK', // holds confirmed
  LL: 'LL', // waitlisted
  GK: 'GK', // passive — confirmed elsewhere
  NN: 'NN', // need (long-sell request)
} as const;

/**
 * Mandatory PNR fields for End Transaction — the PRINT rule (workbook p.~,
 * "P- Phone  R- Received From  I- Itinerary  N- Name  T- Ticketing").
 */
export const MandatoryField = {
  PHONE: 'PHONE',
  RECEIVED_FROM: 'RECEIVED_FROM',
  ITINERARY: 'ITINERARY',
  NAME: 'NAME',
  TICKETING: 'TICKETING',
} as const;
export type MandatoryFieldKey = (typeof MandatoryField)[keyof typeof MandatoryField];

/**
 * Canned host responses. The exact wording for several of these still needs
 * to be pinned against the PDF / Format Finder; marked TODO where inferred.
 */
export const Response = {
  // End-transaction mandatory-field rejections:
  NEED_PHONE: 'NEED PHONE FIELD - USE 9', // TODO: confirm exact wording vs PDF
  NEED_RECEIVED_FROM: 'NEED RECEIVED FROM - USE 6',
  NEED_ITINERARY: 'NEED ITINERARY', // TODO: confirm
  NEED_NAME: 'NO NAMES IN PNR', // TODO: confirm
  NEED_TICKETING: 'NEED TICKETING FIELD - USE 7', // TODO: confirm
  // General:
  FORMAT: 'FORMAT', // generic unrecognized/invalid entry
  RECORD_LOCATOR_NOT_FOUND: 'RECORD LOCATOR NOT FOUND', // TODO: confirm
  NO_PNR: 'NO PNR IN AAA', // TODO: confirm — nothing in the work area
  IGNORED: 'IGNORED',
  OK: 'OK',
} as const;
