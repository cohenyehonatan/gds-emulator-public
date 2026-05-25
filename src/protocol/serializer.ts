/**
 * Green-screen response rendering (host → terminal).
 *
 * Renders availability displays, sold-segment lines, and PNR displays in a
 * Sabre-style fixed layout, modeled on the course examples. Note the
 * deliberate split (matching the guides): the sell echo (renderSoldSegment)
 * uses 12-hour times + a letter day-of-week, while availability and the stored
 * itinerary display (renderItinerarySegment) use 24-hour + numeric DOW. This is
 * the GDS analog of pectab's serializeMessage, but one-directional.
 */

import type { AvailabilityResult, AvailabilityLine } from '../models/availability-result.js';
import type { AirSegment } from '../models/segment.js';
import { Pnr } from '../models/pnr.js';
import { formatNameItem } from '../models/name-element.js';
import { formatNameRef } from '../models/service.js';
import { formatRemark } from '../models/remark.js';
import type { FareQuote } from '../models/fare.js';
import { MONTHS, to24h } from '../utils/validation.js';
import { HOME_CITY } from './constants.js';

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
    `${classes}  ${l.origin}${l.destination} ${to24h(l.departTime)} ${to24h(l.arriveTime)} ${l.equipment}`
  );
}

/**
 * Single sold-segment line as echoed right after a sell, e.g.
 * " 2 BA 192Y  23NOV S DFWLHR SS1  520P  800A /E". Matches the workbook
 * "EXAMPLE SOLD SEGMENT": 12-hour times, single-letter day-of-week, "/E".
 */
export function renderSoldSegment(s: AirSegment): string {
  const times = s.departTime || s.arriveTime ? `  ${s.departTime}  ${s.arriveTime}` : '';
  const loc = s.airlineLocator ? `*${s.airlineLocator}` : '';
  const arr = s.arriveDate ? `  ${s.arriveDate} ${s.arriveDayOfWeek}/E` : ' /E';
  return (
    `${String(s.segmentNumber).padStart(2)} ${s.carrier} ` +
    `${s.flightNumber}${s.bookingClass}  ${s.date} ${s.dayOfWeek} ` +
    `${s.origin}${s.destination} ${s.status}${s.seats}${loc}${times}${arr}`
  );
}

/**
 * Segment line as shown in the stored PNR / itinerary display (ER, *I, *A),
 * e.g. " 1 MA 225K 20OCT 3 LCABUD SS1 0410 0615 /E": 24-hour times and a
 * numeric day-of-week (workbook "EXAMPLE OF BASIC PNR" / Zenon).
 */
export function renderItinerarySegment(s: AirSegment): string {
  const times = s.departTime || s.arriveTime ? `  ${to24h(s.departTime)}  ${to24h(s.arriveTime)}` : '';
  const loc = s.airlineLocator ? `*${s.airlineLocator}` : '';
  const arr = s.arriveDate ? `  ${s.arriveDate} ${s.arriveDayOfWeekNum} /E` : ' /E';
  return (
    `${String(s.segmentNumber).padStart(2)} ${s.carrier} ` +
    `${s.flightNumber}${s.bookingClass}  ${s.date} ${s.dayOfWeekNum} ` +
    `${s.origin}${s.destination} ${s.status}${s.seats}${loc}${times}${arr}`
  );
}

// ── Section renderers (used by *N / *I / *P / *T and the full display) ──

/** Name line: "1.2MURRAY/FRED MR/HANA MRS   2.1SMITH/JUNE". */
export function renderNames(pnr: Pnr): string {
  if (pnr.names.length === 0) return 'NO NAMES';
  return pnr.names.map((n, i) => `${i + 1}.${formatNameItem(n)}`).join('   ');
}

/** Itinerary: one line per segment (24-hour, numeric day-of-week). */
export function renderItinerary(pnr: Pnr): string {
  if (pnr.segments.length === 0) return 'NO ITINERARY';
  return pnr.segments.map(renderItinerarySegment).join('\n');
}

