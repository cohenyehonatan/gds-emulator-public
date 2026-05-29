/**
 * Ticket-document display parser (WETR*… and WTDB*…). Source: Sabre
 * Ticket Display Tools QR p.1-2 (all forms quoted verbatim).
 *
 *   WETR*              redisplay
 *   WETR*<n>           by *T item number
 *   WETR*T<13-digit>   by ticket number
 *   WETR*<n>/E         enhanced
 *   WETR*T<13>/E       enhanced by ticket
 *   WETR*H             history
 *   WTDB*<n>           image by *T item
 *   WTDB*T<13-digit>   image by ticket
 *   WTDB*<n>/OB        image + OB fees
 *   WTDB*T<13>/OB      image by ticket + OB fees
 *
 * `WETRP<n>` / `WETRP` (print paper from ETR) are deferred — they're
 * output-side commands the emulator doesn't model.
 */

import type { TicketDocumentDisplayEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parseTicketDocumentDisplay(raw: string): TicketDocumentDisplayEntry {
  const base = { kind: 'ticket_document_display' as const, raw, timestamp: new Date() };
  const u = raw.toUpperCase();
  const family: 'etr' | 'image' = u.startsWith('WETR') ? 'etr' : 'image';
  const flag = family === 'etr' ? '/E' : '/OB';

  // Strip the family prefix + "*"; the remainder is the args.
  const args = u.replace(/^(WETR|WTDB)\*/, '');

  if (family === 'etr' && args === '') return { ...base, family, mode: 'redisplay' };
  if (family === 'etr' && args === 'H') return { ...base, family, mode: 'history' };

  // Optional trailing /E or /OB flag.
  let body = args;
  let enhanced = false;
  if (body.endsWith(flag)) {
    enhanced = true;
    body = body.slice(0, -flag.length);
  }

  const byTicket = /^T(\d{13})$/.exec(body);
  if (byTicket) {
    return { ...base, family, mode: 'by_ticket', ticketNumber: byTicket[1], enhanced };
  }
  if (/^\d+$/.test(body)) {
    return { ...base, family, mode: 'by_item', itemNumber: parseInt(body, 10), enhanced };
  }
  throw new ParseError(`Ticket display: bad selector "${body}" in "${raw}"`);
}
