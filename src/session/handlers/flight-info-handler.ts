/**
 * Flight-information handler (FLIFO / verify). Read-only query — no state change.
 *   flight       : look up the flight in the seed schedule (2 / V*)
 *   availability : verify line(s) from the last availability display (VA*)
 *   itinerary    : verify segment(s) of the work-area PNR (VI*)
 */

import type { FlightInfoEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { renderFlightInfo, type FlightInfoItem } from '../../protocol/serializer.js';
import { parseClockToMinutes } from '../../utils/validation.js';
import { MIN_CONNECT_MINUTES } from '../../store/inventory.js';
import type { HandlerContext } from './context.js';

/** VCT*: verify minimum connecting time between consecutive connection segments. */
function verifyConnections(wa: WorkArea): string {
  const segs = wa.pnr.segments;
  if (segs.length < 2) return 'NO CONNECTIONS TO VERIFY'; // TODO: confirm wording
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].destination !== segs[i + 1].origin) continue; // not a connection point
    const arr = parseClockToMinutes(segs[i].arriveTime);
    const dep = parseClockToMinutes(segs[i + 1].departTime);
    if (arr == null || dep == null) continue;
    let connect = dep - arr;
    if (connect < 0) connect += 1440;
    if (connect < MIN_CONNECT_MINUTES) {
      return `INVALID CONNECT TIME SEGS ${i + 1} AND ${i + 2} - MINIMUM IS ${MIN_CONNECT_MINUTES} MINUTES`;
    }
  }
  return 'MINIMUM CONNECT TIME EDIT VALID FOR ALL CONNECTIONS';
}

export function handleFlightInfo(entry: FlightInfoEntry, wa: WorkArea, ctx: HandlerContext): string {
  if (entry.source === 'connect') return verifyConnections(wa);

  if (entry.source === 'flight') {
    const f = ctx.inventory.scheduleFor(entry.carrier!, entry.flightNumber!);
    if (!f) return 'FLIGHT NOT FOUND'; // TODO: confirm wording
    return renderFlightInfo([
      {
        carrier: f.carrier,
        flightNumber: f.flightNumber,
        date: entry.date,
        origin: f.origin,
        destination: f.destination,
        departTime: f.departTime,
        arriveTime: f.arriveTime,
        equipment: f.equipment,
      },
    ]);
  }

  if (entry.source === 'availability') {
    const avail = wa.lastAvailability;
    if (!avail) return 'NO AVAILABILITY DISPLAYED'; // TODO: confirm wording
    const items: FlightInfoItem[] = [];
    for (const n of entry.lines ?? []) {
      const line = avail.lines.find((l) => l.line === n);
      if (!line) return 'CHECK LINE NUMBER'; // TODO: confirm wording
      items.push(line);
    }
    return renderFlightInfo(items);
  }

  // itinerary: selected segments, or all when no list given
  const segs = wa.pnr.segments;
  if (segs.length === 0) return 'NO ITINERARY'; // TODO: confirm wording
  const chosen = entry.lines ? entry.lines.map((n) => segs[n - 1]) : segs;
  if (chosen.some((s) => s === undefined)) return 'CHECK SEGMENT NUMBER'; // TODO: confirm wording

  const items: FlightInfoItem[] = chosen.map((s) => ({
    carrier: s.carrier,
    flightNumber: s.flightNumber,
    date: s.date,
    origin: s.origin,
    destination: s.destination,
    departTime: s.departTime,
    arriveTime: s.arriveTime,
    equipment: ctx.inventory.scheduleFor(s.carrier, s.flightNumber)?.equipment ?? '',
  }));
  return renderFlightInfo(items);
}
