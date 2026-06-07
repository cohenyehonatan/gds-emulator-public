/**
 * Mailing / billing address element on a PNR.
 *
 * Amadeus QRG p.38 distinguishes:
 *   AM        mailing address (kind: 'mailing')
 *   AM/H      home mailing (subtype: 'home')
 *   AM/D      delivery mailing (subtype: 'delivery')
 *   AM/M      miscellaneous mailing (subtype: 'misc')
 *   AB        billing address (kind: 'billing')
 *
 * Both AM and AB accept the same body shape: free-text NAME,ADDRESS,
 * CITY (or a structured form with /CY-COMPANY/NA-NAME/A1-LINE etc.).
 * v1 stores the body verbatim — structured-form decomposition can come
 * later if Sabre or Galileo need it too. Optional passenger binding via
 * NameRef.
 */

import type { NameRef } from './service.js';

export type AddressKind = 'mailing' | 'billing';
export type AddressSubtype = 'standard' | 'home' | 'delivery' | 'misc';

export interface AddressElement {
  kind: AddressKind;
  subtype: AddressSubtype;
  text: string;
  nameRef?: NameRef;
}
