/**
 * Galileo green-screen response rendering — the dialect-specific tail
 * of `processEntry`. Sabre's serializer (`src/protocol/serializer.ts`)
 * stays Sabre-specific; Galileo grows its own here.
 *
 * **Fidelity caveat.** The Travelport+ Mini Format Guide v2 (Oct 2025,
 * canonical) documents Galileo *entries* but routes responses through
 * Smartpoint pop-ups, so the host text isn't published. Every renderer
 * here is **reconstructed** at the queue-prompt fidelity bar — the
 * shapes follow common 1G conventions (`<usercode> SIGNED ON AT <PCC>`
 * style, all-caps, single-line) but the wording isn't source-verified.
 * Replace verbatim when a live-1G capture against 7K9S surfaces the
 * real response strings.
 */

import type { AvailabilityResult, AvailabilityLine } from '../../models/availability-result.js';
import type { AirSegment } from '../../models/segment.js';
import type { HotelSegment } from '../../models/hotel.js';
import type { CarSegment } from '../../models/car.js';
import type { RailSegment } from '../../models/rail.js';
import type { Pnr } from '../../models/pnr.js';
import type { FareQuote } from '../../models/fare.js';
import type { TicketRecord } from '../../models/ticket.js';
import { formatNameItem } from '../../models/name-element.js';
import { to24h } from '../../utils/validation.js';

export interface GalileoSignature {
  /** Pseudo City Code (e.g. "7K9S" — the Travelport pre-prod tenant). */
  pcc: string;
  /** User code captured from `SON/Z<rest>`. May embed a PCC override. */
  agent?: string;
}

/**
 * Render the sign-on response (`SON/Z<usercode>`).
 * Reconstructed — no source documents the exact host wording.
 */
export function renderGalileoSignInResponse(sig: GalileoSignature): string {
  const code = sig.agent ?? 'AGT';
  return `${code} SIGNED ON AT ${sig.pcc}`; // reconstructed
}

/**
 * Render the sign-off response (`SOF`).
 * Reconstructed — no source documents the exact host wording.
 */
export function renderGalileoSignOffResponse(sig: GalileoSignature): string {
  const code = sig.agent ?? 'AGT';
  return `${code} SIGNED OFF AT ${sig.pcc}`; // reconstructed
}

/**
 * Render the area-switch response (`SA`/`SB`/`SC`/`SD`/`SE`).
 * Reconstructed — the Mini Format Guide v2 documents the entry but not
 * the response. The shape mirrors Sabre's `<PCC>.<PCC>*<agent>..<area>`
 * convention, which is consistent enough across mainframe GDS systems
 * to be a reasonable placeholder until a live-1G capture surfaces the
 * real host text.
 */
export function renderGalileoSwitchAreaResponse(sig: GalileoSignature, area: string): string {
  const code = sig.agent ?? 'AGT';
  return `${sig.pcc}.${sig.pcc}*${code}..${area}`; // reconstructed
}

/**
 * Availability display for the Galileo dialect. Reconstructed — the
 * Mini Format Guide v2 documents the entry but the response screen
 * lives behind a Smartpoint GUI. Travelport Smartpoint Module 2
 * describes the conceptual columns (line# / carrier / flight / classes
 * with seat counts / origin-destination / depart / arrive / equipment)
 * but doesn't publish a byte-by-byte sample.
 *
 * The reconstruction below keeps the same underlying data the Sabre
 * renderer uses but reflows it into a recognizably-different header
 * (`<DD-MMM>  <ORIG>-<DEST>`, with a dash separator instead of Sabre's
 * slash) and uses the Module-2 column order: origin / depart / dest /
 * arrive comes BEFORE the classes block. Flagged inline.
 */
export function renderGalileoAvailability(result: AvailabilityResult): string {
  const header = `${result.date}  ${result.origin}-${result.destination}`; // reconstructed
  const lines = result.lines.map(renderGalileoAvailLine);
  return [header, ...lines].join('\n');
}

function renderGalileoAvailLine(l: AvailabilityLine): string {
  const classes = Object.entries(l.classes)
    .map(([c, n]) => `${c}${Math.min(n, 9)}`)
    .join(' ');
  return (
    `${String(l.line).padStart(2)} ${l.carrier} ${l.flightNumber.padEnd(4)} ` +
    `${l.origin} ${to24h(l.departTime)} ${l.destination} ${to24h(l.arriveTime)} ${l.equipment}  ${classes}`
  );
}

