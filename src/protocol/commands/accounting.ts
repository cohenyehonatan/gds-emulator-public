/**
 * Accounting-line parser (`AC…`). Three forms today:
 *
 *   AC¤…              soft-delete (line / ALL / range / list)
 *   AC/…              add a manual accounting line
 *   AC<n>/<carrier>   modify the carrier (optionally + commission)
 *
 * Sources: Sabre Accounting Lines QR p.1 verbatim — all three forms quoted.
 *
 * Deferred: AC<n>¤O/<text> optional-info modify, AC<n>/<10-digit ticket>
 * ticket-number update.
 */

import type {
  AccountingDeleteEntry,
  AccountingAddEntry,
  AccountingModifyEntry,
} from '../entry.js';
import { ParseError } from '../errors.js';

export function parseAccounting(
  raw: string
): AccountingDeleteEntry | AccountingAddEntry | AccountingModifyEntry {
  if (raw.startsWith('AC¤')) return parseDelete(raw);
  if (raw.startsWith('AC/')) return parseAdd(raw);
  const modify = /^AC(\d+)\/(.+)$/.exec(raw);
  if (modify) return parseModify(modify[1], modify[2], raw);
  throw new ParseError(`Accounting: expected AC¤<…>, AC/<…>, or AC<n>/<…> in "${raw}"`);
}

function parseDelete(raw: string): AccountingDeleteEntry {
  const body = raw.slice(3).toUpperCase();
  const base = { kind: 'accounting_delete' as const, raw, timestamp: new Date() };

  if (body === 'ALL') return { ...base, mode: 'all', lines: [] };

  const range = /^(\d+)-(\d+)$/.exec(body);
  if (range) {
    const from = parseInt(range[1], 10);
    const to = parseInt(range[2], 10);
    if (to < from) throw new ParseError(`Accounting: bad range "${raw}"`);
    const lines = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    return { ...base, mode: 'lines', lines };
  }

  if (/^\d+(,\d+)*$/.test(body)) {
    return { ...base, mode: 'lines', lines: body.split(',').map((n) => parseInt(n, 10)) };
  }

  throw new ParseError(`Accounting: unsupported AC¤ selection "${body}" in "${raw}"`);
}

/** Parse the modify form `AC<n>/<carrier>[/<commission>]`. */
function parseModify(lineNum: string, rest: string, raw: string): AccountingModifyEntry {
  const parts = rest.split('/');
  if (parts.length < 1 || parts.length > 2) {
    throw new ParseError(`Accounting: AC<n>/ expects 1 or 2 trailing fields in "${raw}"`);
  }
  const carrier = parts[0];
  if (!/^[A-Z0-9]{2}$/i.test(carrier)) {
    throw new ParseError(`Accounting: bad carrier "${carrier}" in "${raw}"`);
  }
  const entry: AccountingModifyEntry = {
    kind: 'accounting_modify',
    raw,
    timestamp: new Date(),
    lineNumber: parseInt(lineNum, 10),
    newCarrier: carrier.toUpperCase(),
  };
  if (parts.length === 2) {
    const c = parts[1];
    const pct = /^P(\d+(?:\.\d+)?)$/.exec(c);
    if (pct) {
      entry.newCommission = parseFloat(pct[1]);
      entry.newCommissionPercent = true;
    } else if (/^\d+(?:\.\d+)?$/.test(c)) {
      entry.newCommission = parseFloat(c);
      entry.newCommissionPercent = false;
    } else {
      throw new ParseError(`Accounting: bad commission "${c}" in "${raw}"`);
    }
  }
  return entry;
}

/**
 * Parse the manual AC create grammar — slash-delimited fields per the
 * QR's verbatim shape. The optional trailing `-<freetext>` is captured
 * after splitting on the first `-` that isn't inside a field.
 */
function parseAdd(raw: string): AccountingAddEntry {
  // Strip the leading "AC/"; split body into "main" and optional "-freetext".
  const body = raw.slice(3);
  const dashAt = body.indexOf('-');
  const main = dashAt === -1 ? body : body.slice(0, dashAt);
  const freeText = dashAt === -1 ? undefined : body.slice(dashAt + 1);

  const fields = main.split('/');
  if (fields.length !== 9) {
    throw new ParseError(`Accounting: expected 9 slash-fields in "${raw}" (got ${fields.length})`);
  }
  const [carrier, ticket, comm, base, taxes, fareApp, fop, docs, tariff] = fields;

  if (!/^[A-Z0-9]{2}$/i.test(carrier)) throw new ParseError(`Accounting: bad carrier "${carrier}" in "${raw}"`);
  if (!/^\d{10,11}$/.test(ticket)) throw new ParseError(`Accounting: bad ticket number "${ticket}" in "${raw}"`);

  // Commission: `P<n>` percent, or a decimal amount.
  let commission: number;
  let commissionPercent = false;
  const pctMatch = /^P(\d+(?:\.\d+)?)$/.exec(comm);
  if (pctMatch) {
    commission = parseFloat(pctMatch[1]);
    commissionPercent = true;
  } else if (/^\d+(?:\.\d+)?$/.test(comm)) {
    commission = parseFloat(comm);
  } else {
    throw new ParseError(`Accounting: bad commission "${comm}" in "${raw}"`);
  }

  if (!/^\d+(?:\.\d+)?$/.test(base)) throw new ParseError(`Accounting: bad base fare "${base}" in "${raw}"`);
  if (!/^\d+(?:\.\d+)?$/.test(taxes)) throw new ParseError(`Accounting: bad taxes "${taxes}" in "${raw}"`);
  if (!['ONE', 'PER', 'ALL'].includes(fareApp.toUpperCase())) {
    throw new ParseError(`Accounting: bad fare application "${fareApp}" in "${raw}"`);
  }
  if (!/^\d+$/.test(docs)) throw new ParseError(`Accounting: bad doc count "${docs}" in "${raw}"`);
  if (!['D', 'F', 'T'].includes(tariff.toUpperCase())) {
    throw new ParseError(`Accounting: bad tariff "${tariff}" in "${raw}"`);
  }

  return {
    kind: 'accounting_add',
    raw,
    timestamp: new Date(),
    line: {
      validatingCarrier: carrier.toUpperCase(),
      ticketNumber: ticket,
      commission,
      commissionPercent,
      baseFare: parseFloat(base),
      taxes: parseFloat(taxes),
      fareApplication: fareApp.toUpperCase() as 'ONE' | 'PER' | 'ALL',
      formOfPayment: fop,
      conjunctDocs: parseInt(docs, 10),
      tariff: tariff.toUpperCase() as 'D' | 'F' | 'T',
      freeText,
    },
  };
}
