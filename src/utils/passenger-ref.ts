/**
 * Dotted-name passenger references — Sabre's `<nameItem>.<passenger>`
 * addressing used across W¥PQ name-select (Issue Tickets QR p.1),
 * WFR refund name-select (Zenon QREX p.31), SSR association (sigil 3),
 * etc. The references the QR pins verbatim:
 *
 *   N1.1                single passenger ref (item 1 passenger 1)
 *   N1.3-1.5            range within an item (passengers 3, 4, 5)
 *   N1.2,1.4            list (two distinct refs)
 *
 * Cross-item references aren't documented in any QR we have; rejected at
 * parse time rather than silently treated as single-passenger.
 */

export interface PassengerRef {
  /** 1-indexed name item position. */
  item: number;
  /** 1-indexed passenger within the item. */
  passenger: number;
}

/**
 * Parse a dotted-name selection into an explicit ordered list of refs.
 * Throws on bad syntax (caller wraps into ParseError with its raw entry).
 */
export function parsePassengerSelection(input: string): PassengerRef[] {
  const parts = input.split(',');
  const out: PassengerRef[] = [];
  for (const part of parts) {
    const range = /^(\d+)\.(\d+)-(\d+)\.(\d+)$/.exec(part);
    if (range) {
      const [_, ai, ap, bi, bp] = range;
      if (ai !== bi) throw new Error(`Cross-item range not supported: "${part}"`);
      const item = parseInt(ai, 10);
      const from = parseInt(ap, 10);
      const to = parseInt(bp, 10);
      if (to < from) throw new Error(`Bad range "${part}"`);
      for (let p = from; p <= to; p++) out.push({ item, passenger: p });
      continue;
    }
    const single = /^(\d+)\.(\d+)$/.exec(part);
    if (single) {
      out.push({ item: parseInt(single[1], 10), passenger: parseInt(single[2], 10) });
      continue;
    }
    throw new Error(`Bad passenger ref "${part}"`);
  }
  return out;
}
