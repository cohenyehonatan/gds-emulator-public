/**
 * Electronic-ticket record (the document produced by W¥ / TTP).
 *
 * Shape follows the Sabre Issue-Tickets QR's *T post-issue display:
 *   2.TE 0254692507094-AT SMITH/J C6E1*AET 2332/8FEB D
 * — TE (electronic) / TK (paper), 13-digit number (3-digit airline code +
 * 10-digit serial), stock type, passenger, PCC*agent, time/date, tariff basis.
 */

import type { FormOfPayment } from '../protocol/entry.js';
export type { FormOfPayment };

export interface TicketRecord {
  number: string; // 13-digit (3-digit airline code + 10-digit serial)
  type: 'TE' | 'TK'; // electronic / paper
  stock: string; // ticket-type / stock code (e.g. "AT")
  passenger: string; // "SURNAME/INITIAL"
  pcc: string;
  agent?: string;
  issuedAt: Date;
  tariff: 'D' | 'I'; // domestic / international
  validatingCarrier: string;
  base: number;
  taxTotal: number;
  total: number;
  /** Commission applied at issue (W¥KP<n> percent or W¥K<amount> flat). 0 / undefined = none. */
  commission?: number;
  /**
   * Form of payment, supplied via W¥F<fop>. Surfaces in the accounting line
   * (`*PAC` display, when implemented); the `*T` field doesn't render FOP
   * per the Sabre Ticket Display Tools QR.
   */
  formOfPayment?: FormOfPayment;
  /**
   * Ticket lifecycle status. Drives the *TA / *TI split in the Ticket
   * Display Tools QR p.1: "active documents are those with an OPEN or ACTL
   * status code; inactive documents are those with any other status code"
   * (e.g. voided, refunded, exchanged). Defaults to OPEN at issuance.
   */
  status?: 'OPEN' | 'ACTL' | 'VOIDED' | 'REFUNDED' | 'EXCHANGED';
  /**
   * When the ticket was voided (status === 'VOIDED'). Drives the WV*
   * date-window queries (Sabre Middle East QR p.13). Undefined for
   * non-voided tickets and for voided tickets that predate the field.
   */
  voidedAt?: Date;
}

/** Set of statuses considered "active" for the *TA display (QR p.1). */
export const ACTIVE_STATUSES: ReadonlySet<NonNullable<TicketRecord['status']>> = new Set([
  'OPEN',
  'ACTL',
]);

/** Is this ticket "active" per the QR's *TA/*TI partition? */
export function isActiveTicket(t: TicketRecord): boolean {
  return ACTIVE_STATUSES.has(t.status ?? 'OPEN');
}


/** Three-digit airline accounting codes used as the ticket-number prefix. */
const AIRLINE_NUMERIC: Record<string, string> = {
  AA: '001',
  UA: '016',
  DL: '006',
  B6: '279',
  BA: '125',
  LH: '220',
  AS: '027',
  WN: '526',
  AF: '057',
  // 6X (Amadeus test airline) — prefix 172 per the Service Hub
  // EMD-display solution's own example: EWD/EMD172-1234567890.
  '6X': '172',
};

export function airlineNumericCode(carrier: string): string {
  return AIRLINE_NUMERIC[carrier.toUpperCase()] ?? '000';
}

/** Build a 13-digit ticket number: 3-digit airline code + 10-digit serial. */
export function ticketNumber(carrier: string, serial: number): string {
  return airlineNumericCode(carrier) + String(serial).padStart(10, '0');
}
