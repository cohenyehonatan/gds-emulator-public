/**
 * Frequent-flyer (FQTV) element.  (Zenon "Frequent Traveller Numbers")
 *   FFBA2345678-2.2   carrier BA, number 2345678, passenger 2.2
 * Displayed via *FF. Change/delete by line: FF1¤… / FF1¤.
 */

import type { NameRef } from './service.js';

export interface FrequentFlyer {
  carrier: string;
  number: string;
  nameRef?: NameRef;
}