/**
 * Render the sold-segment echo after `N<seats><class><line>`.
 * Reconstructed — neither the Mini Guide nor the Pocket Guide quotes
 * the exact host-mode echo (Smartpoint renders it in the booking-file
 * panel). Shape matches the same Module-2 callouts so the avail and
 * sell echoes share a column convention.
 */
export function renderGalileoSoldSegment(s: AirSegment): string {
  return (
    ` ${s.segmentNumber}. ${s.carrier} ${s.flightNumber.padEnd(4)} ${s.bookingClass} ` +
    `${s.date} ${s.origin} ${s.destination} ${s.status} ${s.seats} ` +
    `${to24h(s.departTime)} ${to24h(s.arriveTime ?? '')}`
  ); // reconstructed
}

/**
 * Galileo PNR / Booking File display (`*R` per Module 2 p.27).
 * Reconstructed — Smartpoint renders BF in a GUI panel and the Mini
 * Guide doesn't quote the green-screen layout. Shape mirrors the
 * Travelport+ training-doc callouts: locator header, numbered name
 * line, itinerary segments in Module-2 column order, then the dotted
 * section fields (P. / T. / R.) that pair 1:1 with the entry sigils.
 */
export function renderGalileoPnr(pnr: Pnr, sig: GalileoSignature): string {
  const out: string[] = [];
  out.push(renderGalileoBfHeader(pnr, sig));
  if (pnr.names.length > 0) out.push(renderGalileoNames(pnr));
  if (
    pnr.segments.length > 0 || pnr.hotelSegments.length > 0 ||
    pnr.carSegments.length > 0 || pnr.railSegments.length > 0
  ) {
    out.push(renderGalileoItinerary(pnr));
  }
  for (const p of pnr.phones) out.push(`P. ${p.number}`);
  if (pnr.ticketing) out.push(`T. ${pnr.ticketing}`);
  if (pnr.receivedFrom) out.push(`R. ${pnr.receivedFrom}`);
  return out.join('\n');
}

/**
 * `*<field>` — Booking File field displays, per the Galileo Formats
 * Guide "BOOKING FILE DISPLAY" table (H/BFD; in-tree at
 * references/galileo/booking-file-display-options.md, entries +
 * meanings verbatim). Section LAYOUTS reconstructed — the guide
 * documents what each entry displays, not the screen text.
 * Returns undefined for keys that aren't field displays so the
 * dispatch can fall through to other *-forms.
 */
