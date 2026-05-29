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
 * Implemented qualifiers (source-grounded by the Issue Tickets QR):
 *   A<carrier>     validating carrier override        e.g. ALH
 *   KP<n>          commission percentage              e.g. KP0
 *   K<amount>      commission flat amount             e.g. K12.50
 *   S<n>           single-segment selection           e.g. S2     (QR p.2)
 *   XETR           paper-ticket override (ARC only)   e.g. XETR   (QR p.3)
 *   FCASH/FCHECK/  form of payment                    e.g. FCASH  (QR p.2-3)
 *     FCHEQUE/FCK
 *   F*<cc><nbr>/   credit card form of payment        e.g. F*VI4111…/1204
 *     <MMYY>         (with optional *E<n> extended payment
 *                    or *Z<n> approval code inline)   e.g. *E03  /  *Z003492
 *   F*Z<n>         pre-approved (CC in PNR FOP field) e.g. F*Z003492
 *   CVV<n>         credit-card security code (its own ¥-qualifier; pairs with F*)
 *   DP             issue ticket + invoice/itinerary document (QR p.2; must be last)
 *   PQ<n>          stored PQ record reference          (still recognized
 *                  as a base entry too, for W¥PQ1 alone)
 *   N<item>        name-field selector
 *
 * Ordering rules from QR p.1: `¥PQ` qualifier must be first (enforced by
 * making PQ a base-entry-only token), `¥DP` qualifier must be last
 * (enforced explicitly during parse).
 *
 * TODO (ROADMAP, now source-grounded in references/Sabre-Issue-Tickets-QR.pdf
 * + sibling Ticket-Display-Tools / Accounting-Lines QRs and Zenon QREX manual):
 * W¥S (segment select), W¥F (form of payment with CVV/extended/pre-approved),
 * W¥DP (invoice — must be last per QR p.1), multi-PQ W¥PQ2N1.2¥PQ5N1.3-1.5
 * (max 4 records), paper W¥XETR, *PAC accounting line (commission lives
 * there, not *T), WFR/WFRT/WTRX refund flow. WV void family lives in
 * `commands/void.ts` (Sabre Middle East QR p.13 — verbatim third-party).
 */

import type { TicketEntry } from '../entry.js';
import { ParseError } from '../errors.js';
import { parsePassengerSelection } from '../../utils/passenger-ref.js';

