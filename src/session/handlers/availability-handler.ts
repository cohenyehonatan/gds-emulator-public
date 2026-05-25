/**
 * Handle a '1' availability entry: query inventory (honoring time and class
 * qualifiers), cache the result on the work area (so a later '0' sell can
 * resolve a line), and render the display. Does not change session state.
 */

import type { AvailabilityEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { renderAvailability } from '../../protocol/serializer.js';
import { parseClockToMinutes } from '../../utils/validation.js';
import { dayOfWeekLetter, dayOfWeekNumber, type HandlerContext } from './context.js';

export function handleAvailability(
  entry: AvailabilityEntry,
  wa: WorkArea,
  ctx: HandlerContext
): string {
  const dow = {
    letter: dayOfWeekLetter(entry.date.month, entry.date.day),
    num: dayOfWeekNumber(entry.date.month, entry.date.day),
  };
  const afterMinutes = entry.time ? parseClockToMinutes(entry.time) ?? undefined : undefined;

  const lines = ctx.inventory.availability(entry.date.raw, dow, entry.origin, entry.destination, {
    afterMinutes,
    bookingClass: entry.bookingClass,
    carriers: entry.carriers,
  });

  const result = {
    date: entry.date.raw,
    origin: entry.origin,
    destination: entry.destination,
    lines,
  };
  wa.lastAvailability = result;

  if (lines.length === 0) return 'NO FLIGHTS'; // TODO: confirm wording vs PDF
  return renderAvailability(result);
}
