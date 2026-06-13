/**
 * Galileo canned host responses.
 *
 * Mirrors the structure of `dialects/sabre/responses.ts`: every string the
 * Galileo dialect emits as a canned response lives here so dialect-shared
 * handlers (when we share them) can be parameterized cleanly. Today only
 * the sign-on family lands; the file fills out as more verbs come online.
 *
 * Fidelity note: the canonical Galileo source (Travelport+ Mini Format
 * Guide v2, Oct 2025) documents the *entries* but routes responses
 * through Smartpoint pop-ups, so it doesn't publish the host text. The
 * strings below are **reconstructed** at the queue-prompt fidelity bar
 * and flagged inline. They'll be replaced verbatim when a live-1G capture
 * surfaces the real responses (the validate-travelport-creds script can
 * be extended to capture sign-on traffic against the 7K9S pre-prod
 * tenant — see ROADMAP v5).
 */

export const GalileoResponse = {
  /** Generic format / unrecognized entry — matches Sabre's `FORMAT`. */
  FORMAT: 'FORMAT', // reconstructed — Galileo's actual format-error wording isn't published
  /**
   * Session verb attempted before sign-on (area switch, etc.). No source
   * quotes the wording; follows the verified `NEED … - USE <entry>`
   * pattern and points at the Galileo sign-on entry.
   */
  NOT_SIGNED_ON: 'NEED SIGN ON - USE SON/Z', // reconstructed
  /** Empty / null fallback for handlers that can't act. */
  OK: 'OK', // reconstructed
  /** Successful ignore (Mini Guide p.18: "I — Ignore Transact"). */
  IGNORED: 'IGNORED', // reconstructed
  /**
   * End-transaction rejections — none of these strings are published in
   * the references; reconstructed shapes name the Galileo sigil the
   * agent forgot, paralleling Sabre's "USE <n>" pattern.
   */
  NEED_NAME: 'NEED NAME - USE N.', // reconstructed
  NEED_TICKETING: 'NEED TICKETING - USE T.', // reconstructed
  NEED_RECEIVED_FROM: 'NEED RECEIVED FROM - USE R.', // reconstructed
  NEED_PHONE: 'NEED PHONE - USE P.', // reconstructed
  NEED_ITINERARY: 'NEED ITINERARY', // reconstructed
  NAMES_NOT_EQUAL: 'NUMBER OF NAMES NOT EQUAL TO RESERVATIONS', // reconstructed
  /** No PNR currently in the active work area. */
  NO_PNR: 'NO BOOKING FILE', // reconstructed (Galileo uses "Booking File" not "PNR")
} as const;