export function renderGalileoFieldDisplay(pnr: Pnr, sig: GalileoSignature, key: string): string | undefined {
  const none = (what: string) => `NO ${what}`; // reconstructed
  switch (key) {
    case 'N':
      return pnr.names.length ? pnr.names.map((n, i) => `${i + 1}.${formatNameItem(n)}`).join('\n') : none('NAMES');
    case 'P':
    case 'P1': {
      const phones = key === 'P1' ? pnr.phones.slice(0, 2) : pnr.phones;
      return phones.length ? phones.map((p, i) => `P. ${i + 1} ${p.number}`).join('\n') : none('PHONE FIELDS');
    }
    case 'TD':
      return pnr.ticketing ? `T. ${pnr.ticketing}` : none('TICKETING DATA');
    case 'RV':
      return pnr.receivedFrom ? `R. ${pnr.receivedFrom}` : none('RECEIVED DATA');
    case 'SR':
      return pnr.ssrs.length
        ? pnr.ssrs.map((r, i) => `SI. ${i + 1} SSR ${r.code} ${r.carrier} ${r.status}${r.text ? ' ' + r.text : ''}`).join('\n')
        : none('SSR DATA');
    case 'SO':
      return pnr.osis.length
        ? pnr.osis.map((o, i) => `SI. ${i + 1} OSI ${o.carrier} ${o.text}`).join('\n')
        : none('OSI DATA');
    case 'SI': {
      const sr = renderGalileoFieldDisplay(pnr, sig, 'SR');
      const so = renderGalileoFieldDisplay(pnr, sig, 'SO');
      if (!pnr.ssrs.length && !pnr.osis.length) return none('SERVICE INFORMATION');
      return [pnr.ssrs.length ? sr : undefined, pnr.osis.length ? so : undefined].filter(Boolean).join('\n');
    }
    case 'FF':
      return pnr.priceQuotes.length
        ? pnr.priceQuotes.map((q, i) => renderGalileoFareQuote(q, i + 1)).join('\n')
        : none('FILED FARES');
    case 'VI':
      return none('INCOMING VENDOR REMARKS'); // vendor remarks not modeled
    case 'VO':
      return none('OUTGOING VENDOR REMARKS');
    case 'VR':
      return none('VENDOR REMARKS');
    case 'VL':
      return none('VENDOR LOCATOR DATA');
    case 'FOP':
      return pnr.fopField ? `F. ${pnr.fopField}` : none('FORM OF PAYMENT DATA');
    case 'MM':
      return pnr.frequentFlyers.length
        ? pnr.frequentFlyers.map((f, i) => `M. ${i + 1} ${f.carrier}${f.number}`).join('\n')
        : none('MILEAGE MEMBERSHIP DATA');
    case 'SD':
      return pnr.seatRequests.length
        ? pnr.seatRequests.map((r, i) => `S. ${i + 1} ${r.code}${r.segment != null ? ' S' + r.segment : ''}`).join('\n')
        : none('SEAT DATA');
    case 'DI':
      return pnr.remarks.some((r) => r.type === 'document')
        ? pnr.remarks.filter((r) => r.type === 'document').map((r, i) => `DI. ${i + 1} ${r.text}`).join('\n')
        : none('DOCUMENT ITINERARY REMARKS');
    case 'RI':
    case 'RIA':
    case 'RIU': {
      const all = pnr.remarks.filter((r) => r.type === 'itinerary');
      const rows = key === 'RIA' ? all.filter((r) => r.segment != null) : key === 'RIU' ? all.filter((r) => r.segment == null) : all;
      return rows.length
        ? rows.map((r, i) => `RI. ${i + 1}${r.segment != null ? ' S' + r.segment : ''} ${r.text}`).join('\n')
        : none('ITINERARY REMARKS');
    }
    case 'NP':
      return pnr.remarks.length
        ? pnr.remarks.map((r, i) => `NP. ${i + 1} ${r.text}`).join('\n')
        : none('NOTEPAD DATA');
    case 'AD':
    case 'AW':
    case 'AA': {
      // Delivery = subtype 'delivery'; written = everything else on
      // the shared mailing/billing model (W. stores subtype
      // 'standard'; Amadeus AM/AB ride the same arrays).
      const rows = pnr.addresses.filter((a) =>
        key === 'AA' ? true : key === 'AD' ? a.subtype === 'delivery' : a.subtype !== 'delivery'
      );
      return rows.length
        ? rows.map((a) => `${a.subtype === 'delivery' ? 'D' : 'W'}. ${a.text}`).join('\n')
        : none('ADDRESS DATA');
    }
    case 'CD': {
      // "Customer Data" — the client-file-sourced fields: addresses
      // plus account remarks. Honest empty when nothing is on file.
      const addr = pnr.addresses.map((a) => `${a.subtype === 'delivery' ? 'D' : 'W'}. ${a.text}`);
      if (addr.length === 0) return none('CUSTOMER DATA');
      return addr.join('\n');
    }
    case 'ALL': {
      // "Display All Booking File Data" — every populated section,
      // including the fields *R hides behind field displays.
      const sections = [
        renderGalileoPnr(pnr, sig),
        ...['SI', 'MM', 'SD', 'NP', 'AA', 'FF', 'FOP'].map((k) => {
          const body = renderGalileoFieldDisplay(pnr, sig, k);
          return body && !body.startsWith('NO ') ? body : undefined;
        }),
      ];
      return sections.filter(Boolean).join('\n');
    }
    default:
      return undefined;
  }
}

/** Hotel segment line — reconstructed (HHL convention). */
function renderGalileoHotelLine(h: HotelSegment): string {
  return ` ${h.segmentNumber}. HHL ${h.chain} ${h.status}${h.rooms} ${h.city} ${h.checkIn}-${h.checkOut} ${h.name}${h.confirmationNumber ? ' CF-' + h.confirmationNumber : ''}`;
}

/** Car segment line — reconstructed (CCR convention). */
function renderGalileoCarLine(c: CarSegment): string {
  return ` ${c.segmentNumber}. CCR ${c.company} ${c.status}1 ${c.city} ${c.pickup}-${c.dropoff} ${c.vehicleType}${c.confirmationNumber ? ' CF-' + c.confirmationNumber : ''}`;
}

