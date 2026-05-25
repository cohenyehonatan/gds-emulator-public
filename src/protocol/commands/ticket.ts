/**
 * Issue e-tickets (Sabre Issue-Tickets QR).
 *   W¥             issue ticket(s) for the whole PNR
 *   TTP            synonym for W¥ (issue all)
 *   W¥PQ(n)        issue from a single stored Enhanced PQ record
 *   W¥N(item)      issue for one name field
 *
 * `¥` is the cross of Lorraine (typed as `'`, normalized by keyboard.ts).
 *
 * TODO (ROADMAP): qualifiers W¥A (validating carrier), W¥S (segment select),
 * W¥K/KP (commission), W¥F (form of payment), W¥DP (invoice), multiple-PQ
 * W¥PQ1/2, paper W¥XETR.
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

  const pq = /^PQ(\d+)$/.exec(rest);
  if (pq) return { ...base, source: 'pq', pqRecord: parseInt(pq[1], 10) };

  const name = /^N(\d+)$/.exec(rest);
  if (name) return { ...base, source: 'pnr', nameItem: parseInt(name[1], 10) };

  throw new ParseError(`Ticket: unsupported qualifier "${rest}" in "${raw}"`);
}
