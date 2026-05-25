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
import { formatNameItem } from '../models/name-element.js';
import { formatNameRef } from '../models/service.js';
import type { FareQuote } from '../models/fare.js';
import { MONTHS } from '../utils/validation.js';

/** Signature-line inputs (PCC + agent sign). */
export interface PnrSignature {
  pcc: string;
  agent?: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** "29NOV07" */
const sabreDate = (d: Date) => `${pad2(d.getDate())}${MONTHS[d.getMonth()]}${String(d.getFullYear()).slice(-2)}`;
/** "19JUN" */
const sabreDayMon = (d: Date) => `${pad2(d.getDate())}${MONTHS[d.getMonth()]}`;
/** "1054" */
const sabreTime = (d: Date) => `${pad2(d.getHours())}${pad2(d.getMinutes())}`;

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

/**
 * Single sold-segment line, e.g. " 2 BA 192Y  23NOV S DFWLHR SS1  520P  800A /E".
 * Matches the workbook "EXAMPLE SOLD SEGMENT": 12-hour times, single-letter
 * day-of-week, and the trailing "/E" end-item marker.
 */
export function renderSoldSegment(s: AirSegment): string {
  const times = s.departTime || s.arriveTime ? `  ${s.departTime}  ${s.arriveTime}` : '';
  const loc = s.airlineLocator ? `*${s.airlineLocator}` : '';
  return (
    `${String(s.segmentNumber).padStart(2)} ${s.carrier} ` +
    `${s.flightNumber}${s.bookingClass}  ${s.date} ${s.dayOfWeek} ` +
    `${s.origin}${s.destination} ${s.status}${s.seats}${loc}${times} /E`
  );
}

// ── Section renderers (used by *N / *I / *P / *T and the full display) ──

/** Name line: "1.2MURRAY/FRED MR/HANA MRS   2.1SMITH/JUNE". */
export function renderNames(pnr: Pnr): string {
  if (pnr.names.length === 0) return 'NO NAMES';
  return pnr.names.map((n, i) => `${i + 1}.${formatNameItem(n)}`).join('   ');
}

/** Itinerary: one sold-segment line per segment. */
export function renderItinerary(pnr: Pnr): string {
  if (pnr.segments.length === 0) return 'NO ITINERARY';
  return pnr.segments.map(renderSoldSegment).join('\n');
}

/** Phone field, with the "PHONES" header (workbook layout). */
export function renderPhones(pnr: Pnr): string {
  if (pnr.phones.length === 0) return 'NO PHONE FIELD';
  const lines = pnr.phones.map((p, i) => `  ${i + 1}.${p.number}${p.type ? '-' + p.type : ''}`);
  return ['PHONES', ...lines].join('\n');
}

/** Ticketing field, with the "TKT/TIME LIMIT" header (workbook layout). */
export function renderTicketing(pnr: Pnr): string {
  if (!pnr.ticketing) return 'NO TICKETING FIELD';
  return ['TKT/TIME LIMIT', `  1.${pnr.ticketing}`].join('\n');
}

/** SSR lines: "SSR VGML YY NN -1.1 <text>". */
export function renderSsrs(pnr: Pnr): string {
  if (pnr.ssrs.length === 0) return 'NO SSR';
  return pnr.ssrs
    .map((s) => {
      const ref = s.nameRef ? ` ${formatNameRef(s.nameRef)}` : '';
      const txt = s.text ? ` ${s.text}` : '';
      return `SSR ${s.code} ${s.carrier} ${s.status}${ref}${txt}`;
    })
    .join('\n');
}

/** OSI lines: "OSI DL HAS BROKEN LEG". */
export function renderOsis(pnr: Pnr): string {
  if (pnr.osis.length === 0) return 'NO OSI';
  return pnr.osis.map((o) => `OSI ${o.carrier} ${o.text}`).join('\n');
}

/**
 * Full PNR display (after ER / *A). Modeled on the workbook "EXAMPLE OF BASIC
 * PNR"; exact itinerary columns + full signature line are a fidelity-pass item.
 */
export function renderPnr(pnr: Pnr, sig?: PnrSignature): string {
  const out: string[] = [];
  out.push(renderNames(pnr));
  pnr.segments.forEach((s) => out.push(renderSoldSegment(s)));
  if (pnr.ticketing) out.push(renderTicketing(pnr));
  if (pnr.phones.length) out.push(renderPhones(pnr));
  if (pnr.osis.length) out.push(renderOsis(pnr));
  if (pnr.ssrs.length) out.push(renderSsrs(pnr));
  if (pnr.receivedFrom) out.push(`RECEIVED FROM - ${pnr.receivedFrom}`);
  if (pnr.locator) out.push(sig ? renderSignature(sig, pnr) : pnr.locator);
  return out.join('\n');
}

/**
 * PNR signature line, e.g. "A0UC.A0UC*ASC 1054/29NOV07 VZRAFH"
 * (workbook "EXAMPLE OF BASIC PNR"): PCC.PCC*agent time/date locator.
 */
export function renderSignature(sig: PnrSignature, pnr: Pnr): string {
  const when = pnr.createdAt ?? new Date();
  return `${sig.pcc}.${sig.pcc}*${sig.agent ?? 'AGT'} ${sabreTime(when)}/${sabreDate(when)} ${pnr.locator ?? ''}`.trimEnd();
}

/**
 * Sign-in response screen, e.g. "A0UC.A0UC*ALJ....A.B.C.D.E.F" + date
 * (workbook "SIGN IN SYSTEM RESPONSE").
 */
export function renderSignInResponse(sig: PnrSignature): string {
  return `${sig.pcc}.${sig.pcc}*${sig.agent ?? 'AGT'}....A.B.C.D.E.F\n${sabreDayMon(new Date())}`;
}

/**
 * Fare quote display (WP). Modeled on the Basic Pricing QR response: header,
 * a BASE FARE / TAXES / TOTAL row per passenger type, the tax breakdown,
 * fare-basis line, and validating carrier.
 */
export function renderFareQuote(fq: FareQuote): string {
  const money = (n: number) => n.toFixed(2);
  const out: string[] = [];
  out.push(`${fq.departureDate} DEPARTURE DATE`);
  out.push('      BASE FARE     TAXES          TOTAL');
  out.push(
    `${String(fq.passengerCount).padStart(2)}-  ${fq.currency}${money(fq.base)}` +
      `     ${money(fq.taxTotal)}XT     ${fq.currency}${money(fq.total)}${fq.passengerType}`
  );
  out.push('   XT ' + fq.taxes.map((t) => `${money(t.amount)}${t.code}`).join(' '));
  out.push(`      ${money(fq.base)}     ${money(fq.taxTotal)}          ${money(fq.total)}TTL`);
  out.push(`${fq.passengerType}-${String(fq.passengerCount).padStart(2, '0')} ${fq.fareBasis.join(' ')}`);
  out.push(`VALIDATING CARRIER - ${fq.validatingCarrier}`);
  return out.join('\n');
}

/** Numbered list shown when a name search matches more than one PNR. */
export function renderSimilarNameList(matches: Pnr[]): string {
  const lines = matches.map((p, i) => {
    const name = p.names[0] ? formatNameItem(p.names[0]) : '(no name)';
    return `${i + 1} ${name}  ${p.locator ?? ''}`.trimEnd();
  });
  return lines.join('\n');
}
