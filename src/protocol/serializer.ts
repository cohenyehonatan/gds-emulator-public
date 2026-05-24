/**
 * Green-screen response rendering (host → terminal).
 *
 * Renders availability displays, sold-segment lines, and PNR displays in a
 * Sabre-style fixed layout. Layouts are modeled on the course examples but
 * the exact column positions still need pinning against the PDF / a live
 * screen — marked TODO. This is the GDS analog of pectab's serializeMessage,
 * but one-directional (host responses only).
 */

import type { AvailabilityResult, AvailabilityLine } from '../models/availability-result.js';
import type { AirSegment } from '../models/segment.js';
import { Pnr } from '../models/pnr.js';

/** Availability display. TODO: confirm header + column widths vs PDF p.~. */
export function renderAvailability(result: AvailabilityResult): string {
  const header = `${result.date}  ${result.origin}/${result.destination}`;
  const lines = result.lines.map(renderAvailabilityLine);
  return [header, ...lines].join('\n');
}

function renderAvailabilityLine(l: AvailabilityLine): string {
  const classes = Object.entries(l.classes)
    .map(([c, n]) => `${c}${Math.min(n, 9)}`)
    .join(' ');
  return (
    `${String(l.line).padStart(2)} ${l.carrier} ${l.flightNumber.padEnd(4)} ` +
    `${classes}  ${l.origin}${l.destination} ${l.departTime} ${l.arriveTime} ${l.equipment}`
  );
}

/** Single sold-segment line, e.g. " 2 BA 192Y  23NOV S DFWLHR SS1  520P  800A". */
export function renderSoldSegment(s: AirSegment): string {
  return (
    `${String(s.segmentNumber).padStart(2)} ${s.carrier} ` +
    `${s.flightNumber}${s.bookingClass}  ${s.date} ${s.dayOfWeek} ` +
    `${s.origin}${s.destination} ${s.status}${s.seats}  ${s.departTime}  ${s.arriveTime}`
  );
}

/** Full PNR display (after ER / *A). TODO: confirm field headers vs PDF. */
export function renderPnr(pnr: Pnr): string {
  const out: string[] = [];
  if (pnr.locator) out.push(pnr.locator);

  pnr.names.forEach((n, i) => {
    const title = n.title ? ` ${n.title}` : '';
    out.push(`${i + 1}.1${n.surname}/${n.firstName}${title}`);
  });

  pnr.segments.forEach((s) => out.push(renderSoldSegment(s)));

  if (pnr.phones.length) {
    out.push('PHONES');
    pnr.phones.forEach((p, i) => out.push(` ${i + 1}.${p.number}${p.type ? '-' + p.type : ''}`));
  }
  if (pnr.ticketing) out.push(`TKTG-${pnr.ticketing}`);
  if (pnr.receivedFrom) out.push(`RECEIVED FROM - ${pnr.receivedFrom}`);

  return out.join('\n');
}
