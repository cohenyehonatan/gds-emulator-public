/**
 * Passenger Name Record — the "document" being assembled in the work area
 * (analogous to the printer emulator's mag-stripe document).
 *
 * The PRINT rule (workbook): a PNR needs Phone, Received-from, Itinerary,
 * Name, Ticketing before End Transaction will commit it. `missingMandatory()`
 * returns which of those are absent; the end-tx handler maps each to a canned
 * host response.
 */

import type { AirSegment } from './segment.js';
import type { NameItem } from './name-element.js';
import type { PhoneElement } from './phone-element.js';
import type { SpecialServiceRequest, OtherServiceInfo } from './service.js';
import type { RemarkElement } from './remark.js';
import type { FrequentFlyer } from './frequent-flyer.js';
import type { FareQuote } from './fare.js';
import type { TicketRecord } from './ticket.js';
import type { ManualAccountingLine, AccountingHistoryEntry } from './manual-accounting.js';
import type { AddressElement } from './address.js';
import { MandatoryField, type MandatoryFieldKey } from '../protocol/constants.js';

/**
 * One row in `Pnr.history` — a single mutation event. v1 carries a
 * timestamp + free-text description. The description is what `*H`
 * renders; structured per-field diffs can be added later without
 * breaking the surface.
 */
export interface HistoryEntry {
  timestamp: Date;
  text: string;
}

export class Pnr {
  locator?: string;
  names: NameItem[] = [];
  segments: AirSegment[] = [];
  phones: PhoneElement[] = [];
  ssrs: SpecialServiceRequest[] = [];
  osis: OtherServiceInfo[] = [];
  remarks: RemarkElement[] = [];
  frequentFlyers: FrequentFlyer[] = [];
  /**
   * Mailing / billing address elements (Amadeus AM / AB). Empty for
   * Sabre and Galileo today — added for v4 Amadeus parity (QRG p.38)
   * but the model is dialect-agnostic and any dialect can populate it.
   */
  addresses: AddressElement[] = [];
  priceQuotes: FareQuote[] = []; // stored PQ records (one per passenger type)
  tickets: TicketRecord[] = []; // issued e-ticket records (W¥ / TTP)
  /**
   * Manually-entered air accounting lines (`AC/<carrier>/<tkt>/…`).
   * Rendered alongside the auto-generated lines from tickets in *PAC.
   * Source: Sabre Accounting Lines QR p.1.
   */
  manualAccountingLines: ManualAccountingLine[] = [];
  /**
   * Chronological log of changes to the accounting field. Surfaces via
   * `*HAC` (Sabre Accounting Lines QR p.1 "Display history of accounting
   * field data"). Append-only; entries don't get rewritten by subsequent
   * modify/delete actions.
   */
  accountingHistory: AccountingHistoryEntry[] = [];
  /**
   * Chronological mutation log for the BF. Each entry records a single
   * change (sell, cancel, name add, status update, …). Append-only,
   * never rewritten. Surfaces via Galileo `*H` (which v11 REST doesn't
   * expose). v11 has no change-log endpoint, so this is purely
   * client-side — the log only reflects mutations routed through this
   * emulator session.
   */
  history: HistoryEntry[] = [];
  /**
   * Set of 1-indexed accounting-line numbers that have been deleted via
   * `AC¤<n>` / `AC¤ALL` / `AC¤<range>`. Filtered out by *PAC. The deletion
   * is a soft-delete on the auto-generated view of pnr.tickets — the
   * underlying ticket record stays, so *T still surfaces it.
   */
  accountingLinesHidden: Set<number> = new Set();
  ticketing?: string;
  optionField?: string; // time-limit / option field (sigil 8)
  receivedFrom?: string;
  createdAt?: Date;

  /** Seat-occupying passengers (infants don't occupy a seat). */
  passengerCount(): number {
    return this.names.filter((n) => !n.infant).reduce((sum, n) => sum + n.count, 0);
  }

  /** Renumber segments 1..N after a cancellation. */
  renumberSegments(): void {
    this.segments.forEach((s, i) => (s.segmentNumber = i + 1));
  }

  /** Deep-ish copy (for dividing a PNR). */
  clone(): Pnr {
    const p = new Pnr();
    p.locator = this.locator;
    p.names = this.names.map((n) => ({ ...n, passengers: n.passengers.map((pa) => ({ ...pa })) }));
    p.segments = this.segments.map((s) => ({ ...s }));
    p.phones = this.phones.map((x) => ({ ...x }));
    p.ssrs = this.ssrs.map((x) => ({ ...x }));
    p.osis = this.osis.map((x) => ({ ...x }));
    p.remarks = this.remarks.map((x) => ({ ...x }));
    p.frequentFlyers = this.frequentFlyers.map((x) => ({ ...x }));
    p.addresses = this.addresses.map((x) => ({ ...x }));
    p.priceQuotes = [...this.priceQuotes];
    p.tickets = this.tickets.map((t) => ({ ...t }));
    p.manualAccountingLines = this.manualAccountingLines.map((m) => ({ ...m }));
    p.accountingHistory = this.accountingHistory.map((h) => ({ ...h }));
    p.history = this.history.map((h) => ({ ...h }));
    p.accountingLinesHidden = new Set(this.accountingLinesHidden);
    p.ticketing = this.ticketing;
    p.optionField = this.optionField;
    p.receivedFrom = this.receivedFrom;
    p.createdAt = this.createdAt;
    return p;
  }

  /** True once at least one field has been added (work area is dirty). */
  hasContent(): boolean {
    return (
      this.names.length > 0 ||
      this.segments.length > 0 ||
      this.phones.length > 0 ||
      this.ssrs.length > 0 ||
      this.osis.length > 0 ||
      this.remarks.length > 0 ||
      this.frequentFlyers.length > 0 ||
      this.ticketing !== undefined ||
      this.optionField !== undefined ||
      this.receivedFrom !== undefined
    );
  }

  /** Which PRINT mandatory fields are still missing, in display order. */
  missingMandatory(): MandatoryFieldKey[] {
    const missing: MandatoryFieldKey[] = [];
    if (this.phones.length === 0) missing.push(MandatoryField.PHONE);
    if (this.receivedFrom === undefined) missing.push(MandatoryField.RECEIVED_FROM);
    if (this.segments.length === 0) missing.push(MandatoryField.ITINERARY);
    if (this.names.length === 0) missing.push(MandatoryField.NAME);
    if (this.ticketing === undefined) missing.push(MandatoryField.TICKETING);
    return missing;
  }

  isComplete(): boolean {
    return this.missingMandatory().length === 0;
  }
}
