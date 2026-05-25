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
import { MandatoryField, type MandatoryFieldKey } from '../protocol/constants.js';

export class Pnr {
  locator?: string;
  names: NameItem[] = [];
  segments: AirSegment[] = [];
  phones: PhoneElement[] = [];
  ssrs: SpecialServiceRequest[] = [];
  osis: OtherServiceInfo[] = [];
  ticketing?: string;
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

  /** True once at least one field has been added (work area is dirty). */
  hasContent(): boolean {
    return (
      this.names.length > 0 ||
      this.segments.length > 0 ||
      this.phones.length > 0 ||
      this.ssrs.length > 0 ||
      this.osis.length > 0 ||
      this.ticketing !== undefined ||
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