/** Phone field, with the "PHONES" header; city prefix shown (workbook layout). */
export function renderPhones(pnr: Pnr): string {
  if (pnr.phones.length === 0) return 'NO PHONE FIELD';
  const lines = pnr.phones.map(
    (p, i) => `  ${i + 1}.${p.city ?? HOME_CITY}${p.number}${p.type ? '-' + p.type : ''}`
  );
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

/** Remarks field, with the "REMARKS" header (*P5). */
export function renderRemarks(pnr: Pnr): string {
  if (pnr.remarks.length === 0) return 'NO REMARKS';
  const lines = pnr.remarks.map((r, i) => `  ${i + 1}.${formatRemark(r)}`);
  return ['REMARKS', ...lines].join('\n');
}

/**
 * Full PNR display (after ER / *A). Modeled on the workbook "EXAMPLE OF BASIC
 * PNR"; exact itinerary columns + full signature line are a fidelity-pass item.
 */
export function renderPnr(pnr: Pnr, sig?: PnrSignature): string {
  const out: string[] = [];
  out.push(renderNames(pnr));
  pnr.segments.forEach((s) => out.push(renderItinerarySegment(s)));
  if (pnr.ticketing) out.push(renderTicketing(pnr));
  if (pnr.phones.length) out.push(renderPhones(pnr));
  if (pnr.remarks.length) out.push(renderRemarks(pnr));
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
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const out: string[] = [];
  out.push(`${fq.departureDate} DEPARTURE DATE`);
  out.push('      BASE FARE     TAXES          TOTAL');

  let grandBase = 0;
  let grandTax = 0;
  let grandTotal = 0;
  for (const p of fq.passengers) {
    grandBase = r2(grandBase + p.base * p.count);
    grandTax = r2(grandTax + p.taxTotal * p.count);
    grandTotal = r2(grandTotal + p.total * p.count);
    out.push(
      `${String(p.count).padStart(2)}-  ${fq.currency}${money(p.base)}` +
        `     ${money(p.taxTotal)}XT     ${fq.currency}${money(p.total)}${p.passengerType}`
    );
    out.push('   XT ' + p.taxes.map((t) => `${money(t.amount)}${t.code}`).join(' '));
  }

  out.push(`      ${money(grandBase)}     ${money(grandTax)}          ${money(grandTotal)}TTL`);
  const ptc = fq.passengers.map((p) => `${p.passengerType}-${String(p.count).padStart(2, '0')}`).join(' ');
  out.push(`${ptc} ${fq.fareBasis.join(' ')}`);
  if (fq.passengers[0]) out.push(fq.passengers[0].fareCalc); // fare-construction line
  out.push(`VALIDATING CARRIER - ${fq.validatingCarrier}`);
  return out.join('\n');
}

/** Fare-calculation description (WPDF / WPDF<n>). */
export function renderFareCalc(fq: FareQuote, line?: number): string {
  if (line != null) {
    const p = fq.passengers[line - 1];
    if (!p) return 'FARE CALC LINE NOT FOUND'; // TODO: confirm wording
    return `FARE CALCULATION\n${p.passengerType}  ${p.fareCalc}`;
  }
  return ['FARE CALCULATION', ...fq.passengers.map((p) => `${p.passengerType}  ${p.fareCalc}`)].join('\n');
}

/** Stored PQ records display (*PQ / *PQ<n>). */
export function renderPriceQuotes(pnr: Pnr, n?: number): string {
  if (pnr.priceQuotes.length === 0) return 'NO PQ RECORDS'; // TODO: confirm wording
  if (n != null) {
    const q = pnr.priceQuotes[n - 1];
    if (!q) return 'PQ RECORD NOT FOUND'; // TODO: confirm wording
    return `PQ ${n}\n${renderFareQuote(q)}`;
  }
  return pnr.priceQuotes.map((q, i) => `PQ ${i + 1}\n${renderFareQuote(q)}`).join('\n\n');
}

/** Bargain-finder display: the (lower) quote plus the rebook advisory. */
export function renderBargain(
  fq: FareQuote,
  rebooks: { segment: number; carrier: string; flight: string; from: string; to: string }[],
  applied: boolean
): string {
  const out = [renderFareQuote(fq)];
  if (rebooks.length === 0) {
    out.push('ITINERARY AT LOWEST AVAILABLE FARE'); // TODO: confirm wording
    return out.join('\n');
  }
  out.push(applied ? 'REBOOKED:' : 'REBOOK TO OBTAIN THIS FARE:'); // TODO: confirm wording
  for (const r of rebooks) out.push(`  ${r.segment} ${r.carrier} ${r.flight} ${r.from} TO ${r.to}`);
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
