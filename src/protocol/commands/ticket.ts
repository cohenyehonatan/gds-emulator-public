/**
 * Issue e-tickets (Sabre Issue-Tickets QR).
 *   W¥             issue ticket(s) for the whole PNR
 *   TTP            synonym for W¥ (issue all)
 *   W¥PQ(n)        issue from a single stored Enhanced PQ record
 *   W¥N(item)      issue for one name field
 *
 * `¥` is the cross of Lorraine (typed as `'`, normalized by keyboard.ts).
 * It's also the qualifier separator — additional qualifiers chain after
 * the base entry, each separated by ¥, per the Basic Reservation Course
 * example: `W¥PQ1¥KP0¥ALH` (PQ 1, commission 0%, validating airline LH).
 *
 * Implemented qualifiers (source-grounded by the example above):
 *   A<carrier>     validating carrier override        e.g. ALH
 *   KP<n>          commission percentage              e.g. KP0
 *   K<amount>      commission flat amount             e.g. K12.50
 *   PQ<n>          stored PQ record reference          (still recognized
 *                  as a base entry too, for W¥PQ1 alone)
 *   N<item>        name-field selector
 *
 * TODO (ROADMAP, now source-grounded in references/Sabre-Issue-Tickets-QR.pdf
 * + sibling Ticket-Display-Tools / Accounting-Lines QRs and Zenon QREX manual):
 * W¥S (segment select), W¥F (form of payment with CVV/extended/pre-approved),
 * W¥DP (invoice — must be last per QR p.1), multi-PQ W¥PQ2N1.2¥PQ5N1.3-1.5
 * (max 4 records), paper W¥XETR, *PAC accounting line (commission lives
 * there, not *T), WFR/WFRT/WTRX refund flow. Void's standalone WV sigil
 * isn't in any first-party Sabre QR; deferred separately.
 */

import type { TicketEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parseTicket(raw: string): TicketEntry {
  const base = { kind: 'ticket' as const, raw, timestamp: new Date() };

  if (raw.toUpperCase() === 'TTP') return { ...base, source: 'pnr' };

  const m = /^W¥(.*)$/i.exec(raw);
  if (!m) throw new ParseError(`Ticket: expected W¥… in "${raw}"`);
  const rest = m[1].toUpperCase();

  if (rest === '') return { ...base, source: 'pnr' };

  // Split on the cross of Lorraine: the first token is the base entry, the
  // rest are qualifiers (any number, any order).
  const tokens = rest.split('¥');
  const head = tokens[0];
  const qualifiers = tokens.slice(1);

  // Base entry: PQ<n>, N<item>, or empty (issue all).
  let entry: TicketEntry;
  const pq = /^PQ(\d+)$/.exec(head);
  const name = /^N(\d+)$/.exec(head);
  if (pq) {
    entry = { ...base, source: 'pq', pqRecord: parseInt(pq[1], 10) };
  } else if (name) {
    entry = { ...base, source: 'pnr', nameItem: parseInt(name[1], 10) };
  } else if (isQualifier(head)) {
    // Bare `W¥A...` / `W¥KP...` / `W¥K...` — no PQ or N; issue all with the qualifier.
    entry = { ...base, source: 'pnr' };
    applyQualifier(entry, head, raw);
  } else {
    throw new ParseError(`Ticket: unsupported qualifier "${head}" in "${raw}"`);
  }

  for (const q of qualifiers) applyQualifier(entry, q, raw);
  return entry;
}

function isQualifier(t: string): boolean {
  return /^A[A-Z0-9]{2}$/.test(t) || /^KP\d+$/.test(t) || /^K\d+(\.\d+)?$/.test(t);
}

function applyQualifier(entry: TicketEntry, token: string, raw: string): void {
  const carrier = /^A([A-Z0-9]{2})$/.exec(token);
  if (carrier) {
    entry.validatingCarrier = carrier[1];
    return;
  }
  const kp = /^KP(\d+)$/.exec(token);
  if (kp) {
    entry.commissionPercent = parseInt(kp[1], 10);
    return;
  }
  const k = /^K(\d+(?:\.\d+)?)$/.exec(token);
  if (k) {
    entry.commissionAmount = parseFloat(k[1]);
    return;
  }
  throw new ParseError(`Ticket: unrecognized qualifier "${token}" in "${raw}"`);
}
