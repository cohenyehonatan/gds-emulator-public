/**
 * Manually-entered air accounting line (`AC/<…>`). Source: Sabre
 * Accounting Lines QR p.1 verbatim grammar:
 *
 *   AC/(validating carrier code)/(ticket number plus check digit)/
 *     (commission amount or percent)/(base fare)/(all taxes)/
 *     (fare application ONE, PER or ALL)/
 *     (form of payment CK, CA, CC or CX and name number and name
 *      if fare application is ONE)/(number of conjunct documents)/
 *     (tariff basis D, F or T)-(optional free text)
 *
 *   AC/UA/12345678901/P10/99.00/7.64/ONE/CCAX378700000000000 1.1ANDREWS J/1/D-INCLUDES SERVICE CHARGE
 */

/**
 * A single entry in the accounting field's change log. One is appended
 * per accept of an AC/, AC<n>/, or AC¤<…> entry. *HAC renders these
 * chronologically.
 */
export interface AccountingHistoryEntry {
  timestamp: Date;
  agent?: string;
  action: 'add' | 'modify' | 'delete';
  /** Line number affected, or 'ALL' for bulk delete. */
  lineRef: number | 'ALL';
  /** Short, human-readable summary the *HAC display surfaces. */
  detail: string;
}

export interface ManualAccountingLine {
  validatingCarrier: string;
  /** 10-or-11-digit ticket number including check digit; no airline prefix. */
  ticketNumber: string;
  /** Commission amount in fare currency, OR a percentage (when `commissionPercent` is true). */
  commission: number;
  commissionPercent: boolean;
  baseFare: number;
  taxes: number;
  fareApplication: 'ONE' | 'PER' | 'ALL';
  /** FOP code + optional inline detail (the QR's `CCAX378700000000000 1.1ANDREWS J`). */
  formOfPayment: string;
  /** "Number of conjunct documents" — small positive integer. */
  conjunctDocs: number;
  /** Tariff basis letter. D=Domestic, F=Foreign, T=Transborder. */
  tariff: 'D' | 'F' | 'T';
  /** Optional free text after the trailing dash. */
  freeText?: string;
}
