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
  // Scroll / redisplay operate on the cached display.
  if (entry.mode === 'more') {
    return wa.lastAvailability ? 'NO MORE FLIGHTS' : 'NO AVAILABILITY DISPLAYED'; // we never paginate past one screen
  }
  if (entry.mode === 'redisplay') {
    return wa.lastAvailability ? renderAvailability(wa.lastAvailability) : 'NO AVAILABILITY DISPLAYED';
  }

  const date = entry.date!;
  const dow = {
    letter: dayOfWeekLetter(date.month, date.day),
    num: dayOfWeekNumber(date.month, date.day),
  };
  const afterMinutes = entry.time ? parseClockToMinutes(entry.time) ?? undefined : undefined;

  const lines = ctx.inventory.availability(date.raw, dow, entry.origin!, entry.destination!, {
    afterMinutes,
    bookingClass: entry.bookingClass,
    carriers: entry.carriers,
  });

  const result = {
    date: date.raw,
    origin: entry.origin!,
    destination: entry.destination!,
    lines,
  };
  wa.lastAvailability = result;

  if (lines.length === 0) return 'NO FLIGHTS'; // TODO: confirm wording vs PDF
  return renderAvailability(result);
}
