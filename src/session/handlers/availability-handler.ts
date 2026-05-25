/**
 * Handle a '1' availability entry: query inventory (honoring time and class
 * qualifiers), cache the result on the work area (so a later '0' sell can
 * resolve a line), and render the display. Does not change session state.
 */

import type { AvailabilityEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { renderAvailability } from '../../protocol/serializer.js';
import { parseClockToMinutes } from '../../utils/validation.js';
import { Response } from '../../protocol/constants.js';
import { dayOfWeekLetter, dayOfWeekNumber, shiftDate, type HandlerContext } from './context.js';

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

  // Return availability: reverse the last city pair for a new date / +N days.
  if (entry.mode === 'return') {
    const last = wa.lastAvailability;
    if (!last) return 'NO AVAILABILITY DISPLAYED';
    let dateRaw: string;
    let month: number;
    let day: number;
    if (entry.date) {
      ({ raw: dateRaw, month, day } = entry.date);
    } else {
      const s = shiftDate(last.date, entry.returnDays ?? 0);
      if (!s) return Response.FORMAT;
      ({ raw: dateRaw, month, day } = s);
    }
    const lines = ctx.inventory.availability(
      dateRaw,
      { letter: dayOfWeekLetter(month, day), num: dayOfWeekNumber(month, day) },
      last.destination,
      last.origin,
      {}
    );
    const result = { date: dateRaw, origin: last.destination, destination: last.origin, lines };
    wa.lastAvailability = result;
    return lines.length === 0 ? 'NO FLIGHTS' : renderAvailability(result);
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
    directOnly: entry.directOnly,
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
