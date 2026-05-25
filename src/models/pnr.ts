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
import { MandatoryField, type MandatoryFieldKey } from '../protocol/constants.js';

export class Pnr {
  locator?: string;
  names: NameItem[] = [];
  segments: AirSegment[] = [];
  phones: PhoneElement[] = [];
  ssrs: SpecialServiceRequest[] = [];
  osis: OtherServiceInfo[] = [];
  remarks: RemarkElement[] = [];
  frequentFlyers: FrequentFlyer[] = [];
  priceQuotes: FareQuote[] = []; // stored PQ records (one per passenger type)
  tickets: TicketRecord[] = []; // issued e-ticket records (W¥ / TTP)
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
    p.priceQuotes = [...this.priceQuotes];
    p.tickets = this.tickets.map((t) => ({ ...t }));
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
