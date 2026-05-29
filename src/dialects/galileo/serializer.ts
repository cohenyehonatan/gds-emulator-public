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
import type { Pnr } from '../../models/pnr.js';
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
  if (pnr.segments.length > 0) out.push(renderGalileoItinerary(pnr));
  for (const p of pnr.phones) out.push(`P. ${p.number}`);
  if (pnr.ticketing) out.push(`T. ${pnr.ticketing}`);
  if (pnr.receivedFrom) out.push(`R. ${pnr.receivedFrom}`);
  return out.join('\n');
}

/** `*I` — itinerary-only display (Module 2 p.27). */
export function renderGalileoItinerary(pnr: Pnr): string {
  if (pnr.segments.length === 0) return 'NO ITINERARY'; // reconstructed
  return pnr.segments.map(renderGalileoSoldSegment).join('\n');
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
