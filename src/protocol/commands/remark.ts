/**
 * Remarks entry (sigil 5). General, form-of-payment (5-), and historical (5H-).
 */

import type { RemarkEntry } from '../entry.js';
import { ParseError } from '../errors.js';
import { parseRemarkText } from '../../models/remark.js';

export function parseRemark(raw: string): RemarkEntry {
  const body = raw.slice(1);
  if (body.length === 0) throw new ParseError(`Remark: empty entry "${raw}"`);
  const r = parseRemarkText(body);
  return { kind: 'remark', raw, timestamp: new Date(), remarkType: r.type, text: r.text };
}
