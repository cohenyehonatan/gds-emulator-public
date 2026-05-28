/**
 * Refund parser (WFR / WFRT). Source: Zenon-QREX-Quick-Refunds-and-Exchanges-Rev03.pdf
 * pp.7-9 (third-party verbatim transcription of Sabre's QREX refund flow).
 *
 *   WFR<13-digit-ticket>     full refund      (QREX p.7)
 *   WFRT<13-digit-ticket>    tax-only refund  (QREX p.9)
 *
 * The QREX manual additionally documents:
 *   WFR<ticket>¥N<name>          name-selected (deferred)
 *   WFR<ticket>¥AGF              agent's fare (deferred)
 *   WFR*                         redisplay last refund (deferred)
 *   WFR*L<n>                     pick from refund list (deferred)
 * Each is its own follow-up.
 */

import type { RefundEntry, CancelRefundEntry } from '../entry.js';
import { ParseError } from '../errors.js';

const RE = /^WFR(T)?(\d{13})$/i;
const WTRX_RE = /^WTRX(\d{13})$/i;

export function parseRefund(raw: string): RefundEntry {
  const m = RE.exec(raw);
  if (!m) throw new ParseError(`Refund: expected WFR[T]<13-digit ticket> in "${raw}"`);
  return {
    kind: 'refund',
    raw,
    timestamp: new Date(),
    mode: m[1] ? 'tax_only' : 'full',
    ticketNumber: m[2],
  };
}

export function parseCancelRefund(raw: string): CancelRefundEntry {
  const m = WTRX_RE.exec(raw);
  if (!m) throw new ParseError(`Cancel refund: expected WTRX<13-digit ticket> in "${raw}"`);
  return {
    kind: 'cancel_refund',
    raw,
    timestamp: new Date(),
    ticketNumber: m[1],
  };
}
