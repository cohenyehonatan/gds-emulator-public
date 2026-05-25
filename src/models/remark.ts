/**
 * Remarks field (sigil 5).  (Zenon "Remarks")
 *   5<text>     general remark   5DIFFICULT PASSENGER - ASSIST
 *   5-<text>    form of payment  5-CASH
 *   5H-<text>   historical       5H-HAVE ADVISED PASSENGER OF PENALTY CLAUSES
 *
 * The leading characters determine the remark kind. Displayed via *P5.
 */

export type RemarkType = 'general' | 'fop' | 'historical';

export interface RemarkElement {
  type: RemarkType;
  text: string;
}

/** Parse the text after the '5' sigil into a remark element. */
export function parseRemarkText(s: string): RemarkElement {
  if (/^H-/.test(s)) return { type: 'historical', text: s.slice(2) };
  if (s.startsWith('-')) return { type: 'fop', text: s.slice(1) };
  return { type: 'general', text: s };
}

/** Render a remark back to its entry form (without the leading 5). */
export function formatRemark(r: RemarkElement): string {
  const tag = r.type === 'fop' ? '-' : r.type === 'historical' ? 'H-' : '';
  return `${tag}${r.text}`;
}
