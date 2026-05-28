/**
 * Audit Trail Report parser (DQB asterisk…). Source: Sabre Ticket Display
 * Tools QR p.2. Examples are spaced (DQB * …) below to avoid the literal
 * asterisk-slash sequence closing this JSDoc block early.
 *
 *   DQB *                today
 *   DQB * 01OCT          specific day of current year
 *   DQB * 12FEB01        specific day in previous year (two-digit YY)
 *   DQB *  /B4T0         today, branch PCC
 *   DQB * 01OCT/B4T0     day + branch
 *   DQB * DELETE | DQB * YES   delete (gated by EPR ATBRPT + duty code 9
 *                              in real Sabre; the emulator doesn't model
 *                              EPR keywords).
 *
 * The parser is structural only — no calendar math, no "previous 31
 * business days" check; the handler decides what data to render.
 */

import type { AuditTrailEntry } from '../entry.js';
import { ParseError } from '../errors.js';

const SABRE_DATE = /^\d{1,2}(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})?$/;

export function parseAuditTrail(raw: string): AuditTrailEntry {
  const base = { kind: 'audit_trail' as const, raw, timestamp: new Date() };
  const u = raw.toUpperCase();
  if (u === 'DQB*DELETE') return { ...base, mode: 'delete_request' };
  if (u === 'DQB*YES') return { ...base, mode: 'delete_confirm' };

  const m = /^DQB\*([A-Z0-9]+)?(?:\/([A-Z0-9]+))?$/.exec(u);
  if (!m) throw new ParseError(`Audit trail: bad DQB* format "${raw}"`);

  const arg = m[1];
  const branch = m[2];
  // arg, if present, must look like a Sabre date token; otherwise reject.
  if (arg && !SABRE_DATE.test(arg)) {
    throw new ParseError(`Audit trail: expected DDMMM[YY] in "${raw}"`);
  }
  return { ...base, mode: 'display', date: arg, branch };
}
