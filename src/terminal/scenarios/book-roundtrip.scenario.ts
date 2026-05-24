/**
 * Book a round trip end-to-end and end the transaction.
 *
 * Exercises the full core PNR lifecycle: sign in → availability → sell both
 * directions → name → phone → ticketing → received-from → ER. The final ER
 * must succeed (no "NEED ..." rejection), proving the PRINT mandatory-field
 * gate is satisfied.
 */

import type { Scenario } from './scenario.js';

export const bookRoundtripScenario: Scenario = {
  name: 'Book Round Trip',
  description: 'Sign in, book JFK-LAX and LAX-JFK, complete PNR fields, end transaction.',
  steps: [
    { entry: 'SI*4321', note: 'Sign in', expectContains: 'OK' },
    { entry: '115JUNJFKLAX', note: 'Availability outbound', expectContains: 'AA' },
    { entry: '01Y1', note: 'Sell 1 Y on line 1', expectContains: 'SS1' },
    { entry: '120JUNLAXJFK', note: 'Availability return', expectContains: 'DL' },
    { entry: '01Y1', note: 'Sell return', expectContains: 'SS1' },
    { entry: '-SMITH/JOHN MR', note: 'Name', expectContains: 'OK' },
    { entry: '9305-555-1212-H', note: 'Phone', expectContains: 'OK' },
    { entry: '7TAW15JUN/', note: 'Ticketing', expectContains: 'OK' },
    { entry: '6P', note: 'Received from', expectContains: 'OK' },
    { entry: 'ER', note: 'End transaction + redisplay', expectNotContains: 'NEED' },
  ],
};