/** Rail segment line — reconstructed (TRN convention). */
function renderGalileoRailLine(r: RailSegment): string {
  return ` ${r.segmentNumber}. TRN ${r.provider} ${r.trainNumber} ${r.bookingClass} ${r.date} ${r.origin} ${r.destination} ${r.status}${r.seats} ${to24h(r.departTime)} ${to24h(r.arriveTime)}`;
}

/**
 * `*I` — itinerary display (Module 2 p.27), now ALL segment types in
 * segment-number order — the Formats Guide's *I row covers the whole
 * itinerary, with *IA/*IH/*IC/*IN as the typed slices (H/BFD table).
 */
export function renderGalileoItinerary(pnr: Pnr, slice: 'ALL' | 'A' | 'H' | 'C' | 'N' = 'ALL'): string {
  type Row = { n: number; line: string };
  const rows: Row[] = [];
  if (slice === 'ALL' || slice === 'A') {
    rows.push(...pnr.segments.map((x) => ({ n: x.segmentNumber, line: renderGalileoSoldSegment(x) })));
  }
  if (slice === 'ALL' || slice === 'H' || slice === 'N') {
    rows.push(...pnr.hotelSegments.map((x) => ({ n: x.segmentNumber, line: renderGalileoHotelLine(x) })));
  }
  if (slice === 'ALL' || slice === 'C' || slice === 'N') {
    rows.push(...pnr.carSegments.map((x) => ({ n: x.segmentNumber, line: renderGalileoCarLine(x) })));
  }
  if (slice === 'ALL' || slice === 'N') {
    rows.push(...pnr.railSegments.map((x) => ({ n: x.segmentNumber, line: renderGalileoRailLine(x) })));
  }
  if (rows.length === 0) {
    const what = { ALL: 'ITINERARY', A: 'AIR SEGMENTS', H: 'HOTEL SEGMENTS', C: 'CAR SEGMENTS', N: 'NON-AIR SEGMENTS' }[slice];
    return `NO ${what}`; // reconstructed
  }
  return rows.sort((a, b) => a.n - b.n).map((r) => r.line).join('\n');
}

/** `<LOCATOR> <PCC>/<AGENT>` — BF header line. Reconstructed. */
function renderGalileoBfHeader(pnr: Pnr, sig: GalileoSignature): string {
  const code = sig.agent ?? 'AGT';
  const loc = pnr.locator ?? '------';
  return `${loc}  ${sig.pcc}/${code}`; // reconstructed
}

/** Name lines, Galileo-style. `1.1SMITH/JOHN MR` per industry convention. */
function renderGalileoNames(pnr: Pnr): string {
  return pnr.names.map((n, i) => `${i + 1}.${formatNameItem(n)}`).join('   ');
}

/**
 * `FQ` response: stored filed-fare display. Reconstructed — Mini Guide
 * v2 documents the entry but the response is Smartpoint GUI. Shape
 * follows training-doc conventions: header with filed-fare number,
 * one line per passenger block with type/count/base/taxes/total.
 */
export function renderGalileoFareQuote(fq: FareQuote, filedFareNumber: number): string {
  const out: string[] = [];
  out.push(`FILED FARE ${filedFareNumber}  ${fq.validatingCarrier}  ${fq.currency}`); // reconstructed
  for (const p of fq.passengers) {
    const total = p.total.toFixed(2);
    const base = p.base.toFixed(2);
    const tax = p.taxTotal.toFixed(2);
    out.push(
      ` ${p.passengerType.padEnd(4)} ${String(p.count).padStart(2)}  ${base.padStart(8)}  ${tax.padStart(7)}  ${total.padStart(9)}`
    );
  }
  return out.join('\n');
}

/**
 * `TKP<n>` response: ticket-issuance echo. Reconstructed — Mini Guide
 * v2 doesn't quote the host text. One line per issued ticket with
 * number / passenger / carrier / total.
 */
/**
 * `*HTI` — Display ticket numbers. Source: Mini Format Guide v2 p.53.
 * Reconstructed layout — Mini Guide documents the entry but not the
 * exact host text. One line per ticket with number / status / passenger
 * / carrier / total.
 */