export function parseTicket(raw: string): TicketEntry {
  const base = { kind: 'ticket' as const, raw, timestamp: new Date() };

  if (raw.toUpperCase() === 'TTP') return { ...base, source: 'pnr' };

  const m = /^W¥(.*)$/i.exec(raw);
  if (!m) throw new ParseError(`Ticket: expected W¥… in "${raw}"`);
  const rest = m[1].toUpperCase();

  if (rest === '') return { ...base, source: 'pnr' };

  // Split on the cross of Lorraine: the first token is the base entry, the
  // rest are qualifiers (any number, any order — except DP must be last
  // per QR p.1: "¥DP qualifier must be last").
  const tokens = rest.split('¥');
  const head = tokens[0];
  const qualifiers = tokens.slice(1);
  // QR p.1 ordering rule: ¥DP must be last across the whole token list.
  const dpAt = tokens.indexOf('DP');
  if (dpAt !== -1 && dpAt !== tokens.length - 1) {
    throw new ParseError(`Ticket: ¥DP qualifier must be last in "${raw}"`);
  }

  // Per-PQ named selection (QR p.1 verbatim form W¥PQ2N1.2¥PQ5N1.3-1.5):
  // every ¥-separated token is its own (PQ, names) unit, no plain
  // qualifiers allowed in the same entry. Detect by checking that ALL
  // tokens match `PQ\d+N…`.
  if (tokens.every((t) => /^PQ\d+N/i.test(t))) {
    if (tokens.length > 4) throw new ParseError(`Ticket: max 4 Enhanced PQ records in "${raw}"`);
    const selections = tokens.map((t) => {
      const m = /^PQ(\d+)N(.+)$/i.exec(t)!;
      try {
        return { record: parseInt(m[1], 10), names: parsePassengerSelection(m[2]) };
      } catch (err) {
        throw new ParseError(`Ticket: bad per-PQ name selector "${t}" in "${raw}" — ${(err as Error).message}`);
      }
    });
    return { ...base, source: 'pq', pqNamedSelections: selections };
  }

  // Base entry: PQ<n>, PQ<list/range>, N<item>, or empty (issue all).
  let entry: TicketEntry;
  const pq = /^PQ(\d+)$/.exec(head);
  const pqMulti = /^PQ(\d+(?:[-\/]\d+)+)$/.exec(head);
  const name = /^N(\d+)$/.exec(head);
  if (pqMulti) {
    entry = { ...base, source: 'pq', pqRecords: expandPqList(pqMulti[1], raw) };
  } else if (pq) {
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
  return (
    /^A[A-Z0-9]{2}$/.test(t) ||
    /^KP\d+$/.test(t) ||
    /^K\d+(\.\d+)?$/.test(t) ||
    /^S\d+$/.test(t) ||
    t === 'XETR' ||
    t === 'DP' ||
    /^F/.test(t) || // FCASH / FCHECK / FCK / F*… — let applyQualifier do the precise routing
    /^CVV\d+$/.test(t)
  );
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
  const seg = /^S(\d+)$/.exec(token);
  if (seg) {
    entry.segment = parseInt(seg[1], 10);
    return;
  }
  if (token === 'XETR') {
    entry.paperTicket = true;
    return;
  }
  if (token === 'DP') {
    entry.invoice = true;
    return;
  }
  const cvv = /^CVV(\d+)$/.exec(token);
  if (cvv) {
    entry.cvv = cvv[1];
    return;
  }
  if (token.startsWith('F')) {
    entry.formOfPayment = parseFop(token, raw);
    return;
  }
  throw new ParseError(`Ticket: unrecognized qualifier "${token}" in "${raw}"`);
}

/**
 * Expand a multi-PQ list like `2-4/7` into the explicit ordered set
 * `[2, 3, 4, 7]`. Source rules (Issue Tickets QR p.1): max 4 PQs total,
 * ranges must be ascending; ticketing fulfills in sequential order
 * regardless of typed order so we sort the final list.
 */
function expandPqList(body: string, raw: string): number[] {
  const out = new Set<number>();
  for (const part of body.split('/')) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const from = parseInt(range[1], 10);
      const to = parseInt(range[2], 10);
      if (to < from) throw new ParseError(`Ticket: PQ range must be ascending in "${raw}"`);
      for (let n = from; n <= to; n++) out.add(n);
      continue;
    }
    if (!/^\d+$/.test(part)) throw new ParseError(`Ticket: bad PQ list element "${part}" in "${raw}"`);
    out.add(parseInt(part, 10));
  }
  if (out.size > 4) throw new ParseError(`Ticket: max 4 Enhanced PQ records in "${raw}"`);
  return Array.from(out).sort((a, b) => a - b);
}

/** Parse the W¥F<fop> token into one of the four FOP shapes from Issue Tickets QR p.2-3. */
function parseFop(token: string, raw: string): NonNullable<TicketEntry['formOfPayment']> {
  if (token === 'FCASH') return { kind: 'cash' };
  if (token === 'FCHECK' || token === 'FCHEQUE' || token === 'FCK') return { kind: 'check' };

  // Pre-approved without an inline CC: F*Z<digits>.
  const pre = /^F\*Z(\d+)$/.exec(token);
  if (pre) return { kind: 'preapproved', approvalCode: pre[1] };

  // Credit card with optional inline extended-payment or approval-code suffix.
  // F*<cc><number>/<MMYY>(*E<months>|*Z<approval>)?
  const cc = /^F\*([A-Z]{2})(\d+)\/(\d{4})(?:\*([EZ])(\d+))?$/.exec(token);
  if (cc) {
    const fop: NonNullable<TicketEntry['formOfPayment']> = {
      kind: 'credit_card',
      cardCode: cc[1],
      cardNumber: cc[2],
      expiry: cc[3],
    };
    if (cc[4] === 'E') fop.extendedMonths = parseInt(cc[5], 10);
    if (cc[4] === 'Z') fop.approvalCode = cc[5];
    return fop;
  }

  throw new ParseError(`Ticket: unrecognized FOP qualifier "${token}" in "${raw}"`);
}
