/**
 * Electronic-ticket record (the document produced by W¥ / TTP).
 *
 * Shape follows the Sabre Issue-Tickets QR's *T post-issue display:
 *   2.TE 0254692507094-AT SMITH/J C6E1*AET 2332/8FEB D
 * — TE (electronic) / TK (paper), 13-digit number (3-digit airline code +
 * 10-digit serial), stock type, passenger, PCC*agent, time/date, tariff basis.
 */

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
};

export function airlineNumericCode(carrier: string): string {
  return AIRLINE_NUMERIC[carrier.toUpperCase()] ?? '000';
}

/** Build a 13-digit ticket number: 3-digit airline code + 10-digit serial. */
export function ticketNumber(carrier: string, serial: number): string {
  return airlineNumericCode(carrier) + String(serial).padStart(10, '0');
}