export function renderGalileoTicketList(tickets: TicketRecord[]): string {
  if (tickets.length === 0) return 'NO TICKETS ISSUED'; // reconstructed
  const lines = tickets.map((t, i) => {
    const status = t.status ?? 'OPEN';
    return `  ${i + 1}. ${t.number}  ${status.padEnd(8)} ${t.passenger}  ${t.validatingCarrier}  ${t.total.toFixed(2)}`;
  });
  return ['TICKETS', ...lines].join('\n');
}

export function renderGalileoIssuedTickets(tickets: TicketRecord[]): string {
  if (tickets.length === 0) return 'NO TICKETS ISSUED'; // reconstructed
  return tickets
    .map((t) => `TKT ${t.number}  ${t.passenger}  ${t.validatingCarrier}  ${t.total.toFixed(2)}`)
    .join('\n');
}

/**
 * `FD<...>` response — published-fare display. Reconstructed: Mini
 * Format Guide v2 documents the entry but not the host screen.
 * Format chosen:
 *
 *   FARE DISPLAY <ORIG><DEST>  <DATE>   <CURRENCY>
 *     1. <CARRIER> <AMOUNT>  <FARE_BASIS>  <CLASS> <JOURNEY>
 *     2. ...
 *
 * Empty result: `NO FARES <ORIG><DEST>`. Aligns with the convention
 * established for QCA/QW/QPB* — reconstructed flagged in the handler.
 */
export function renderGalileoFareDisplay(result: {
  origin: string;
  destination: string;
  departureDate: string;
  currency: string;
  lines: Array<{
    sequence: number;
    carrier: string;
    amount: number;
    fareBasisCode: string;
    bookingClass: string;
    journeyType: 'OW' | 'RT';
  }>;
}): string {
  if (result.lines.length === 0) {
    return `NO FARES ${result.origin}${result.destination}`; // reconstructed
  }
  const header = `FARE DISPLAY ${result.origin}${result.destination}  ${result.departureDate}  ${result.currency}`;
  const rows = result.lines.map((l) => {
    const idx = `${l.sequence}.`.padEnd(4);
    const amount = l.amount.toFixed(2).padStart(8);
    return `  ${idx}${l.carrier} ${amount}  ${l.fareBasisCode.padEnd(10)} ${l.bookingClass} ${l.journeyType}`;
  });
  return [header, ...rows].join('\n'); // reconstructed
}

/**
 * `Q/<n>` response — display queue contents. Reconstructed: Mini
 * Format Guide v2 p.41 documents the entry (`Q/0 (URG)`, `Q/1 (GEN)`,
 * `Q/10 ...`) but not the response layout. Format chosen here:
 *
 *   QUEUE <n>   <count> ITEMS
 *     1. <locator>  <name>           <travelDate>
 *     2. ...
 *
 * Empty queue: `QUEUE <n>  EMPTY`. Same `// reconstructed` posture
 * as `renderGalileoTicketList`.
 */
export function renderGalileoQueueList(result: {
  queue: string;
  items: Array<{ locator: string; name: string; travelDate: string }>;
}): string {
  if (result.items.length === 0) return `QUEUE ${result.queue}  EMPTY`; // reconstructed
  const lines = result.items.map((it, i) => {
    const idx = `${i + 1}.`.padEnd(4);
    return `  ${idx}${it.locator}  ${it.name.padEnd(15)}${it.travelDate}`;
  });
  return [`QUEUE ${result.queue}   ${result.items.length} ITEMS`, ...lines].join('\n'); // reconstructed
}

/**
 * `TTL<n>` response — show flight details for one availability line.
 * Reconstructed (Mini Guide v2 documents the entry, not the response).
 * Layout: header with flight identity, then a body line with route +
 * times + equipment. When the line came from a live backend and carries
 * a vendorRef, the offerId is surfaced on a TVP line so an operator can
 * confirm which Travelport offer the cached line maps to.
 */
export function renderGalileoFlightInfo(line: AvailabilityLine, date: string): string {
  const out: string[] = [];
  out.push(`FLIGHT ${line.carrier} ${line.flightNumber}  ${date}`);
  out.push(
    `${line.origin} ${to24h(line.departTime)} → ${line.destination} ${to24h(line.arriveTime)}  ${line.equipment}`
  );
  if (line.vendorRef?.offerId) {
    out.push(`TVP OFFER ${line.vendorRef.offerId}`);
  }
  return out.join('\n');
}
