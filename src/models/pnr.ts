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
import type { NameElement } from './name-element.js';
import type { PhoneElement } from './phone-element.js';
import { MandatoryField, type MandatoryFieldKey } from '../protocol/constants.js';

export class Pnr {
  locator?: string;
  names: NameElement[] = [];
  segments: AirSegment[] = [];
  phones: PhoneElement[] = [];
  ticketing?: string;
  receivedFrom?: string;
  createdAt?: Date;

  /** True once at least one field has been added (work area is dirty). */
  hasContent(): boolean {
    return (
      this.names.length > 0 ||
      this.segments.length > 0 ||
      this.phones.length > 0 ||
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
