/**
 * Special Service Requests (SSR) and Other Service Information (OSI).
 *
 *   SSR (sigil 3 = other airlines, 4 = American): a coded request the carrier
 *   must action — WCHR (wheelchair), VGML (veg meal), INFT (infant), etc.
 *   Optionally associated to a passenger via a name reference (e.g. -1.1).
 *
 *   OSI (3OSI / 4OSI): low-priority info for the carrier, no action/reply.
 *
 * Carrier defaults to "YY" (all airlines) for sigil 3, "AA" for sigil 4.
 */

/** Passenger name reference: name item, optionally a passenger within it. */
export interface NameRef {
  item: number;
  passenger?: number;
}

export interface SpecialServiceRequest {
  code: string; // 4-letter SSR code, e.g. WCHR
  carrier: string; // 2-char or YY
  text?: string; // free text / data (e.g. INFT data "ANDY/MARY/09JAN11")
  nameRef?: NameRef;
  status: string; // NN requested (airline confirms HK/HN/KK asynchronously)
}

export interface OtherServiceInfo {
  carrier: string;
  text: string;
}

/** Format a name reference for display: "-1.1" or "-2". */
export function formatNameRef(ref: NameRef): string {
  return `-${ref.item}${ref.passenger != null ? '.' + ref.passenger : ''}`;
}
